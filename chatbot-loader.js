'use strict';

const path   = require('path');
const https  = require('https');
const http   = require('http');
const vm     = require('vm');

const config = (() => {
    try { return require(path.join(global.__ROOT__, 'config')); }
    catch (_) { return {}; }
})();

// ─── Server config ────────────────────────────────────────────────────────────
const SERVER_BASE = config.JUNE_SERVER_URL  || process.env.JUNE_SERVER_URL  || 'https://your-app.koyeb.app';
const API_KEY     = config.JUNE_BOT_API_KEY || process.env.JUNE_BOT_API_KEY || '';

// Auto-detect protocol so http://localhost works during local testing
const _proto = SERVER_BASE.startsWith('http://') ? http : https;

// ─── State ────────────────────────────────────────────────────────────────────
let _cachedModule = null;
let _cachedHash   = null;
let _loading      = null;

// ─── Fetch latest code from YOUR server (not GitHub) ─────────────────────────
// Pure Node https — no fetch(), works on Node 14+
function fetchFromServer() {
    return new Promise((resolve, reject) => {
        const url = `${SERVER_BASE}/code/chatbot.js?apikey=${API_KEY}`;
        const req = _proto.get(url, { timeout: 15000 }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Server returned ${res.statusCode}`));
            }
            const hash = res.headers['x-hash'] || null;
            let code = '';
            res.setEncoding('utf8');
            res.on('data', c => { code += c; });
            res.on('end',  () => resolve({ code, hash }));
        });
        req.on('error',   reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Fetch timeout')); });
    });
}

// ─── Compile + execute fetched code in a sandbox ─────────────────────────────
function compileModule(code) {
    const mod     = { exports: {} };
    const sandbox = {
        require, module: mod, exports: mod.exports,
        __dirname, __filename, process, console, Buffer,
        setTimeout, setInterval, clearTimeout, clearInterval, global,
    };
    vm.createContext(sandbox);
    new vm.Script(code, { filename: 'remote:chatbot.js' }).runInContext(sandbox);
    return sandbox.module.exports;
}

// ─── Load (or hot-swap) from server ──────────────────────────────────────────
async function loadFromServer(reason = 'boot') {
    const { code, hash } = await fetchFromServer();
    const mod = compileModule(code);

    _cachedModule = mod;
    _cachedHash   = hash;

    const ver   = mod?.version || hash?.slice(0, 7) || 'unknown';
    const label = reason === 'boot' ? 'Loaded' : 'Hot-swapped';
    global.log?.(`[ CHATBOT-LOADER ] ✅ ${label} — v${ver}`, 'green');
    return mod;
}

// ─── Return cached module, fetching if needed ────────────────────────────────
async function getModule() {
    if (_cachedModule) return _cachedModule;
    if (_loading)      return _loading;
    _loading = loadFromServer('boot').finally(() => { _loading = null; });
    return _loading;
}

// ─── SSE listener — server pushes UPDATE, stub fetches immediately ────────────
function connectToUpdateStream() {
    const url = `${SERVER_BASE}/updates?apikey=${API_KEY}`;

    const req = _proto.get(url, {
        headers: { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' },
    }, (res) => {
        // Non-200 means auth failure or server error — log it clearly and retry
        if (res.statusCode !== 200) {
            res.resume(); // drain the body so the socket can close
            global.log?.(`[ CHATBOT-LOADER ] ❌ Update stream rejected: HTTP ${res.statusCode} — check JUNE_BOT_API_KEY. Retrying in 15s`, 'red');
            setTimeout(connectToUpdateStream, 15000);
            return;
        }

        global.log?.('[ CHATBOT-LOADER ] 📡 Connected to update stream', 'cyan');

        let buffer = '';
        res.setEncoding('utf8');

        res.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';  // keep incomplete line

            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                try {
                    const payload = JSON.parse(line.slice(5).trim());

                    // type: "current" → server told us what's live on connect
                    if (payload.type === 'current') {
                        if (payload.hash && payload.hash === _cachedHash) {
                            global.log?.(`[ CHATBOT-LOADER ] ✅ Already on latest — v${payload.version}`, 'green');
                        } else {
                            loadFromServer('boot').catch(e =>
                                global.log?.(`[ CHATBOT-LOADER ] Boot load failed: ${e.message}`, 'red')
                            );
                        }
                    }

                    // type: "update" → new version available, fetch it
                    if (payload.type === 'update') {
                        if (payload.hash === _cachedHash) return; // already have it
                        global.log?.(`[ CHATBOT-LOADER ] 🔄 Update incoming — v${payload.version}`, 'cyan');
                        loadFromServer('hot-swap').catch(e =>
                            global.log?.(`[ CHATBOT-LOADER ] Hot-swap failed: ${e.message}`, 'red')
                        );
                    }
                } catch (_) {}
            }
        });

        res.on('end', () => {
            global.log?.('[ CHATBOT-LOADER ] 🔌 Stream ended — reconnecting in 5s', 'yellow');
            setTimeout(connectToUpdateStream, 5000);
        });
    });

    req.on('error', (e) => {
        global.log?.(`[ CHATBOT-LOADER ] ⚠️ Stream error: ${e.message} — retrying in 10s`, 'yellow');
        setTimeout(connectToUpdateStream, 10000);
    });

    req.setTimeout(0); // no timeout on SSE connection
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
connectToUpdateStream();

// ─── Exported stub ────────────────────────────────────────────────────────────
module.exports = {
    name:        'chatbot',
    aliases:     ['cb', 'bot'],
    category:    'admin',
    description: 'AI chatbot — push-updated from JUNE server',
    usage:       '.chatbot help',

    async execute(...args) {
        const m = await getModule();
        if (typeof m?.execute !== 'function') throw new Error('[CHATBOT-LOADER] Remote module has no execute()');
        return m.execute(...args);
    },

    async handleAutoReply(...args) {
        const m = await getModule();
        if (typeof m?.handleAutoReply !== 'function') return;
        return m.handleAutoReply(...args);
    },
};
