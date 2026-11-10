const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const OpenAI = require('openai'); 

// ==========================================
// CONFIGURATION
// ==========================================
const OPENROUTER_API_KEY = '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'; 

// ⚠️ PUT YOUR REAL NUMBER HERE (No + sign, no spaces) ⚠️
const OWNER_JID = '256780323452@s.whatsapp.net'; 

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_API_KEY,
});

const conversationHistory = new Map();
const pausedChats = new Set(); 

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
        
        // ==========================================
        // 1. ROBUST TEXT EXTRACTION (Moved to the top)
        // ==========================================
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

        // ==========================================
        // 2. THE "FROM ME" FIX (Allows commands, blocks loops)
        // ==========================================
        // If the message is from your own account, ONLY process it if it's a command.
        // This prevents the bot from replying to itself, but lets you use /pause.
        if (message.key.fromMe) {
            if (cleanText !== '/pause' && cleanText !== '/resume' && cleanText !== '/clear') {
                return; 
            }
        }

        // BULLETPROOF OWNER CHECK
        const senderNumber = senderJid.split('@')[0].split(':')[0]; 
        const ownerNumber = OWNER_JID.split('@')[0].split(':')[0];  
        const isOwner = senderNumber === ownerNumber;

        // ==========================================
        // 3. OWNER COMMANDS
        // ==========================================
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
        }

        if (pausedChats.has(chatId)) return;

        // ==========================================
        // 4. THE SMART FILTER (Groups vs Inbox)
        // ==========================================
        if (isGroup) {
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

            if (history.length > 8) {
                history.shift();
            }

            const chatCompletion = await openai.chat.completions.create({
                model: "meta-llama/llama-3.1-8b-instruct", 
                messages: [
                    { 
                        role: 'system', 
                        content: `You are "Technology Developer", a highly capable, confident, and natural-sounding human tech expert. 
                        Your core rules are:
                        1. BE HUMAN: Never say "As an AI..." or "I am a bot". Answer casual questions naturally.
                        2. BE DECISIVE: Give clear, definitive answers FIRST, then briefly explain.
                        3. TECH SKILLS - CODE: When asked for code, ALWAYS format it perfectly using WhatsApp markdown code blocks (e.g., \`\`\`javascript [code] \`\`\`).
                        4. TECH SKILLS - JARGON: Use simple, real-world analogies for complex tech concepts.
                        5. BE CONFIDENT: Defend your answer logically and politely.
                        6. BE POLITE BUT FIRM: Decline requests for money or inappropriate favors smoothly.
                        Act exactly like a smart, reliable, and friendly human expert.` 
                    },
                    ...history
                ],
                temperature: 0.75,
                max_tokens: 300,
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