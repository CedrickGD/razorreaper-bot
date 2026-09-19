// ── RazorReaper Notifier backend ───────────────────────────────────────────────
// Watches configured Discord channels for ARK alert messages (resource / rare-dino
// / OSD / element-node etc.) and relays them to RazorReaper desktop clients over a
// Server-Sent-Events (SSE) HTTP stream. Runs inside the same process as the bot so
// the always-on host does double duty.
//
// IMPORTANT intent note: for messages authored by OTHER bots/users (which is what
// alert channels are), Discord only delivers .content, .embeds, .attachments and
// .components when the privileged MessageContent intent is enabled. That means
// NOTIFIER_MESSAGE_CONTENT=true (plus the portal toggle) is effectively required
// for the notifier to read MESA-style alert embeds. It stays opt-in so the bot
// never crash-loops on a disallowed intent (see index.js).
//
// Env:
//   NOTIFIER_TOKEN     shared token clients must present (?token= or
//                      Authorization: Bearer). If unset, the stream refuses all
//                      connections with 503 — fail closed. (NOTIFIER_SECRET and
//                      ?secret= are accepted as legacy aliases.)
//   NOTIFIER_CHANNELS  JSON map of channelId -> { cluster, type }, e.g.
//                      {"123":{"cluster":"Mesa","type":"rare-dino"},
//                       "456":{"cluster":"Mesa","type":"resource"}}
//                      If a channel isn't listed, its messages are ignored.
//   PORT               HTTP port (Railway injects this; default 3000).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_CLIENTS = 500;
const HEARTBEAT_MS = 25_000;
const RECENT_KEEP = 50;

let channelMap = {};
try {
    channelMap = JSON.parse(process.env.NOTIFIER_CHANNELS || '{}');
} catch (e) {
    console.error('[Notifier] NOTIFIER_CHANNELS is not valid JSON — no channels watched:', e.message);
}

// ── Persistent channel store ────────────────────────────────────────────────
// channelMap is editable live from the app (see /notifier/channels). It is
// persisted to a small JSON file on a Railway volume so in-app edits survive
// restarts/redeploys. Persistence is best-effort: without a writable volume the
// bot still works fully (edits just last until the next restart) — it never
// crashes over storage. NOTIFIER_CHANNELS remains the first-boot seed.
const CHANNELS_FILE = path.join(process.env.NOTIFIER_DATA_DIR || '/data', 'channels.json');

function loadPersistedChannels() {
    try {
        const parsed = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* no store yet — caller falls back to the env seed */ }
    return null;
}

function persistChannels() {
    try {
        fs.mkdirSync(path.dirname(CHANNELS_FILE), { recursive: true });
        fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channelMap, null, 2));
        return true;
    } catch (e) {
        console.warn('[Notifier] could not persist channels (no writable volume?):', e.message);
        return false;
    }
}

// The persisted store wins over the env seed so in-app edits stick; on the very
// first boot (no file yet) we write the env seed out so it carries over.
{
    const persisted = loadPersistedChannels();
    if (persisted) channelMap = persisted;
    else persistChannels();
}

const VALID_TYPES = new Set(['rare-dino', 'resource', 'element-node', 'osd', 'tribe-log']);

/** channelMap -> a stable array the app binds to. */
function channelList() {
    return Object.entries(channelMap).map(([channelId, cfg]) => ({
        channelId,
        cluster: (cfg && cfg.cluster) || 'Unknown',
        type: (cfg && cfg.type) || 'alert',
    }));
}

/** Collect a small JSON request body (caps size, resolves null on bad/oversized input). */
function readJsonBody(req) {
    return new Promise((resolve) => {
        let data = '';
        let aborted = false;
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 10_000) { aborted = true; req.destroy(); }
        });
        req.on('end', () => {
            if (aborted) return resolve(null);
            try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); }
        });
        req.on('error', () => resolve(null));
    });
}

/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();
const recent = []; // last N alerts, replayed to new subscribers so a fresh client isn't blank
let server = null;
let warnedNoToken = false;

function expectedToken() {
    return process.env.NOTIFIER_TOKEN || process.env.NOTIFIER_SECRET || '';
}

function presentedToken(req, url) {
    const q = url.searchParams.get('token') || url.searchParams.get('secret');
    if (q) return q;
    const auth = req.headers['authorization'] || '';
    if (/^Bearer\s/i.test(auth)) return auth.slice(auth.indexOf(' ') + 1).trim();
    return '';
}

// Constant-time comparison (hashing first equalises length so timingSafeEqual works).
function tokensMatch(provided, expected) {
    if (!provided || !expected) return false;
    const a = crypto.createHash('sha256').update(provided).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

function sseFrame(alert) {
    return `id: ${alert.id}\ndata: ${JSON.stringify(alert)}\n\n`;
}

function dropClient(res) {
    if (res._notifierHb) clearInterval(res._notifierHb);
    clients.delete(res);
    try { res.destroy(); } catch { /* already gone */ }
}

function broadcast(alert) {
    recent.push(alert);
    if (recent.length > RECENT_KEEP) recent.shift();
    const line = sseFrame(alert);
    for (const res of clients) {
        try { res.write(line); } catch { dropClient(res); }
    }
    return clients.size;
}

// Turn a Discord message into an alert (embed-first, content fallback).
function buildAlert(message, cfg) {
    const embed = message.embeds && message.embeds[0];
    let subject = '';
    let text = '';

    if (embed) {
        subject = (embed.title || (embed.author && embed.author.name) || '').trim();
        const parts = [];
        if (embed.description) parts.push(embed.description);
        if (Array.isArray(embed.fields)) {
            for (const f of embed.fields) parts.push(`${f.name}: ${f.value}`);
        }
        text = parts.join(' | ').replace(/\s+/g, ' ').trim();
    }

    // Plain content (only populated when the MessageContent intent is enabled).
    if (!subject && message.content) subject = message.content.split('\n')[0].slice(0, 120).trim();
    if (!text && message.content) text = message.content.replace(/\s+/g, ' ').trim();

    if (!subject && !text) return null; // nothing parseable (yet) — e.g. attachment-only

    return {
        id: message.id,
        cluster: cfg.cluster || 'Unknown',
        type: cfg.type || 'alert',
        subject: subject || text.slice(0, 120),
        text: text.slice(0, 500),
        channelId: message.channelId,
        link: message.url || null,
        ts: message.createdTimestamp || Date.now(),
    };
}

function startHttpServer() {
    server = http.createServer((req, res) => {
        let url;
        try {
            url = new URL(req.url, `http://localhost:${PORT}`);
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'bad_request' }));
            return;
        }

        // Health check (Railway) — no auth.
        if (url.pathname === '/health' || url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({
                ok: true,
                uptime: Math.round(process.uptime()),
                clients: clients.size,
                watching: Object.keys(channelMap).length,
            }));
            return;
        }

        // ── Channel management — token-gated (GET list / POST add / DELETE remove) ──
        // Lets the RazorReaper app manage watched channels live, with no redeploy.
        if (url.pathname === '/notifier/channels') {
            const expected = expectedToken();
            if (!expected) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'notifier_disabled', message: 'NOTIFIER_TOKEN not set' }));
                return;
            }
            if (!tokensMatch(presentedToken(req, url), expected)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'unauthorized' }));
                return;
            }

            if (req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, channels: channelList() }));
                return;
            }

            if (req.method === 'POST') {
                readJsonBody(req).then((body) => {
                    const channelId = String((body && body.channelId) || '').trim();
                    const cluster = (String((body && body.cluster) || '').trim()) || 'Unknown';
                    let type = (String((body && body.type) || '').trim()) || 'osd';
                    if (!/^\d{5,25}$/.test(channelId)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'invalid_channel_id', message: 'Channel ID must be a Discord snowflake (digits only).' }));
                        return;
                    }
                    if (!VALID_TYPES.has(type)) type = 'osd';
                    channelMap[channelId] = { cluster, type };
                    persistChannels();
                    console.log(`[Notifier] channel set: ${channelId} (${cluster}/${type}) — now watching ${Object.keys(channelMap).length}`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, channels: channelList() }));
                });
                return;
            }

            if (req.method === 'DELETE') {
                const id = String(url.searchParams.get('id') || '').trim();
                if (id && channelMap[id]) {
                    delete channelMap[id];
                    persistChannels();
                    console.log(`[Notifier] channel removed: ${id} — now watching ${Object.keys(channelMap).length}`);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, channels: channelList() }));
                return;
            }

            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'method_not_allowed' }));
            return;
        }

        // Everything else needs the shared token and a configured token.
        if (url.pathname === '/notifier/stream' || url.pathname === '/notifier/test') {
            const expected = expectedToken();
            if (!expected) {
                if (!warnedNoToken) {
                    console.warn('[Notifier] NOTIFIER_TOKEN is not set — refusing all notifier connections (fail closed).');
                    warnedNoToken = true;
                }
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'notifier_disabled', message: 'NOTIFIER_TOKEN not set' }));
                return;
            }
            if (!tokensMatch(presentedToken(req, url), expected)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'unauthorized' }));
                return;
            }

            // Inject a synthetic alert (for wiring tests from the app).
            if (url.pathname === '/notifier/test') {
                const alert = {
                    id: `test-${Date.now()}`,
                    cluster: url.searchParams.get('cluster') || 'Mesa',
                    type: url.searchParams.get('type') || 'rare-dino',
                    subject: url.searchParams.get('subject') || 'Test alert — Rare Dino',
                    text: 'This is a test alert from the RazorReaper notifier backend.',
                    channelId: null,
                    link: null,
                    ts: Date.now(),
                };
                const delivered = broadcast(alert);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, delivered }));
                return;
            }

            // SSE stream.
            if (clients.size >= MAX_CLIENTS) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'too_many_subscribers' }));
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            req.socket.setKeepAlive(true);
            req.socket.setNoDelay(true);
            req.socket.setTimeout(0);

            res.write('retry: 5000\n\n');
            res.write(`event: ready\ndata: ${JSON.stringify({ watching: Object.keys(channelMap).length })}\n\n`);

            // Replay recent alerts. If the client reconnects with Last-Event-ID
            // (or ?since=), only replay what it missed; otherwise send the lot.
            const lastId = req.headers['last-event-id'] || url.searchParams.get('since');
            const fromIdx = lastId ? recent.findIndex(a => String(a.id) === String(lastId)) : -1;
            for (const a of recent.slice(fromIdx + 1)) res.write(sseFrame(a));

            clients.add(res);
            res._notifierHb = setInterval(() => {
                try { res.write(': ping\n\n'); } catch { dropClient(res); }
            }, HEARTBEAT_MS);

            req.on('close', () => dropClient(res));
            res.on('error', () => dropClient(res));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
    });

    // SSE connections stay open indefinitely — never time them out server-side.
    server.timeout = 0;
    server.keepAliveTimeout = 75_000;

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[Notifier] HTTP/SSE server listening on :${PORT}`);
        console.log(`[Notifier] token ${expectedToken() ? 'set' : 'MISSING (stream disabled)'}, watching ${Object.keys(channelMap).length} channel(s)`);
    });
    server.on('error', (e) => console.error('[Notifier] HTTP server error:', e.message));
}

function handleMessage(client, message) {
    try {
        if (!message.guildId) return;
        const cfg = channelMap[message.channelId];
        if (!cfg) return;
        if (client.user && message.author && message.author.id === client.user.id) return; // never relay ourselves
        if (recent.some(a => a.id === message.id)) return; // already relayed (create/update race)
        const alert = buildAlert(message, cfg);
        if (alert) broadcast(alert);
    } catch (e) {
        console.error('[Notifier] message handler error:', e.message);
    }
}

function initNotifier(client) {
    startHttpServer();

    client.on('messageCreate', (message) => handleMessage(client, message));
    // Some alert bots send an empty message first and edit the embed in — catch it.
    client.on('messageUpdate', (_old, message) => handleMessage(client, message));

    console.log('[Notifier] initialized');
}

// Graceful shutdown: end every SSE client and stop accepting connections.
function stopNotifier() {
    for (const res of clients) {
        if (res._notifierHb) clearInterval(res._notifierHb);
        try { res.end(); } catch { /* already gone */ }
    }
    clients.clear();
    if (server) {
        try { server.close(); } catch { /* not listening */ }
        server = null;
    }
}

module.exports = { initNotifier, stopNotifier };
