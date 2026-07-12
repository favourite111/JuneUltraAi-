/**══════════════════════════════════════════════════════════════╗
 * ║  FILE    : chatbot.js                                        ║
 * ║  FEATURE : AI Chatbot — Groups + DMs                         ║
 * ║  API     : JUNE_ULTRA_AI backend (your own Render deploy)    ║
 * ║  CMDS    : .chatbot on/off | gc on/off | pm on/off           ║
 * ║           | mention on/off | status | clear                  ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Storage keys (bot-level settings, never a separate global flag):
 *   groupChatbot      → true/false
 *   privateChatbot    → true/false
 *   groupMentionOnly  → true/false  (only reply when @tagged in groups)
 *
 * Global status is always calculated:
 *   Global = groupChatbot === true && privateChatbot === true
 */

const axios    = require('axios');
const database = require(require('path').join(global.__CORE__, 'database'));
const config   = require(require('path').join(global.__ROOT__, 'config'));

// ── Version ──────────────────────────────────────────────────────────────────
const CHATBOT_VERSION = '2.1.0';

// ── API config ────────────────────────────────────────────────────────────────
const JUNE_API_URL = config.JUNE_API_URL || process.env.JUNE_API_URL;
const JUNE_BOT_ID  = config.JUNE_BOT_ID  || process.env.JUNE_BOT_ID;
const JUNE_API_KEY = config.JUNE_API_KEY || process.env.JUNE_API_KEY || 'jx_live_nQ_cR71Esm9FrGixn19I9Ae0Y8cVdBEjHMzU1-_PEWE';

// ── In-memory state ───────────────────────────────────────────────────────────
const lastRequest = new Map(); // senderJid → lastRequestMs
const RATE_MS     = 4000;      // 4 s between requests per user
const RETRY_DELAY = 2500;      // ms to wait before one retry on network error

// ── Settings helpers ──────────────────────────────────────────────────────────

function getGroupChatbot()     { return database.getBotSetting('groupChatbot')     ?? false; }
function getPrivateChatbot()   { return database.getBotSetting('privateChatbot')   ?? false; }
function getGroupMentionOnly() { return database.getBotSetting('groupMentionOnly') ?? false; }
function getGlobal()           { return getGroupChatbot() && getPrivateChatbot(); }

function icon(val) { return val ? '✅ ON' : '❌ OFF'; }

// ── Sleep helper ──────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── API client ────────────────────────────────────────────────────────────────

/**
 * Calls the JUNE_ULTRA_AI backend and returns the full response envelope:
 *   { success, handledBy, reply, type?, tool?, data? }
 *
 * Retries once after RETRY_DELAY ms on network/5xx errors.
 * Never retries 401 (bad key) or 429 (rate limited).
 */
async function callAI(prompt, userId, groupId, attempt = 0) {
    try {
        const { data } = await axios.post(
            `${JUNE_API_URL}/v1/chat`,
            { prompt, userId, groupId },
            {
                timeout: 25000,
                headers: {
                    'Authorization': `Bearer ${JUNE_API_KEY}`,
                    'X-Bot-Id':      JUNE_BOT_ID,
                    'X-Client-Ver':  CHATBOT_VERSION,
                    'Content-Type':  'application/json',
                    'User-Agent':    'JuneXUltra/2.0',
                },
            }
        );

        if (data?.success && data?.reply) return data;
        throw new Error(data?.error || 'Invalid AI response');

    } catch (e) {
        const status      = e.response?.status;
        const serverError = e.response?.data?.error;

        if (status === 401) {
            console.error('[CHATBOT] Auth rejected — check JUNE_API_KEY / JUNE_BOT_ID.');
            throw e;
        }
        if (status === 429) {
            console.error('[CHATBOT] Rate limited:', serverError);
            throw e;
        }

        // Network error or 5xx — retry once
        if (attempt === 0) {
            console.warn(`[CHATBOT] Request failed (${e.message}), retrying in ${RETRY_DELAY}ms…`);
            await sleep(RETRY_DELAY);
            return callAI(prompt, userId, groupId, 1);
        }

        console.error('[CHATBOT] AI Error (gave up):', serverError || e.message);
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
                'X-Bot-Id':     JUNE_BOT_ID,
                'Content-Type': 'application/json',
            },
        });
    } catch (e) {
        console.error('[CHATBOT] Failed to clear remote history:', e.response?.data?.error || e.message);
    }
}

// ── Response handler ──────────────────────────────────────────────────────────

/**
 * Dispatches the API response to the correct WhatsApp send method.
 *
 * Supported types from server:
 *   text     → plain text
 *   image    → QR code, screenshot
 *   document → PDF
 *   audio    → TTS
 *   video    → future video clips
 *   sticker  → future sticker replies
 *
 * Falls back to plain text if media send fails.
 */
async function handleAIResponse(sock, from, msg, response) {
    const { type = 'text', reply, data = {} } = response;
    const quoted = { quoted: msg };

    function resolveMedia() {
        if (data.buffer) return Buffer.from(String(data.buffer), 'base64');
        if (data.url)    return { url: String(data.url) };
        return null;
    }

    async function sendTextFallback() {
        await sock.sendMessage(from, { text: reply }, quoted);
    }

    async function trySend(payload) {
        try {
            await sock.sendMessage(from, payload, quoted);
        } catch (err) {
            console.error(`[CHATBOT] Failed to send ${type}, falling back to text:`, err.message);
            await sendTextFallback();
        }
    }

    if (type === 'image') {
        const media = resolveMedia();
        if (!media) { console.warn('[CHATBOT] image: no buffer/url'); return sendTextFallback(); }
        return trySend({ image: media, caption: reply });
    }

    if (type === 'document') {
        const media = resolveMedia();
        if (!media) { console.warn('[CHATBOT] document: no buffer/url'); return sendTextFallback(); }
        return trySend({
            document: media,
            mimetype: String(data.mimeType || 'application/octet-stream'),
            fileName: String(data.filename || data.fileName || 'file'),
            caption:  reply,
        });
    }

    if (type === 'audio') {
        const media = resolveMedia();
        if (!media) { console.warn('[CHATBOT] audio: no buffer/url'); return sendTextFallback(); }
        return trySend({
            audio:    media,
            mimetype: String(data.mimeType || 'audio/mpeg'),
            ptt:      false,
        });
    }

    if (type === 'video') {
        const media = resolveMedia();
        if (!media) { console.warn('[CHATBOT] video: no buffer/url'); return sendTextFallback(); }
        return trySend({
            video:    media,
            mimetype: String(data.mimeType || 'video/mp4'),
            caption:  reply,
        });
    }

    if (type === 'sticker') {
        const media = resolveMedia();
        if (!media) { console.warn('[CHATBOT] sticker: no buffer/url'); return sendTextFallback(); }
        return trySend({ sticker: media });
    }

    // text or any unrecognised future type → plain text
    await sendTextFallback();
}

// ── Text extractor ────────────────────────────────────────────────────────────

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

// ── Bot mention check ─────────────────────────────────────────────────────────

function mentionsBot(msg, sock) {
    const botNum = (sock?.user?.id || '').split(':')[0].split('@')[0];
    if (!botNum) return false;
    const ctx = msg?.message?.extendedTextMessage?.contextInfo;
    if (ctx?.mentionedJid?.some(j => j.includes(botNum))) return true;
    return extractText(msg).includes(`@${botNum}`);
}

// ── Auto-reply ────────────────────────────────────────────────────────────────

async function handleAutoReply(sock, msg, extra) {
    try {
        const { from, isGroup } = extra;
        if (msg.key.fromMe) return;

        const sender = msg.key.participant || msg.key.remoteJid || from;
        const now    = Date.now();
        if (lastRequest.has(sender) && now - lastRequest.get(sender) < RATE_MS) return;

        if (isGroup) {
            if (!getGroupChatbot()) return;
            // Mention-only mode — skip if bot isn't @tagged
            if (getGroupMentionOnly() && !mentionsBot(msg, sock)) return;
        } else {
            if (!getPrivateChatbot()) return;
        }

        let text = extractText(msg);
        if (!text) return;

        const botNum = (sock?.user?.id || '').split(':')[0].split('@')[0];
        if (botNum) text = text.replace(new RegExp(`@${botNum}\\s*`, 'g'), '').trim();
        if (!text) return;

        lastRequest.set(sender, now);

        try { await sock.sendPresenceUpdate('composing', from); } catch (_) {}

        const userId  = sender;
        const groupId = isGroup ? from : undefined;

        const response = await callAI(text, userId, groupId);
        await handleAIResponse(sock, from, msg, response);

    } catch (e) {
        console.error('[CHATBOT] handleAutoReply error:', e.message);
    }
}

// ── Status builder ────────────────────────────────────────────────────────────

function buildStatus() {
    const grp     = getGroupChatbot();
    const pm      = getPrivateChatbot();
    const mention = getGroupMentionOnly();
    const glb     = grp && pm;

    return (
        `🤖 *Chatbot Settings* v${CHATBOT_VERSION}\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🌐 Global      : *${icon(glb)}*\n` +
        `👥 Groups      : *${icon(grp)}*\n` +
        `💬 Private     : *${icon(pm)}*\n` +
        `🏷️ Mention only: *${icon(mention)}*\n\n` +
        `*Available Commands*\n` +
        `• .chatbot on/off         — enable/disable everywhere\n` +
        `• .chatbot gc on/off      — groups only\n` +
        `• .chatbot pm on/off      — private only\n` +
        `• .chatbot mention on/off — groups: reply only when @tagged\n` +
        `• .chatbot clear          — clear chat history`
    );
}

// ── Command ───────────────────────────────────────────────────────────────────

module.exports = {
    name:        'chatbot',
    aliases:     ['cb', 'ai', 'bot'],
    category:    'admin',
    description: 'AI chatbot via JUNE_ULTRA_AI backend — auto-replies in groups and DMs',
    usage:       '.chatbot on | off | gc on/off | pm on/off | mention on/off | status | clear',

    async execute(sock, msg, args, extra) {
        const { from, isGroup, isOwner, isAdmin, reply, react } = extra;
        const sub = (args[0] || '').toLowerCase();
        const opt = (args[1] || '').toLowerCase();

        if (!sub || sub === 'status') {
            return reply(buildStatus());
        }

        if (sub === 'on') {
            if (!isOwner && !isAdmin) return reply('❌ Only admins can change chatbot settings.');
            database.setBotSetting('groupChatbot',   true);
            database.setBotSetting('privateChatbot', true);
            await react('✅');
            return reply(`🤖 *Chatbot ON* ✅\nBot will now auto-reply in both Groups and Private Chats.\n\n${buildStatus()}`);
        }

        if (sub === 'off') {
            if (!isOwner && !isAdmin) return reply('❌ Only admins can change chatbot settings.');
            database.setBotSetting('groupChatbot',   false);
            database.setBotSetting('privateChatbot', false);
            await react('❌');
            return reply(`🤖 *Chatbot OFF* ❌\nBot will no longer auto-reply anywhere.\n\n${buildStatus()}`);
        }

        if (sub === 'gc') {
            if (!isOwner && !isAdmin) return reply('❌ Only admins can change chatbot settings.');
            if (opt !== 'on' && opt !== 'off') {
                return reply(`❓ *Usage:*\n  .chatbot gc on  — enable in groups\n  .chatbot gc off — disable in groups`);
            }
            const enable = opt === 'on';
            database.setBotSetting('groupChatbot', enable);
            await react(enable ? '✅' : '❌');
            return reply(`👥 *Group Chatbot ${enable ? 'ON ✅' : 'OFF ❌'}*\n\n${buildStatus()}`);
        }

        if (sub === 'pm' || sub === 'chat' || sub === 'dm') {
            if (!isOwner) return reply('❌ Only the bot owner can change private chat settings.');
            if (opt !== 'on' && opt !== 'off') {
                return reply(`❓ *Usage:*\n  .chatbot pm on  — enable in private\n  .chatbot pm off — disable in private`);
            }
            const enable = opt === 'on';
            database.setBotSetting('privateChatbot', enable);
            await react(enable ? '✅' : '❌');
            return reply(`💬 *Private Chatbot ${enable ? 'ON ✅' : 'OFF ❌'}*\n\n${buildStatus()}`);
        }

        if (sub === 'mention') {
            if (!isOwner && !isAdmin) return reply('❌ Only admins can change chatbot settings.');
            if (opt !== 'on' && opt !== 'off') {
                return reply(`❓ *Usage:*\n  .chatbot mention on  — reply only when @tagged in groups\n  .chatbot mention off — reply to all messages in groups`);
            }
            const enable = opt === 'on';
            database.setBotSetting('groupMentionOnly', enable);
            await react(enable ? '✅' : '❌');
            return reply(`🏷️ *Mention-only ${enable ? 'ON ✅' : 'OFF ❌'}*\n${enable ? 'Bot will only reply in groups when @tagged.' : 'Bot will reply to all group messages.'}\n\n${buildStatus()}`);
        }

        if (sub === 'clear' || sub === 'reset') {
            const sender  = msg.key.participant || msg.key.remoteJid || from;
            const groupId = isGroup ? from : undefined;
            await clearRemoteHistory(sender, groupId);
            await react('🗑️');
            return reply('🗑️ *Conversation history cleared.*\nThe bot will start fresh in this chat.');
        }

        return reply(
            `❓ Unknown option: *${sub}*\n\nUsage:\n` +
            `  .chatbot on/off\n  .chatbot gc on/off\n  .chatbot pm on/off\n` +
            `  .chatbot mention on/off\n  .chatbot status\n  .chatbot clear`
        );
    },

    handleAutoReply,
};