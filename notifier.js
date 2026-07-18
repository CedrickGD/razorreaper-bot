// ── RazorReaper Notifier backend ───────────────────────────────────────────────
// Watches configured Discord channels for ARK alert messages (resource / rare-dino
// / OSD / element-node etc.) and relays them to RazorReaper desktop clients over a
// Server-Sent-Events (SSE) HTTP stream. Runs inside the same process as the bot so
// the always-on host does double duty.
//
// Reading message EMBEDS needs no privileged intent (most ARK alert bots post
// embeds). Reading plain message .content needs the privileged MessageContent
// intent — enabled only when NOTIFIER_MESSAGE_CONTENT=true (see index.js), so the
// bot never crash-loops on a disallowed intent.
//
// Env:
//   NOTIFIER_SECRET    shared token clients must present (?secret= or Bearer). If
//                      unset, the stream is disabled (returns 503) — fail closed.
//   NOTIFIER_CHANNELS  JSON map of channelId -> { cluster, type }, e.g.
//                      {"123":{"cluster":"Mesa","type":"rare-dino"},
//                       "456":{"cluster":"Mesa","type":"resource"}}
//                      If a channel isn't listed, its messages are ignored.
//   PORT               HTTP port (Railway/justrunmy inject this; default 8080).

const http = require('http');

const PORT = parseInt(process.env.PORT || '8080', 10);
const SECRET = process.env.NOTIFIER_SECRET || '';
const MAX_CLIENTS = 500;
const HEARTBEAT_MS = 25_000;
const RECENT_KEEP = 50;

let channelMap = {};
try {
    channelMap = JSON.parse(process.env.NOTIFIER_CHANNELS || '{}');
} catch (e) {
    console.error('[Notifier] NOTIFIER_CHANNELS is not valid JSON — no channels watched:', e.message);
}

/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();
const recent = []; // last N alerts, replayed to new subscribers so a fresh client isn't blank

function presentedSecret(req, url) {
    const q = url.searchParams.get('secret');
    if (q) return q;
    const auth = req.headers['authorization'] || '';
    if (auth.startsWith('Bearer ')) return auth.slice(7);
    return '';
}

function broadcast(alert) {
    recent.push(alert);
    if (recent.length > RECENT_KEEP) recent.shift();
    const line = `data: ${JSON.stringify(alert)}\n\n`;
    for (const res of clients) {
        try { res.write(line); } catch { /* dropped on next heartbeat */ }
    }
}

// Turn a Discord message into an alert (embed-first, content fallback).
function buildAlert(message, cfg) {
    const embed = message.embeds && message.embeds[0];
    let subject = '';
    let text = '';

    if (embed) {
        subject = (embed.title || '').trim();
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

    if (!subject && !text) return null; // nothing parseable (e.g. attachment-only)

    return {
        id: message.id,
        cluster: cfg.cluster || 'Unknown',
        type: cfg.type || 'alert',
        subject: subject || text.slice(0, 120),
        text: text.slice(0, 500),
        ts: message.createdTimestamp || Date.now(),
    };
}

function startHttpServer() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${PORT}`);

        // Health check (Railway/justrunmy) — no auth.
        if (url.pathname === '/health' || url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
            return;
        }

        // Everything else needs the shared secret and a configured secret.
        if (url.pathname === '/notifier/stream' || url.pathname === '/notifier/test') {
            if (!SECRET) {
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                res.end('notifier disabled: NOTIFIER_SECRET not set');
                return;
            }
            if (presentedSecret(req, url) !== SECRET) {
                res.writeHead(401, { 'Content-Type': 'text/plain' });
                res.end('unauthorized');
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
                    ts: Date.now(),
                };
                broadcast(alert);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, delivered: clients.size }));
                return;
            }

            // SSE stream.
            if (clients.size >= MAX_CLIENTS) {
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                res.end('too many subscribers');
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.write('retry: 5000\n\n');
            res.write(`event: ready\ndata: ${JSON.stringify({ watching: Object.keys(channelMap).length })}\n\n`);
            for (const a of recent) res.write(`data: ${JSON.stringify(a)}\n\n`);

            clients.add(res);
            const hb = setInterval(() => {
                try { res.write(': ping\n\n'); } catch { /* handled by close */ }
            }, HEARTBEAT_MS);

            req.on('close', () => {
                clearInterval(hb);
                clients.delete(res);
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[Notifier] HTTP/SSE server listening on :${PORT}`);
        console.log(`[Notifier] secret ${SECRET ? 'set' : 'MISSING (stream disabled)'}, watching ${Object.keys(channelMap).length} channel(s)`);
    });
    server.on('error', (e) => console.error('[Notifier] HTTP server error:', e.message));
}

function initNotifier(client) {
    startHttpServer();

    client.on('messageCreate', (message) => {
        try {
            if (!message.guildId) return;
            const cfg = channelMap[message.channelId];
            if (!cfg) return;
            const alert = buildAlert(message, cfg);
            if (alert) broadcast(alert);
        } catch (e) {
            console.error('[Notifier] messageCreate handler error:', e.message);
        }
    });

    console.log('[Notifier] initialized');
}

module.exports = { initNotifier };
