// The knowledge base is generated from the client checkout and committed here, so it can go
// stale silently the moment a label or a script default changes over there. `--check` regenerates
// in memory and compares; this test just runs it where the checkout exists (never in the image).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadKb } = require('../ai-support');

const CLIENT = process.env.RR_CLIENT_DIR || 'C:/Users/cedri/source/repos/CedrickGD/RazorReaper';
const haveClient = fs.existsSync(path.join(CLIENT, 'RazorReaper', 'Resources', 'i18n', 'en.json'));

test('the committed kb/ matches what the generator produces', { skip: haveClient ? false : 'no client checkout here' }, () => {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'build-kb.mjs'), '--check', '--client', CLIENT], { stdio: 'pipe' });
});

test('the knowledge base loads and stays inside one cached system prompt', () => {
    const kb = loadKb();
    assert.ok(kb.length > 50_000, 'kb/ looks empty — run npm run build:kb');
    assert.ok(Math.ceil(kb.length / 4) < 60_000, 'kb/ no longer fits the ~60k-token budget');
});

test('"where do I download it" has exactly one answer, and it is faq.md\'s', () => {
    // The README's Install section pointed members at the GitHub releases page. It resolves — the
    // repo is public — but the owner bumps master without cutting a release, so that page goes
    // stale while https://dl.razorreaper.app always serves the current installer. Two download
    // answers in one system prompt means the model may pick the stale one. release.md is exempt:
    // its link is the owner's own changelog URL, taken straight out of update.xml.
    const app = fs.readFileSync(path.join(__dirname, '..', 'kb', 'app.md'), 'utf8');
    assert.doesNotMatch(app, /github\.com/i);
});

test('nothing the generator is supposed to exclude ever lands in a generated file', () => {
    // faq.md is deliberately out of scope: it is hand-written and reviewed, and it NAMES the
    // forbidden topics in order to forbid them.
    const dir = path.join(__dirname, '..', 'kb');
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'faq.md')) {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        for (const banned of [/\bhwid\b/i, /machine\s?id/i, /anti-?tamper/i, /workers\.dev/, /\bsk-[A-Za-z0-9_-]{16,}/, /Bearer\s+\w/]) {
            assert.doesNotMatch(text, banned, `kb/${file} leaked ${banned}`);
        }
    }
});
