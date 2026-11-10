const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const OpenAI = require('openai'); 
const express = require('express'); // For Render keep-alive

// ==========================================
// CONFIGURATION
// ==========================================
const OPENROUTER_API_KEY = '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'; 
const OWNER_JID = process.env.OWNER_JID || '256780323452@s.whatsapp.net'; 

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_API_KEY,
});

const conversationHistory = new Map();
const pausedChats = new Set(); 
const replyAllGroups = new Set(); // Tracks groups where bot replies to everything

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('\n✅ Bot is online and replying in REAL-TIME!\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const message = messages[0];
        if (!message.message) return;

        const chatId = message.key.remoteJid;
        const senderJid = message.key.participant || chatId;
        const isGroup = chatId.endsWith('@g.us');
        
        // 1. ROBUST TEXT EXTRACTION
        let text = '';
        if (message.message.conversation) {
            text = message.message.conversation;
        } else if (message.message.extendedTextMessage) {
            text = message.message.extendedTextMessage.text;
        } else if (message.message.imageMessage?.caption) {
            text = message.message.imageMessage.caption;
        } else if (message.message.videoMessage?.caption) {
            text = message.message.videoMessage.caption;
        }

        if (!text) return;
        const cleanText = text.trim().toLowerCase();

        // 2. THE "FROM ME" FIX (Allows commands, blocks loops)
        if (message.key.fromMe) {
            const allowedCommands = ['/pause', '/resume', '/clear', '/replyall', '/replymention'];
            if (!allowedCommands.includes(cleanText)) {
                return; 
            }
        }

        // BULLETPROOF OWNER CHECK
        const senderNumber = senderJid.split('@')[0].split(':')[0]; 
        const ownerNumber = OWNER_JID.split('@')[0].split(':')[0];  
        const isOwner = senderNumber === ownerNumber;

        // 3. OWNER COMMANDS
        if (isOwner || message.key.fromMe) {
            if (cleanText === '/pause') {
                pausedChats.add(chatId);
                await sock.sendMessage(chatId, { text: "✅ Bot paused. I will stay silent until you type /resume." });
                return;
            }
            if (cleanText === '/resume') {
                pausedChats.delete(chatId);
                await sock.sendMessage(chatId, { text: "✅ Bot resumed. I am back online!" });
                return;
            }
            if (cleanText === '/clear') {
                conversationHistory.delete(chatId);
                await sock.sendMessage(chatId, { text: "🧠 Memory cleared. Let's start fresh!" });
                return;
            }
            if (cleanText === '/replyall') {
                if (isGroup) {
                    replyAllGroups.add(chatId);
                    await sock.sendMessage(chatId, { text: "✅ I will now reply to every message in this group." });
                } else {
                    await sock.sendMessage(chatId, { text: "This command only works in groups." });
                }
                return;
            }
            if (cleanText === '/replymention') {
                replyAllGroups.delete(chatId);
                await sock.sendMessage(chatId, { text: "✅ Reverted. I will only reply when mentioned in this group." });
                return;
            }
        }

        if (pausedChats.has(chatId)) return;

        // 4. THE SMART FILTER (Groups vs Inbox)
        if (isGroup && !replyAllGroups.has(chatId)) {
            const mentionedJid = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net'; 
            const isNativeMention = mentionedJid.includes(botJid);
            const isTextMention = text.toLowerCase().includes('@technology developer');

            if (!isNativeMention && !isTextMention) {
                return; 
            }
        }

        try {
            console.log(`📩 Received: "${text}" in ${isGroup ? 'Group' : 'Inbox'}`);

            if (!conversationHistory.has(chatId)) {
                conversationHistory.set(chatId, []);
            }
            const history = conversationHistory.get(chatId);

            history.push({ role: 'user', content: text });

            if (history.length > 5) {
                history.shift();
            }

            // 5. ULTRA-FAST AI CALL (UPDATED MODEL)
            const chatCompletion = await openai.chat.completions.create({
                model: "meta-llama/llama-3.1-8b-instruct", // <-- FIXED: Switched back to the stable free model
                messages: [
                    { 
                        role: 'system', 
                        content: `You are "Technology Developer", a confident human tech expert. 
Rules: 1. BE HUMAN: Never say "As an AI". Answer naturally. 
2. BE DECISIVE: Give direct answers first. 
3. TECH SKILLS: Format code in \`\`\` blocks. Use simple analogies for jargon. 
4. BE CONFIDENT & POLITE: Defend answers logically. Decline money/inappropriate requests smoothly. 
Keep replies short (1-3 sentences max).` 
                    },
                    ...history
                ],
                temperature: 0.7,
                max_tokens: 150, 
            });

            const response = chatCompletion.choices[0]?.message?.content || "Sorry, I couldn't think of a reply!";

            history.push({ role: 'assistant', content: response });

            await sock.sendMessage(chatId, { text: response });
            console.log(`🤖 Replied: "${response}"`);

        } catch (err) {
            console.error('⚠️ Error generating AI response:', err.message);
        }
    });
}

startBot();

// ==========================================
// KEEP-ALIVE SERVER FOR RENDER
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running 24/7! 🤖'));
app.listen(PORT, () => console.log(`🌐 Keep-alive server running on port ${PORT}`));