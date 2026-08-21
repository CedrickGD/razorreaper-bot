// Redirect shell: when REDIRECT_TO is set (e.g. https://bot.razorreaper.app) this process does NOT
// log in to Discord. It only keeps the old public URL alive: /health answers 200 and every other
// request is answered with a 307 to the same path + query on the new host, so desktop clients
// that still have the old notifier endpoint pasted (".../notifier/stream?token=…") follow it
// transparently (HttpClient follows GET redirects and keeps the query string).
const http = require('http');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TARGET = String(process.env.REDIRECT_TO || '').replace(/\/+$/, '');

function start() {
    const server = http.createServer((req, res) => {
        let pathname = '/';
        let search = '';
        try {
            const url = new URL(req.url, `http://localhost:${PORT}`);
            pathname = url.pathname;
            search = url.search;
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Bad request URL.' }));
            return;
        }
        if (pathname === '/health' || pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, mode: 'redirect', target: TARGET }));
            return;
        }
        res.writeHead(307, { Location: TARGET + pathname + search, 'Cache-Control': 'no-store' });
        res.end();
    });
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[Redirect] listening on ${PORT}, forwarding everything to ${TARGET}`);
    });
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

start();
