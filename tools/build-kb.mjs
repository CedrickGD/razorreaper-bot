// ── Knowledge-base generator ──────────────────────────────────────────────────
// Turns a LOCAL, READ-ONLY checkout of the RazorReaper client into the markdown the support AI
// gets as its system prompt (kb/*.md, committed to this repo and copied into the image).
//
//   node tools/build-kb.mjs [--client <path>] [--check]
//
// --check writes nothing and exits 1 if the committed kb/ differs from what this run would
// produce — that is the test hook, so CI/`npm test` can prove kb/ is not stale.
//
// What it reads (and NOTHING else): the i18n resource files, README.md's user-facing sections,
// the automation scripts' own source (names, defaults, clamp ranges), the error-code constants
// with the Troubleshoot page's code→text mapping, and update.xml. Everything under
// Services/**/Licens*, Security/, Telemetry/, the update proxy, the admin panel and the keys repo
// is out of reach by construction: those paths are never opened. A key-level denylist drops
// anything whose NAME hints at licensing/HWID/anti-tamper/telemetry internals as a second net.
//
// kb/faq.md is hand-written and never touched here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO, 'kb');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const clientArg = argv.indexOf('--client');
const CLIENT = path.resolve(
    clientArg >= 0 ? argv[clientArg + 1]
        : process.env.RR_CLIENT_DIR || 'C:/Users/cedri/source/repos/CedrickGD/RazorReaper',
);

const read = (...p) => fs.readFileSync(path.join(CLIENT, ...p), 'utf8');
// i18n texts carry string.Format slots ("Row {0} hotbar key"). Quoted raw, the model repeats the
// `{0}` to members, so every i18n string is read with its slots already turned into `…`.
const fill = (s) => s.replace(/\{\d+\}/g, '…');
const readI18n = (lang) => JSON.parse(read('RazorReaper', 'Resources', 'i18n', `${lang}.json`),
    (_, v) => typeof v === 'string' ? fill(v) : v);
const FILLED_NOTE = '`…` inside a text is a value the app fills in (a number, key or name). Say e.g. '
    + "'Row 1 hotbar key', never quote the `…`.";

// Rough but stable: ~4 characters per token for English/German prose. Only ever used to tell the
// owner whether the KB still fits one cached system prompt, never to bill anything.
const estTokens = (s) => Math.ceil((typeof s === 'number' ? s : s.length) / 4);

// Second net over the i18n keys (the first is simply not reading those directories).
const SECRET_KEY_RE = /hwid|machineid|hardware|fingerprint|tamper|telemetry|secret|apikey|api_key|token|endpoint|webhook|checksum|signature/i;

// ── 1. app.md — what RazorReaper is, from the README's user-facing sections ────
// Heading allowlist, not a blocklist: the release-engineering sections (worker URL, workflow
// names, staging internals) are simply never copied.
const README_SECTIONS = new Set([
    '## Highlights', '## Features', '## Getting Started', '### Requirements',
    '### Updating', '## Notes',
]);
// Dropping a heading from the allowlist is not enough to exclude a `###` — it inherits `keep` from
// the `##` above it. "### Install" has to be named here: it points at the PRIVATE repo's releases
// page, which 404s for every customer, and a download answer that 404s is worse than none.
// kb/faq.md answers "where do I download it" with https://dl.razorreaper.app, and that is the only
// answer the model may ever see.
const README_EXCLUDE = '### Install';

function buildApp() {
    const lines = read('README.md').split(/\r?\n/);
    const out = [];
    let keep = false;
    for (const line of lines) {
        const heading = /^#{2,4} /.test(line);
        if (heading) {
            // A ### under a kept ## stays kept (the Features tool tables); a new ## decides afresh.
            const isTop = line.startsWith('## ');
            keep = line.trim() !== README_EXCLUDE && (README_SECTIONS.has(line.trim()) || (!isTop && keep));
        }
        if (keep) out.push(line);
    }
    return [
        '# RazorReaper — the app',
        '',
        'RazorReaper is a paid Windows desktop toolkit for **Steam ARK: Survival Evolved** (not ASA,',
        'not the Microsoft Store build, not console). Everything below is quoted from the product',
        'README — use these exact tool names when pointing a member at a page.',
        '',
        ...out,
        '',
    ].join('\n').replace(/\n{3,}/g, '\n\n');
}

// ── 2. ui.md — every page, setting and message the member can actually see ─────
// The i18n files ARE the user-facing surface: label + description for every control, plus the
// toast/status texts a member quotes when something goes wrong. Keys are printed with the section
// prefix stripped (the heading carries it) — that alone saves ~25k characters.
// German is carried only for the NAMES a member would type at you — pages, sections, controls.
// Translating every button and toast as well costs ~15k tokens and buys nothing: the AI answers
// in German either way, it just needs to call the page what the German UI calls it.
const DE_NAME_RE = /\.(label|title|name|heading)$|^nav\./;

function buildUi() {
    const en = readI18n('en');
    const de = readI18n('de');

    // nav.page.<slug> gives the sidebar name; the de-hyphenated slug is usually the key prefix.
    const pageNames = new Map();
    for (const [k, v] of Object.entries(en)) {
        const m = /^nav\.page\.(.+)$/.exec(k);
        if (m) pageNames.set(m[1].replace(/-/g, ''), v);
    }

    const groups = new Map();
    let dropped = 0;
    for (const [key, value] of Object.entries(en)) {
        if (SECRET_KEY_RE.test(key)) { dropped++; continue; }
        if (typeof value !== 'string' || !value.trim()) continue;
        const prefix = key.split('.')[0];
        if (!groups.has(prefix)) groups.set(prefix, []);
        groups.get(prefix).push([key, value]);
    }

    const out = [
        '# RazorReaper — pages, settings and on-screen texts',
        '',
        'Every line is a real string from the app, so you can name a control exactly as the member',
        'sees it. `EN` is the English UI text; `[DE: …]` is the German label for the same control —',
        'use the German one when the member writes German. Lines are `<setting key>: <text>`; a',
        '`.desc` line explains the setting above it.',
        FILLED_NOTE,
        '',
    ];
    for (const prefix of [...groups.keys()].sort()) {
        const page = pageNames.get(prefix);
        out.push(`## ${page ? `${page} (${prefix})` : prefix}`);
        for (const [key, value] of groups.get(prefix)) {
            const short = key.slice(prefix.length + 1) || key;
            const deText = de[key];
            const withDe = deText && deText !== value && DE_NAME_RE.test(key)
                ? `  [DE: ${deText}]` : '';
            out.push(`- ${short}: ${value}${withDe}`);
        }
        out.push('');
    }
    return { text: out.join('\n'), dropped, groups: groups.size };
}

// ── 3. scripts.md — the automation catalogue with defaults and ranges ─────────
// Names, defaults and the clamp ranges come from each script's own source, so a changed default
// cannot silently rot in the KB. Descriptions come from the same i18n file the app shows.
const SCRIPTS_DIR = ['RazorReaper', 'Services', 'Automation', 'Scripts'];

function buildScripts() {
    const en = readI18n('en');
    const dir = path.join(CLIENT, ...SCRIPTS_DIR);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('Script.cs')).sort();

    const out = [
        '# RazorReaper — automation scripts',
        '',
        'Found on the **Scripts** page (sidebar group *Automation*). Ground rules that apply to all',
        'of them and answer most "the script does nothing" tickets:',
        '',
        '- They send real keyboard/mouse input, so **ARK must be the focused foreground window**.',
        '  Minimised, alt-tabbed or on another monitor = the script deliberately does nothing.',
        '- Each script has its own **start/stop hotkey** (Scripts page, or the Global Hotkeys page).',
        '  A hotkey another program already owns never reaches RazorReaper.',
        '- Scripts that recognise something on screen (Take All, Tek Saddle, Noglin, Turret, Fed Suit,',
        '  Flak, Antidote …) must be **calibrated for the current resolution and monitor**: capture the',
        '  region and a reference snapshot on the same display ARK runs on. Changing resolution, UI',
        '  scale or monitor invalidates the calibration and matching pauses until it is recaptured.',
        '- "Match threshold" is a similarity percentage: too high = never matches, too low = false hits.',
        '',
        'Defaults and min/max below are read straight from the shipped code.',
        FILLED_NOTE,
        '',
    ];

    for (const file of files) {
        const src = fs.readFileSync(path.join(dir, file), 'utf8');
        const key = /private const string Key = "([^"]+)"/.exec(src)?.[1];
        if (!key) continue; // ICalibratableScript.cs matches the glob but is an interface, not a script
        const name = /:\s*base\(\s*Key\s*,\s*"([^"]*)"/.exec(src)?.[1] || file.replace(/Script\.cs$/, '');
        const desc = en[`scripts.desc.${key}`];

        // `public int IntervalMs { get; set; } = 5000;` → default; Math.Clamp(X, lo, hi) → range.
        const defaults = new Map();
        for (const m of src.matchAll(/public\s+[\w<>?]+\s+(\w+)\s*\{\s*get;\s*set;\s*\}\s*=\s*([^;]+);/g)) {
            defaults.set(m[1], m[2].trim());
        }
        const ranges = new Map();
        for (const m of src.matchAll(/(\w+)\s*=\s*Math\.Clamp\(\s*\1\s*,\s*([^,]+),\s*([^)]+)\)/g)) {
            ranges.set(m[1], [m[2].trim(), m[3].trim()]);
        }

        out.push(`## ${name} (id \`${key}\`)`);
        if (desc) out.push(desc);
        const props = [...new Set([...defaults.keys(), ...ranges.keys()])].sort();
        for (const prop of props) {
            const def = defaults.get(prop);
            const range = ranges.get(prop);
            if (!def && !range) continue;
            out.push(`- ${prop}${def ? ` — default ${def}` : ''}${range ? ` (allowed ${range[0]}…${range[1]})` : ''}`);
        }
        // The script's own i18n block: field labels, per-field explanations, warnings.
        for (const [k, v] of Object.entries(en)) {
            if (!k.startsWith(`scripts.${key}.`)) continue;
            if (SECRET_KEY_RE.test(k)) continue;
            out.push(`- ${k.slice(`scripts.${key}.`.length)}: ${v}`);
        }
        out.push('');
    }
    return out.join('\n');
}

// ── 4. errors.md — the RR-Exxxx catalogue ────────────────────────────────────
function buildErrors() {
    const en = readI18n('en');
    const codes = new Map(); // constant name -> RR-Exxxx
    const constSrc = read('RazorReaper', 'Diagnostics', 'AppErrorCodes.cs');
    for (const m of constSrc.matchAll(/public const string (\w+)\s*=\s*"([^"]+)"/g)) codes.set(m[1], m[2]);

    const page = read('RazorReaper', 'Components', 'Pages', 'Troubleshoot.razor');
    const out = [
        '# RazorReaper — error codes and troubleshooting',
        '',
        'Codes shown as `RR-Exxxx` in the app (Troubleshoot page → *Last error* / *Error codes*).',
        '',
    ];
    const seen = new Set();
    const rx = /new\(\s*AppErrorCodes\.(\w+)\s*,\s*TitleKey:\s*"([^"]+)"\s*,\s*DescriptionKey:\s*"([^"]+)"/g;
    for (const m of page.matchAll(rx)) {
        const [, constName, titleKey, descKey] = m;
        const code = codes.get(constName);
        if (!code) continue;
        seen.add(constName);
        out.push(`- **${code}** — ${en[titleKey] || constName}: ${en[descKey] || ''}`.trimEnd());
    }
    for (const [constName, code] of codes) {
        if (!seen.has(constName)) out.push(`- **${code}** — ${constName} (no user-facing description in the app).`);
    }

    out.push('', '## Before assuming something is broken (from the Troubleshoot page)', '');
    for (const k of Object.keys(en)) {
        if (/^troubleshoot\.note\.\d+$/.test(k)) out.push(`- ${en[k]}`);
    }
    out.push(
        '',
        '## Getting logs out of a member',
        '',
        `- ${en['troubleshoot.logging.subtitle'] || 'Turn on logs to capture issues and share details.'}`,
        '- Troubleshoot page → **Enable logging** (optionally *Verbose diagnostics*), reproduce the',
        '  problem, then **Open log folder** and attach the newest file to the ticket.',
        `- ${en['troubleshoot.support.text'] || ''}`.trimEnd(),
        '',
    );
    return out.join('\n');
}

// ── 5. release.md — the version members are offered right now ─────────────────
function buildRelease() {
    const xml = read('update.xml');
    const pick = (tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1].trim() || '';
    return [
        '# RazorReaper — current release',
        '',
        `- Latest version offered to clients: **${pick('version')}**`,
        `- Mandatory update: ${pick('mandatory') === 'true' ? 'yes' : 'no'}`,
        `- Public release notes: ${pick('changelog')}`,
        '',
        '## What changed in this version',
        '',
        pick('notes'),
        '',
        'Older versions: point the member at the release-notes page above rather than guessing.',
        '',
    ].join('\n');
}

// ── Write / check ─────────────────────────────────────────────────────────────
const ui = buildUi();
const files = {
    'app.md': buildApp(),
    'ui.md': ui.text,
    'scripts.md': buildScripts(),
    'errors.md': buildErrors(),
    'release.md': buildRelease(),
};

let total = 0;
let stale = [];
for (const [name, text] of Object.entries(files)) {
    total += text.length;
    const target = path.join(OUT_DIR, name);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (CHECK) {
        if (current !== text) stale.push(name);
    } else if (current !== text) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(target, text);
    }
    console.log(`${CHECK ? 'check' : 'wrote'} kb/${name.padEnd(12)} ${String(text.length).padStart(7)} chars  ~${estTokens(text)} tokens`);
}

// faq.md is hand-written but ships in the same system prompt — count it in the budget.
const faq = path.join(OUT_DIR, 'faq.md');
if (fs.existsSync(faq)) {
    const text = fs.readFileSync(faq, 'utf8');
    total += text.length;
    console.log(`(hand) kb/faq.md${' '.repeat(6)} ${String(text.length).padStart(7)} chars  ~${estTokens(text)} tokens`);
}

console.log(`\nKB total: ${total} chars, ~${estTokens(total)} tokens across ${ui.groups} i18n sections (${ui.dropped} key(s) dropped by the secret denylist).`);
if (estTokens(total) > 60000) {
    console.error('KB is over the 60k-token budget for one cached system prompt — trim it.');
    process.exit(1);
}
if (CHECK && stale.length) {
    console.error(`\nkb/ is stale — rerun \`npm run build:kb\`: ${stale.join(', ')}`);
    process.exit(1);
}
