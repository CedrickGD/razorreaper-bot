// The knowledge base is generated from the client checkout and committed here, so it can go
// stale silently the moment a label or a script default changes over there. `--check` regenerates
// in memory and compares; this test just runs it where the checkout exists (never in the image).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadKb, kbFor, UI_PAGES, PAIRED, MENTION_MAX, CATEGORY_KEYS, HUMAN_ONLY } = require('../ai-support');

const CLIENT = process.env.RR_CLIENT_DIR || 'C:/Users/cedri/source/repos/CedrickGD/RazorReaper';
const haveClient = fs.existsSync(path.join(CLIENT, 'RazorReaper', 'Resources', 'i18n', 'en.json'));

test('the committed kb/ matches what the generator produces', { skip: haveClient ? false : 'no client checkout here' }, () => {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'build-kb.mjs'), '--check', '--client', CLIENT], { stdio: 'pipe' });
});

const kb = loadKb();
const whole = [kb.base, [kb.preamble, ...kb.sections.map(s => s.text)].join('\n\n')].join('\n\n---\n\n');
const tokens = (s) => Math.ceil(s.length / 4);
const section = (key) => kb.sections.find(s => s.key === key).text;
const has = (text, key) => text.includes(section(key));

test('the knowledge base loads and stays inside one cached system prompt', () => {
    assert.ok(whole.length > 50_000, 'kb/ looks empty — run npm run build:kb');
    assert.ok(tokens(whole) < 60_000, 'kb/ no longer fits the ~60k-token budget');
    assert.deepStrictEqual(loadKb(path.join(__dirname, 'no-such-dir')), { base: '', preamble: '', sections: [] });
});

test('no raw {n} placeholders reach the model', () => {
    // "Row {0} hotbar key" quoted raw came back to a member verbatim (ticket-0003).
    assert.doesNotMatch(whole, /\{\d+\}/);
});

test('a filled-in value is marked ‹…›, which no app text uses, so it never reads like "Saving…"', () => {
    assert.match(whole, /Row ‹…› hotbar key/);
    assert.match(whole, /Saving…/);
    if (!haveClient) return;
    const dir = path.join(CLIENT, 'RazorReaper', 'Resources', 'i18n');
    for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('‹…›'), f);
});

test('every kb/scripts.md heading is a real script with an id', () => {
    // The *Script.cs glob also matches the ICalibratableScript interface — an empty heading.
    const scripts = fs.readFileSync(path.join(__dirname, '..', 'kb', 'scripts.md'), 'utf8');
    const headings = scripts.match(/^## .*$/gm);
    assert.ok(headings.length > 5);
    for (const h of headings) assert.match(h, /\(id `/);
});

test('every category maps to ui.md sections that really exist', () => {
    // A generator rename must fail here, not silently drop a page from every answer.
    const keys = new Set(kb.sections.map(s => s.key));
    for (const cat of CATEGORY_KEYS) assert.ok(UI_PAGES[cat], `no UI_PAGES entry for ${cat}`);
    for (const [cat, pages] of Object.entries(UI_PAGES)) {
        for (const key of pages) assert.ok(keys.has(key), `UI_PAGES.${cat} names a missing section: ${key}`);
    }
    for (const [key, extra] of Object.entries(PAIRED)) {
        for (const k of [key, ...extra]) assert.ok(keys.has(k), `PAIRED names a missing section: ${k}`);
    }
});

test('each answered category carries a fraction of the whole knowledge base', () => {
    for (const cat of CATEGORY_KEYS.filter(c => !HUMAN_ONLY.has(c))) {
        const n = tokens(kbFor(kb, cat, ''));
        assert.ok(n < 16_000, `${cat} is ${n} tokens`);
        assert.ok(n <= tokens(whole) * 0.3, `${cat} is ${n} of ${tokens(whole)} tokens`);
    }
});

test('a page the member names comes along, in English or German; a component name does not', () => {
    assert.ok(!has(kbFor(kb, 'other', ''), 'crosshair'));
    assert.ok(has(kbFor(kb, 'other', 'my Crosshair is gone'), 'crosshair'));
    assert.ok(has(kbFor(kb, 'other', 'mein fadenkreuz ist weg'), 'crosshair'));
    assert.ok(!has(kbFor(kb, 'other', 'Crosshairs everywhere'), 'crosshair'), 'whole words only');
    assert.strictEqual(kbFor(kb, 'other', 'the hud overlay is broken'), kbFor(kb, 'other', ''));
});

test('naming Sky Changer brings its body (the bare "sky" section) along', () => {
    assert.ok(!has(kbFor(kb, 'other', ''), 'sky'));
    assert.ok(has(kbFor(kb, 'other', 'Sky Changer will not apply'), 'sky'));
    assert.ok(has(kbFor(kb, 'bug', 'der Himmel-Wechsler geht nicht'), 'sky'));
});

test('named pages are capped, and the output is file order whatever the mention order', () => {
    const named = ['Crosshair', 'Gamma', 'Fonts', 'Desync', 'Stretched Res', 'Bosses'];
    const out = kbFor(kb, 'other', named.join(', '));
    assert.strictEqual(['crosshair', 'gamma', 'fonts', 'desync', 'stretchedres', 'bosses'].filter(k => has(out, k)).length, MENTION_MAX);
    assert.strictEqual(out, kbFor(kb, 'other', named.join(', ')));
    const two = kbFor(kb, 'other', 'Gamma and Crosshair');
    assert.strictEqual(two, kbFor(kb, 'other', 'Crosshair and Gamma'));
    const at = (key) => two.indexOf(section(key));
    assert.ok(at('crosshair') < at('gamma') && at('gamma') < at('nav'));
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
