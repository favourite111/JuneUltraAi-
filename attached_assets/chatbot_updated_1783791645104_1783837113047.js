/**══════════════════════════════════════════════════════════════╗
 * ║  FILE    : chatbot.js                                        ║
 * ║  FEATURE : AI Chatbot — Groups + DMs                         ║
 * ║  API     : JUNE_ULTRA_AI backend (your own Render deploy)    ║
 * ║  CMDS    : .chatbot on/off | gc on/off | pm on/off           ║
 * ║           | status | clear                                   ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Storage keys (bot-level settings, never a separate global flag):
 *   groupChatbot   → true/false
 *   privateChatbot → true/false
 *
 * Global status is always calculated:
 *   Global = groupChatbot === true && privateChatbot === true
 *
 * ── Backend ───────────────────────────────────────────────────
 * This bot no longer calls Pollinations/shizo.top directly, and no
 * longer keeps its own in-memory conversation history. Both the AI
 * call and the conversation memory now live behind your own
 * JUNE_ULTRA_AI API server (Neon-backed, rate-limited, multi-bot).
 *
 * You must register this bot once against the API before it will
 * work — see the setup note below JUNE_API_KEY.
 */

const axios    = require('axios');
const database = require(require('path').join(global.__CORE__, 'database'));
const config   = require(require('path').join(global.__ROOT__, 'config'));

// ── API config ──────────────────────────────────────────────────────────────
// Prefer values from config/env so the key never needs to be hardcoded and
// committed; fall back to the literals below only if you truly want to
// hardcode them for a quick test.
const JUNE_API_URL = config.JUNE_API_URL || process.env.JUNE_API_URL || 'https://juneultraai.onrender.com';
const JUNE_BOT_ID  = config.JUNE_BOT_ID  || process.env.JUNE_BOT_ID  || 'june-ultra-main';
const JUNE_API_KEY = config.JUNE_API_KEY || process.env.JUNE_API_KEY || 'jx_live_nQ_cR71Esm9FrGixn19I9Ae0Y8cVdBEjHMzU1-_PEWE';

// ── In-memory state ────────────────────────────────────────────────────────────
// Only the client-side rate limiter stays local. Conversation history is now
// stored server-side, keyed by botId+userId(+groupId).
const lastRequest = new Map(); // senderJid → lastRequestMs
const RATE_MS     = 4000;      // 4 seconds between requests per user

// ── Settings helpers ───────────────────────────────────────────────────────────

function getGroupChatbot()   { return database.getBotSetting('groupChatbot')   ?? false; }
function getPrivateChatbot() { return database.getBotSetting('privateChatbot') ?? false; }
function getGlobal()         { return getGroupChatbot() && getPrivateChatbot(); }

function icon(val) { return val ? '✅ ON' : '❌ OFF'; }

// ── API client ─────────────────────────────────────────────────────────────────

/**
 * Calls the JUNE_ULTRA_AI backend and returns the full response object.
 *
 * The server now returns a structured envelope:
 *   { success, handledBy, reply, type?, tool?, data? }
 *
 * - handledBy "ai"   → normal text conversation
 * - handledBy "tool" → tool result; `type` tells us how to deliver it
 *
 * We return the whole object so the caller can inspect `type` and `data`
 * and send the right WhatsApp message format.
 */
async function callAI(prompt, userId, groupId) {
    try {
        const { data } = await axios.post(
            `${JUNE_API_URL}/v1/chat`,
            { prompt, userId, groupId },
            {
                timeout: 25000,
                headers: {
                    'Authorization': `Bearer ${JUNE_API_KEY}`,
                    'X-Bot-Id': JUNE_BOT_ID,
                    'Content-Type': 'application/json',
                    'User-Agent': 'JuneXUltra/2.0',
                },
            }
        );

        if (data?.success && data?.reply) {
            return data; // ← return full envelope, not just data.reply
        }

        throw new Error(data?.error || 'Invalid AI response');

    } catch (e) {
        const status = e.response?.status;
        const serverError = e.response?.data?.error;

        if (status === 401) {
            console.error('[CHATBOT] Auth rejected by API — check JUNE_API_KEY / JUNE_BOT_ID.');
        } else if (status === 429) {
            console.error('[CHATBOT] Rate limited by API:', serverError);
        } else {
            console.error('[CHATBOT] AI Error:', serverError || e.message);
        }
        throw e;
    }
}

/** Tells the server to forget this conversation's history. */
async function clearRemoteHistory(userId, groupId) {
    try {
        await axios.delete(`${JUNE_API_URL}/v1/chat`, {
            data: { userId, groupId },
            timeout: 15000,
            headers: {
                'Authorization': `Bearer ${JUNE_API_KEY}`,
                'X-Bot-Id': JUNE_BOT_ID,
                'Content-Type': 'application/json',
            },
        });
    } catch (e) {
        console.error('[CHATBOT] Failed to clear remote history:', e.response?.data?.error || e.message);
    }
}

// ── Response handler ───────────────────────────────────────────────────────────

/**
 * Dispatches the API response to the correct WhatsApp send method.
 *
 * The server always includes `reply` (safe text fallback) and optionally
 * `type` + `data` for media. Supported types:
 *
 *   text     → plain text message (AI replies, tool confirmations)
 *   image    → QR code, screenshot — data.buffer (base64) or data.url
 *   document → PDF — data.buffer (base64) or data.url
 *   audio    → future TTS — data.buffer (base64) or data.url
 *
 * If the media send fails for any reason the function falls back to
 * sending response.reply as plain text so the user always gets something.
 */
async function handleAIResponse(sock, from, msg, response) {
    const { type = 'text', reply, data = {} } = response;
    const quoted = { quoted: msg };

    // ── helpers ──────────────────────────────────────────────────────────────

    /** Resolve media payload: prefers Buffer (base64) over URL. */
    function resolveMedia() {
        if (data.buffer) {
            return Buffer.from(String(data.buffer), 'base64');
        }
        if (data.url) {
            return { url: String(data.url) };
        }
        return null;
    }

    /** Last-resort fallback — always succeeds. */
    async function sendTextFallback() {
        await sock.sendMessage(from, { text: reply }, quoted);
    }

    // ── dispatch ─────────────────────────────────────────────────────────────

    if (type === 'image') {
        const media = resolveMedia();
        if (!media) {
            console.warn('[CHATBOT] image response has no buffer or url — falling back to text');
            return sendTextFallback();
        }
        try {
            await sock.sendMessage(from, {
                image: media,
                caption: reply,
            }, quoted);
        } catch (err) {
            console.error('[CHATBOT] Failed to send image, falling back to text:', err.message);
            await sendTextFallback();
        }
        return;
    }

    if (type === 'document') {
        const media = resolveMedia();
        if (!media) {
            console.warn('[CHATBOT] document response has no buffer or url — falling back to text');
            return sendTextFallback();
        }
        try {
            await sock.sendMessage(from, {
                document: media,
                mimetype: String(data.mimeType || 'application/octet-stream'),
                fileName: String(data.filename || data.fileName || 'file'),
                caption: reply,
            }, quoted);
        } catch (err) {
            console.error('[CHATBOT] Failed to send document, falling back to text:', err.message);
            await sendTextFallback();
        }
        return;
    }

    if (type === 'audio') {
        const media = resolveMedia();
        if (!media) {
            console.warn('[CHATBOT] audio response has no buffer or url — falling back to text');
            return sendTextFallback();
        }
        try {
            await sock.sendMessage(from, {
                audio: media,
                mimetype: String(data.mimeType || 'audio/mpeg'),
                ptt: false,
            }, quoted);
        } catch (err) {
            console.error('[CHATBOT] Failed to send audio, falling back to text:', err.message);
            await sendTextFallback();
        }
        return;
    }

    // type === 'text' or any unrecognised future type → plain text
    await sendTextFallback();
}

// ── Text extractor ─────────────────────────────────────────────────────────────

function extractText(msg) {
    const m = msg?.message;
    if (!m) return '';
    const inner =
        m.ephemeralMessage?.message ||
        m.viewOnceMessageV2?.message ||
        m;

    let text = (
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        inner.imageMessage?.caption ||
        inner.videoMessage?.caption ||
        inner.documentMessage?.caption ||
        inner.buttonsResponseMessage?.selectedDisplayText ||
        ''
    ).trim();

    // When the user quotes/replies to a message, also extract the quoted
    // message's text and append it. This allows tools to work on quoted
    // content — e.g. quoting a long URL and saying "shorten this", or
    // quoting some text and saying "qr code for this" / "convert to pdf".
    const ctx = inner.extendedTextMessage?.contextInfo;
    if (ctx?.quotedMessage) {
        const q = ctx.quotedMessage;
        const quotedText = (
            q.conversation ||
            q.extendedTextMessage?.text ||
            q.imageMessage?.caption ||
            q.videoMessage?.caption ||
            q.documentMessage?.caption ||
            ''
        ).trim();
        if (quotedText) {
            text = text ? `${text} ${quotedText}` : quotedText;
        }
    }

    return text;
}

// ── Bot mention check ──────────────────────────────────────────────────────────

function mentionsBot(msg, sock) {
    const botNum = (sock?.user?.id || '').split(':')[0].split('@')[0];
    if (!botNum) return false;
    const ctx = msg?.message?.extendedTextMessage?.contextInfo;
    if (ctx?.mentionedJid?.some(j => j.includes(botNum))) return true;
    return extractText(msg).includes(`@${botNum}`);
}

// ── Auto-reply — called by handler.js on every non-command message ─────────────

async function handleAutoReply(sock, msg, extra) {
    try {
        const { from, isGroup } = extra;
        if (msg.key.fromMe) return;

        const sender = msg.key.participant || msg.key.remoteJid || from;
        const now    = Date.now();
        if (lastRequest.has(sender) && now - lastRequest.get(sender) < RATE_MS) return;

        // Check if chatbot is active for this context
        let shouldReply = false;

        if (isGroup) {
            if (!getGroupChatbot()) return; // global group toggle
            shouldReply = true;
        } else {
            if (getPrivateChatbot()) shouldReply = true;
        }

        if (!shouldReply) return;

        let text = extractText(msg);
        if (!text) return;

        // Strip @botNumber from text
        const botNum = (sock?.user?.id || '').split(':')[0].split('@')[0];
        if (botNum) text = text.replace(new RegExp(`@${botNum}\\s*`, 'g'), '').trim();
        if (!text) return;

        lastRequest.set(sender, now);

        try { await sock.sendPresenceUpdate('composing', from); } catch (_) {}

        // userId = the person talking; groupId = the group jid (undefined in DMs)
        const userId  = sender;
        const groupId = isGroup ? from : undefined;

        const response = await callAI(text, userId, groupId);

        await handleAIResponse(sock, from, msg, response);

    } catch (e) {
        console.error('[CHATBOT] handleAutoReply error:', e.message);
    }
}

// ── Status builder ─────────────────────────────────────────────────────────────

function buildStatus() {
    const grp = getGroupChatbot();
    const pm  = getPrivateChatbot();
    const glb = grp && pm;

    return (
        `🤖 *Chatbot Settings*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🌐 Global : *${icon(glb)}*\n` +
        `👥 Groups : *${icon(grp)}*\n` +
        `💬 Private: *${icon(pm)}*\n\n` +
        `*Available Commands*\n` +
        `• .chatbot on       — enable everywhere\n` +
        `• .chatbot off      — disable everywhere\n` +
        `• .chatbot gc on/off — groups only\n` +
        `• .chatbot pm on/off — private only\n` +
        `• .chatbot clear    — clear chat history`
    );
}

// ── Command ───────────────────────────────────────────────────────────────────

module.exports = {
    name:        'chatbot',
    aliases:     ['cb', 'ai', 'bot'],
    category:    'admin',
    description: 'AI chatbot via JUNE_ULTRA_AI backend — auto-replies in groups and DMs',
    usage:       '.chatbot on | off | gc on/off | pm on/off | status | clear',

    async execute(sock, msg, args, extra) {
        const { from, isGroup, isOwner, isAdmin, reply, react } = extra;
        const sub  = (args[0] || '').toLowerCase();
        const opt  = (args[1] || '').toLowerCase();

        // ── STATUS ────────────────────────────────────────────────────────────
        if (!sub || sub === 'status') {
            return reply(buildStatus());
        }

        // ── GLOBAL ON — both groups + private ────────────────────────────────
        if (sub === 'on') {
            if (!isOwner && !isAdmin) return reply('❌ Only admins can change chatbot settings.');
            database.setBotSetting('groupChatbot',   true);
            database.setBotSetting('privateChatbot', true);
            await react('✅');
            return reply(
                `🤖 *Chatbot ON* ✅\n` +
                `Bot will now auto-reply in both Groups and Private Chats.\n\n` +
                buildStatus()
            );
        }

        // ── GLOBAL OFF — both groups + private ───────────────────────────────
        if (sub === 'off') {
            if (!isOwner && !isAdmin) return reply('❌ Only admins can change chatbot settings.');
            database.setBotSetting('groupChatbot',   false);
            database.setBotSetting('privateChatbot', false);
            await react('❌');
            return reply(
                `🤖 *Chatbot OFF* ❌\n` +
                `Bot will no longer auto-reply anywhere.\n\n` +
                buildStatus()
            );
        }

        // ── GC — groups only ──────────────────────────────────────────────────
        if (sub === 'gc') {
            if (!isOwner && !isAdmin) return reply('❌ Only admins can change chatbot settings.');
            if (opt !== 'on' && opt !== 'off') {
                return reply(
                    `❓ *Usage:*\n` +
                    `  .chatbot gc on  — enable chatbot in groups\n` +
                    `  .chatbot gc off — disable chatbot in groups`
                );
            }
            const enable = opt === 'on';
            database.setBotSetting('groupChatbot', enable);
            await react(enable ? '✅' : '❌');
            return reply(
                `👥 *Group Chatbot ${enable ? 'ON ✅' : 'OFF ❌'}*\n` +
                `Bot will ${enable ? 'now' : 'no longer'} auto-reply in groups.\n\n` +
                buildStatus()
            );
        }

        // ── PM — private chats only ───────────────────────────────────────────
        if (sub === 'pm' || sub === 'chat' || sub === 'dm') {
            if (!isOwner) return reply('❌ Only the bot owner can change private chat settings.');
            if (opt !== 'on' && opt !== 'off') {
                return reply(
                    `❓ *Usage:*\n` +
                    `  .chatbot pm on  — enable chatbot in private chats\n` +
                    `  .chatbot pm off — disable chatbot in private chats`
                );
            }
            const enable = opt === 'on';
            database.setBotSetting('privateChatbot', enable);
            await react(enable ? '✅' : '❌');
            return reply(
                `💬 *Private Chatbot ${enable ? 'ON ✅' : 'OFF ❌'}*\n` +
                `Bot will ${enable ? 'now' : 'no longer'} auto-reply in private chats.\n\n` +
                buildStatus()
            );
        }

        // ── CLEAR ─────────────────────────────────────────────────────────────
        if (sub === 'clear' || sub === 'reset') {
            const sender  = msg.key.participant || msg.key.remoteJid || from;
            const userId  = sender;
            const groupId = isGroup ? from : undefined;

            await clearRemoteHistory(userId, groupId);
            await react('🗑️');
            return reply('🗑️ *Conversation history cleared.*\nThe bot will start fresh in this chat.');
        }

        // ── UNKNOWN ───────────────────────────────────────────────────────────
        return reply(
            `❓ Unknown option: *${sub}*\n\n` +
            `Usage:\n` +
            `  .chatbot on/off\n` +
            `  .chatbot gc on/off\n` +
            `  .chatbot pm on/off\n` +
            `  .chatbot status\n` +
            `  .chatbot clear`
        );
    },

    handleAutoReply,
};
