// No network, no SDK, no Discord: every provider is a stub and the Anthropic SDK is injected.
const test = require('node:test');
const assert = require('node:assert');
const {
    redact, clean, makeBudget, parseJsonish, normaliseTriage, formatForm,
    buildProviders, createSupport, BudgetExhausted, CATEGORY_KEYS,
    openaiProvider, TRIAGE_SCHEMA,
} = require('../ai-support');

const quiet = () => {};

// ── Redaction — the one rule where "mostly" is not good enough ────────────────

test('licence keys never reach a model, in any of the shapes members paste', () => {
    for (const key of ['ABCD-1234-EFGH-5678', 'abcd-1234-efgh-5678', 'A1B2C3D4-E5F6G7H8-I9J0K1L2-M3N4O5P6']) {
        const out = redact(`my key is ${key} and it fails`);
        assert.ok(!out.includes(key.split('-')[1]), `leaked a group of ${key}`);
        assert.match(out, /\[licence-key\]/);
    }
});

test('API keys, PATs and Discord tokens are stripped', () => {
    const out = redact([
        'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
        'github_pat_11ABCDEFG0abcdefghijklmnop',
        'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7',
        ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GhIjKl', 'mNoPqRsTuVwXyZ0123456789abcdef'].join('.'), // split so secret scanners do not see a token
    ].join('\n'));
    assert.ok(!/sk-proj-abc|github_pat_11AB|AIzaSyA1b2|GhIjKl/.test(out), out);
});

test('e-mails, IPs and the Windows user name are stripped', () => {
    const out = redact('mail me at bob.smith@example.co.uk, server 192.168.2.201:27015, log in C:\\Users\\Cedrick\\AppData\\Local\\RR\\log.txt');
    assert.ok(!out.includes('bob.smith@example.co.uk'));
    assert.ok(!out.includes('192.168.2.201'));
    assert.ok(!out.includes('Cedrick'), out);
    assert.match(out, /C:\\Users\\…\\AppData/);
});

test('ordinary support prose survives redaction untouched', () => {
    const text = 'Fed Suit does nothing on Gen 2, hotkey F7, RazorReaper 1.5.2, error RR-E1003.';
    assert.strictEqual(redact(text), text);
});

test('redact never throws on non-strings', () => {
    for (const v of [null, undefined, 0, {}, []]) assert.strictEqual(typeof redact(v), 'string');
});

test('clean caps long input and keeps it one block', () => {
    const out = clean(`${'a'.repeat(5000)}`, 1500);
    assert.strictEqual(out.length, 1501); // 1500 + the ellipsis
    assert.ok(out.endsWith('…'));
});

// ── Budget ────────────────────────────────────────────────────────────────────

test('the budget counts input, output and cache writes in full, cache reads at a tenth', () => {
    const b = makeBudget(1000, () => 0);
    b.spend({ input: 100, output: 50, cacheWrite: 200, cacheRead: 1000 });
    assert.strictEqual(b.used, 450);
    assert.strictEqual(b.exhausted(), false);
});

test('the budget blocks once it is spent and rolls over at the UTC day boundary', () => {
    let now = Date.parse('2026-09-19T23:59:00Z');
    const b = makeBudget(500, () => now);
    b.spend({ input: 600 });
    assert.strictEqual(b.exhausted(), true);
    now = Date.parse('2026-09-20T00:01:00Z');
    assert.strictEqual(b.exhausted(), false);
    assert.strictEqual(b.used, 0);
});

test('a budget of 0 is treated as unlimited, not as blocked', () => {
    const b = makeBudget(0, () => 0);
    b.spend({ input: 10_000_000 });
    assert.strictEqual(b.exhausted(), false);
});

// ── Triage parsing ────────────────────────────────────────────────────────────

test('a JSON verdict survives code fences and chatter around it', () => {
    assert.deepStrictEqual(parseJsonish('```json\n{"verdict":"ok"}\n```'), { verdict: 'ok' });
    assert.deepStrictEqual(parseJsonish('Sure! {"verdict":"ok"} hope that helps'), { verdict: 'ok' });
    assert.strictEqual(parseJsonish('no json here at all'), null);
});

test('an unusable verdict is rejected rather than guessed at', () => {
    for (const bad of [null, {}, { verdict: 'maybe' }, { verdict: '' }]) {
        assert.strictEqual(normaliseTriage(bad, 'bug'), null);
    }
});

test('an unknown category falls back to the one the member picked', () => {
    const out = normaliseTriage({ verdict: 'not_support', category: 'nonsense', reason: 'x' }, 'bug');
    assert.strictEqual(out.category, 'bug');
    assert.ok(CATEGORY_KEYS.includes(out.category));
});

test('"wrong category" that names the chosen category is read as ok', () => {
    const out = normaliseTriage({ verdict: 'wrong_category', category: 'bug', reason: 'x' }, 'bug');
    assert.strictEqual(out.verdict, 'ok');
});

test('the form sent to the model is redacted and labelled with the category', () => {
    const body = formatForm('license', { Problem: 'key ABCD-1234-EFGH-5678 fails', Tried: 'restart' });
    assert.match(body, /Chosen category: license \(License & Activation\)/);
    assert.ok(!body.includes('ABCD-1234'));
});

// ── Provider selection ────────────────────────────────────────────────────────

test('providers are Claude first, then only the fallbacks that have a key', () => {
    assert.deepStrictEqual(buildProviders({}).map(p => p.name), []);
    assert.deepStrictEqual(buildProviders({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }).map(p => p.name),
        ['claude', 'openai']);
    assert.deepStrictEqual(
        buildProviders({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' }).map(p => p.name),
        ['claude', 'gemini', 'openai']);
});

test('model ids come from env, with the documented cheap defaults', () => {
    const def = buildProviders({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' });
    assert.deepStrictEqual(def.map(p => p.model), ['claude-opus-5', 'gemini-3.5-flash-lite', 'gpt-5.6-luna']);
    const custom = buildProviders({ ANTHROPIC_API_KEY: 'a', AI_MODEL: 'claude-haiku-4-5' });
    assert.strictEqual(custom[0].model, 'claude-haiku-4-5');
});

// The fallback adapters get the SAME request object as Claude, so each one has to translate every
// field into its own dialect. `json` is the one that matters: triage without it comes back as
// prose, parseJsonish gives up, and "could not triage" means "let the ticket through" — the
// False-Topic gate would be off, silently, exactly when Claude and Gemini are the ones down.
test('the OpenAI fallback asks for the triage schema instead of hoping for JSON', async () => {
    const sent = [];
    const fetchImpl = async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ output_text: '{"verdict":"ok"}', usage: {} }) };
    };
    const p = openaiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const req = { system: [{ type: 'text', text: 'S' }], messages: [{ role: 'user', content: 'x' }], maxTokens: 256 };

    await p.call({ ...req, json: TRIAGE_SCHEMA });
    assert.strictEqual(sent[0].text.format.type, 'json_schema');
    assert.strictEqual(sent[0].text.format.strict, true);
    assert.deepStrictEqual(sent[0].text.format.schema, TRIAGE_SCHEMA);

    await p.call(req);                       // an answer is prose — no format may be forced on it
    assert.strictEqual(sent[1].text, undefined);
});

// ── The fallback chain ────────────────────────────────────────────────────────

const stub = (name, impl) => ({ name, model: `${name}-model`, call: impl });
const ok = (text) => async () => ({ text, usage: { input: 10, output: 5 } });
const boom = (msg) => async () => { throw new Error(msg); };

function support(providers, limit = 100_000) {
    return createSupport({ providers, kb: 'KB', budget: makeBudget(limit, () => 0), log: quiet });
}

test('the first healthy provider answers and the rest are never called', async () => {
    let geminiCalls = 0;
    const s = support([
        stub('claude', ok('from claude')),
        stub('gemini', async () => { geminiCalls++; return { text: 'x', usage: {} }; }),
    ]);
    assert.deepStrictEqual(await s.answer({ category: 'bug', ticket: 't' }), { text: 'from claude', truncated: false });
    assert.strictEqual(geminiCalls, 0);
});

test('Claude failing falls through to Gemini, then to OpenAI, in that order', async () => {
    const order = [];
    const fail = (n) => async () => { order.push(n); throw new Error(`${n} down`); };
    const s = support([
        stub('claude', fail('claude')),
        stub('gemini', fail('gemini')),
        stub('openai', async () => { order.push('openai'); return { text: 'rescued', usage: {} }; }),
    ]);
    const out = await s.answer({ category: 'bug', ticket: 't' });
    assert.strictEqual(out.text, 'rescued');
    assert.deepStrictEqual(order, ['claude', 'gemini', 'openai']);
});

test('every provider failing throws, so the caller can post "a human will look"', async () => {
    const s = support([stub('claude', boom('503')), stub('gemini', boom('429'))]);
    await assert.rejects(() => s.answer({ category: 'bug', ticket: 't' }), /429/);
});

test('with no provider configured, answer() returns null instead of throwing', async () => {
    assert.strictEqual(await support([]).answer({ category: 'bug', ticket: 't' }), null);
});

test('the spent budget blocks the call before any provider is touched', async () => {
    let calls = 0;
    const s = support([stub('claude', async () => { calls++; return { text: 'x', usage: { input: 10, output: 5 } }; })], 10);
    await s.answer({ category: 'bug', ticket: 't' });   // spends 15 > 10
    await assert.rejects(() => s.answer({ category: 'bug', ticket: 't' }), BudgetExhausted);
    assert.strictEqual(calls, 1);
});

test('a provider with bad credentials is dropped for good, not retried per ticket', async () => {
    const { DeadProvider } = require('../ai-support');
    let claudeCalls = 0;
    const s = support([
        stub('claude', async () => { claudeCalls++; throw new DeadProvider('401'); }),
        stub('gemini', ok('fallback')),
    ]);
    await s.answer({ category: 'bug', ticket: 't' });
    await s.answer({ category: 'bug', ticket: 't' });
    assert.strictEqual(claudeCalls, 1);
});

// ── Triage behaviour the owner's rules depend on ──────────────────────────────

test('triage returns the parsed verdict', async () => {
    const s = support([stub('claude', ok('{"verdict":"not_support","category":"other","reason":"Kein Support-Thema."}'))]);
    assert.deepStrictEqual(await s.triage({ category: 'other', fields: { Problem: 'gib key' } }), {
        verdict: 'not_support', category: 'other', reason: 'Kein Support-Thema.',
    });
});

test('triage failing on EVERY provider lets the ticket through (null), never blocks support', async () => {
    const s = support([stub('claude', boom('503')), stub('gemini', boom('timeout'))]);
    assert.strictEqual(await s.triage({ category: 'bug', fields: {} }), null);
});

test('triage with the budget spent also lets the ticket through', async () => {
    const s = support([stub('claude', ok('{"verdict":"ok","category":"bug","reason":"x"}'))], 5);
    await s.triage({ category: 'bug', fields: {} });
    assert.strictEqual(await s.triage({ category: 'bug', fields: {} }), null);
});

test('triage with no AI configured lets the ticket through', async () => {
    assert.strictEqual(await support([]).triage({ category: 'bug', fields: {} }), null);
});

test('unparseable triage output is treated as "could not triage", not as a rejection', async () => {
    const s = support([stub('claude', ok('I think this is fine, honestly'))]);
    assert.strictEqual(await s.triage({ category: 'bug', fields: {} }), null);
});

// ── Prompt assembly ───────────────────────────────────────────────────────────

test('the answer call sends a cached KB system block and a capped history', async () => {
    let seen = null;
    const s = support([stub('claude', async (req) => { seen = req; return { text: 'ok', usage: {} }; })]);
    // 31 turns so the newest one is from the member — the ordinary case.
    const history = Array.from({ length: 31 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    await s.answer({ category: 'bug', fields: { Problem: 'it crashes' }, history, ticket: 't' });

    assert.strictEqual(seen.system.length, 2);
    assert.deepStrictEqual(seen.system[1].cache_control, { type: 'ephemeral' });
    assert.ok(seen.system[1].text.includes('KB'));
    assert.strictEqual(seen.maxTokens, 1024);
    assert.strictEqual(seen.messages.length, 13);           // the form + the last 12 turns
    assert.strictEqual(seen.messages[0].role, 'user');
    assert.match(seen.messages[0].content, /Chosen category: bug/);
});

test('an answer is never requested with an assistant turn last', async () => {
    let seen = null;
    const s = support([stub('claude', async (req) => { seen = req; return { text: 'ok', usage: {} }; })]);
    await s.answer({ category: 'bug', history: [{ role: 'assistant', content: 'earlier reply' }], ticket: 't' });
    assert.strictEqual(seen.messages[seen.messages.length - 1].role, 'user');
});

test('the triage call carries no knowledge base — that is the whole point of it', async () => {
    let seen = null;
    const s = support([stub('claude', async (req) => { seen = req; return { text: '{"verdict":"ok","category":"bug","reason":""}', usage: {} }; })]);
    await s.triage({ category: 'bug', fields: { Problem: 'crash' } });
    assert.strictEqual(seen.system.length, 1);
    assert.ok(!seen.system[0].text.includes('KB'));
    assert.strictEqual(seen.maxTokens, 256);
    assert.ok(seen.json, 'triage must ask for structured output');
});
