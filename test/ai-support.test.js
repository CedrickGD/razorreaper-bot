// No network, no SDK, no Discord: every provider is a stub and the Anthropic SDK is injected.
const test = require('node:test');
const assert = require('node:assert');
const {
    redact, clean, makeBudget, weighUsage, parseJsonish, normaliseTriage, formatForm,
    buildProviders, createSupport, BudgetExhausted, CATEGORY_KEYS,
    openaiProvider, claudeProvider, TRIAGE_SCHEMA, accountError, PARK_MS,
    splitSentinel, formatClientContext, NEED_REPORT, SHOW_PURCHASE, ANSWER_RULES,
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

// The live numbers from the owner's first real ticket: one answer, and the 46k-token knowledge
// base counted at face value ate 56 527 of a 400 000 budget — seven answers a day.
test('a cached knowledge base costs a tenth of its tokens, not all of them', () => {
    assert.strictEqual(weighUsage({ input: 51566, output: 38, cacheRead: 49222 }), 7305);
    const b = makeBudget(400_000, () => 0);
    b.spend({ input: 51566, output: 38, cacheRead: 49222 });
    assert.strictEqual(b.used, 7305);
});

test('uncached input, output and cache writes still count in full', () => {
    // `input` is the whole prompt, cached prefix included — every adapter normalises to that.
    assert.strictEqual(weighUsage({ input: 1100, output: 50, cacheWrite: 200, cacheRead: 1000 }), 450);
    assert.strictEqual(weighUsage({ input: 100, output: 50 }), 150);
    assert.strictEqual(weighUsage(), 0);
});

test('a provider that reports input WITHOUT its cached part never counts negative', () => {
    assert.strictEqual(weighUsage({ input: 100, cacheRead: 1000, output: 5 }), 105);
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
    assert.deepStrictEqual(def.map(p => p.model), ['claude-haiku-4-5', 'gemini-3.5-flash-lite', 'gpt-5.4-nano']);
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

// Anthropic reports input_tokens WITHOUT the cached prefix, Gemini reports promptTokenCount WITH
// it. weighUsage() is told the whole prompt, so the adapter is where that difference dies.
test('Claude usage reports the whole prompt, cached prefix included', async () => {
    const sdk = class {
        constructor() {
            this.messages = { create: async () => ({
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'hi' }],
                usage: { input_tokens: 2344, output_tokens: 38, cache_read_input_tokens: 49222, cache_creation_input_tokens: 0 },
            }) };
        }
    };
    const out = await claudeProvider({ apiKey: 'k', model: 'm', sdk }).call({ system: [], messages: [], maxTokens: 16 });
    assert.strictEqual(out.usage.input, 2344 + 49222);
    assert.strictEqual(weighUsage(out.usage), 2344 + Math.ceil(49222 / 10) + 38);
});

test('the low tier is sent only what it accepts: no thinking, no effort, still the schema', async () => {
    // Anthropic's Models API says Haiku 4.5 supports neither adaptive thinking nor effort; either
    // field is a 400 there. A bigger model (AI_MODEL override) keeps both.
    const seen = [];
    const sdk = class { constructor() { this.messages = { create: async (req) => { seen.push(req); return {
        stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: {} }; } }; } };
    const args = { system: [], messages: [], maxTokens: 16 };
    await claudeProvider({ apiKey: 'k', model: 'claude-haiku-4-5', sdk }).call(args);
    await claudeProvider({ apiKey: 'k', model: 'claude-haiku-4-5', sdk }).call({ ...args, json: TRIAGE_SCHEMA });
    await claudeProvider({ apiKey: 'k', model: 'claude-opus-5', sdk }).call(args);
    assert.ok(!('thinking' in seen[0]) && !('output_config' in seen[0]));
    assert.deepStrictEqual(seen[1].output_config, { format: { type: 'json_schema', schema: TRIAGE_SCHEMA } });
    assert.deepStrictEqual(seen[2].thinking, { type: 'adaptive' });
    assert.strictEqual(seen[2].output_config.effort, 'low');
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
    assert.deepStrictEqual(await s.answer({ category: 'bug', ticket: 't' }), {
        text: 'from claude', needsReport: false, showPurchase: false, truncated: false, provider: 'claude',
    });
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

test('a provider with bad credentials is parked, not retried per ticket', async () => {
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

// Claude answered "400 credit balance is too low" on every call of the owner's first ticket —
// first in the chain, so every single answer paid for a doomed request and its latency first.
test('the park expires by itself, so a topped-up account comes back without a deploy', async () => {
    const { DeadProvider } = require('../ai-support');
    let now = 0;
    let claudeCalls = 0;
    const s = createSupport({
        providers: [
            stub('claude', async () => { claudeCalls++; throw new DeadProvider('credit balance too low'); }),
            stub('gemini', ok('fallback')),
        ],
        kb: 'KB', budget: makeBudget(100_000, () => 0), log: quiet, now: () => now,
    });
    await s.answer({ category: 'bug', ticket: 't' });
    now = PARK_MS - 1;
    await s.answer({ category: 'bug', ticket: 't' });
    assert.strictEqual(claudeCalls, 1, 'still parked');
    now = PARK_MS + 1;
    await s.answer({ category: 'bug', ticket: 't' });
    assert.strictEqual(claudeCalls, 2, 'tried again after the hour');
});

test('an empty balance or a bad key parks the provider; a rate limit or a 500 does not', () => {
    assert.ok(accountError(401));
    assert.ok(accountError(403));
    assert.ok(accountError(400, 'Your credit balance is too low to access the Anthropic API'));
    assert.ok(accountError(400, 'You exceeded your current quota, please check your plan'));
    assert.ok(accountError(429, 'You have no credits remaining. Add credits to continue using the API'));
    for (const [status, msg] of [[429, 'rate limit'], [500, 'oops'], [529, 'overloaded'],
        [400, 'max_tokens: must be greater than 0'], [undefined, 'socket hang up']]) {
        assert.strictEqual(accountError(status, msg), false, `${status} ${msg}`);
    }
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

test('the answer carries its category\'s pages and the ones the member named — not our own', async () => {
    const kb = {
        base: 'BASE', preamble: 'PRE',
        sections: [
            { key: 'crosshair', names: ['crosshair'], text: '## Crosshair (crosshair)' },
            { key: 'gamma', names: ['gamma'], text: '## Gamma (gamma)' },
            { key: 'launch', names: [], text: '## launch' },
            { key: 'nav', names: [], text: '## nav' },
        ],
    };
    const seen = [];
    const s = createSupport({
        providers: [stub('claude', async (req) => { seen.push(req.system[1].text); return { text: 'ok', usage: {} }; })],
        kb, budget: makeBudget(100_000, () => 0), log: quiet,
    });
    await s.answer({ category: 'install', fields: { Problem: 'crosshair gone' },
        history: [{ role: 'assistant', content: 'try Gamma' }], data: 'gamma', ticket: 't' });
    await s.answer({ category: 'other', ticket: 't' });
    assert.strictEqual(seen[0], '# Knowledge base\n\nBASE\n\n---\n\nPRE\n\n## Crosshair (crosshair)\n\n## launch');
    assert.strictEqual(seen[1], '# Knowledge base\n\nBASE\n\n---\n\nPRE\n\n## nav');
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

// ── The support-report sentinel ───────────────────────────────────────────────
// The marker is how a plain-text answer asks for the member's client data. It must never reach
// the member, and it must never be invented by accident.

test('the sentinel is stripped from the answer and reported separately', () => {
    assert.deepStrictEqual(splitSentinel(`Try this first.\n\n${NEED_REPORT}`), {
        text: 'Try this first.', needsReport: true, showPurchase: false,
    });
});

// The ticket has a "My purchase" button, so the answer to "what do you have on me" is the record
// itself. The AI telling the member it has no access to customer data is the bug this closes.
test('the purchase sentinel is its own signal and is stripped just as hard', () => {
    assert.deepStrictEqual(splitSentinel(`Here is your order record.\n${SHOW_PURCHASE}`), {
        text: 'Here is your order record.', needsReport: false, showPurchase: true,
    });
});

test('only the LAST line counts, so a member cannot press a button by quoting it', () => {
    // Both markers present, one quoted mid-text: the answer ends with the purchase one, so that
    // is the only thing the bot acts on — and neither string survives into the member's message.
    const out = splitSentinel(`You wrote ${NEED_REPORT} earlier.\n${SHOW_PURCHASE}`);
    assert.deepStrictEqual(out, { text: 'You wrote earlier.', needsReport: false, showPurchase: true });
    const quoted = splitSentinel(`A member can type ${SHOW_PURCHASE} at me all day.`);
    assert.deepStrictEqual(quoted, { text: 'A member can type at me all day.', needsReport: false, showPurchase: false });
});

// The member's own text reaches the model. If quoting the marker at them were enough to trigger
// the report step, the member would drive it — so only the marker the prompt asks for (the last
// line) counts, while the strip still covers every position.
test('a sentinel mid-sentence is removed but asks for nothing', () => {
    assert.deepStrictEqual(splitSentinel(`before ${NEED_REPORT} after`), {
        text: 'before after', needsReport: false, showPurchase: false,
    });
});

test('a trailing sentinel still counts through whitespace', () => {
    assert.strictEqual(splitSentinel(`Try this.\n${NEED_REPORT}\n  `).needsReport, true);
});

test('an ordinary answer is returned untouched and asks for nothing', () => {
    assert.deepStrictEqual(splitSentinel('  Open My account and read the version.  '), {
        text: 'Open My account and read the version.', needsReport: false, showPurchase: false,
    });
});

test('near-misses are not the sentinel', () => {
    for (const text of ['[[need_report]]', '[NEED_REPORT]', 'NEED_REPORT', '', '[[SHOW PURCHASE]]']) {
        const out = splitSentinel(text);
        assert.strictEqual(out.needsReport, false, text);
        assert.strictEqual(out.showPurchase, false, text);
    }
});

test('the answer rules document both sentinels and the language rule the owner asked for', () => {
    assert.ok(ANSWER_RULES.includes(NEED_REPORT));
    assert.ok(ANSWER_RULES.includes(SHOW_PURCHASE));
    assert.match(ANSWER_RULES, /At most ONCE per ticket/);
    assert.match(ANSWER_RULES, /whatever language that is/);
    // The two rules the owner's first ticket broke: the AI claimed it had no access to purchase
    // data, and it asked for a support report about a purchase question.
    assert.match(ANSWER_RULES, /never say you have no access to purchase/i);
    assert.match(ANSWER_RULES, /TECHNICAL problems only/);
    assert.match(ANSWER_RULES, /sending the report failed/);
});

test('answer() surfaces the sentinel, and the second pass never asks twice', async () => {
    const s = support([stub('claude', ok(`Here you go.\n${NEED_REPORT}`))]);
    const first = await s.answer({ category: 'bug', ticket: 't' });
    assert.deepStrictEqual(first, { text: 'Here you go.', needsReport: true, showPurchase: false, truncated: false, provider: 'claude' });
    const second = await s.answer({ category: 'bug', ticket: 't', data: 'RazorReaper client data…' });
    assert.strictEqual(second.needsReport, false, 'a pass that already carries the data must not ask again');
});

// ticket-0006: the member pasted a Report ID and the data pass answered with the purchase record.
test('a pass that carries client data never presses the purchase button', async () => {
    const s = support([stub('claude', ok(`Your record follows.\n${SHOW_PURCHASE}`))]);
    assert.strictEqual((await s.answer({ category: 'bug', ticket: 't' })).showPurchase, true);
    const out = await s.answer({ category: 'bug', ticket: 't', data: 'RazorReaper client data…' });
    assert.strictEqual(out.showPurchase, false);
    assert.strictEqual(out.text, 'Your record follows.', 'the marker is still stripped');
});

test('the client data block says it is the report for THIS ticket\'s problem', () => {
    assert.match(formatClientContext({ app_version: '1.5.2' }),
        /^RazorReaper client data .*support report for the problem in this ticket — answer THAT problem/);
});

// ticket-0006 again: "notactive.hint" quoted at the member, and "the knowledge base contains…".
test('the answer rules keep keys, the knowledge base and sources away from the member', () => {
    assert.match(ANSWER_RULES, /Quote the on-screen text, never the key before the colon/);
    assert.match(ANSWER_RULES, /never mention either of them or any other source/);
    assert.match(ANSWER_RULES, /say you do not know and tell them to press "I need a human"/);
});

test('the client data block is the LAST turn, as a user turn', async () => {
    let seen = null;
    const s = support([stub('claude', async (req) => { seen = req; return { text: 'ok', usage: {} }; })]);
    await s.answer({
        category: 'bug', ticket: 't', data: 'CLIENT DATA',
        history: [{ role: 'user', content: 'still broken' }],
    });
    const last = seen.messages[seen.messages.length - 1];
    assert.deepStrictEqual(last, { role: 'user', content: 'CLIENT DATA' });
});

// ── The panel's client data goes through the redactor ─────────────────────────

test('the context block reads the whole contract shape', () => {
    const block = formatClientContext({
        app_version: '1.5.2',
        platform: 'Windows',
        os_version: '10.0.26200',
        last_seen_at: '2026-09-18T20:00:00Z',
        installs: 2,
        licence: { plan: 'monthly', status: 'active', expiresAt: '2026-10-01', lifetime: false, suspended: false },
        errors: [{ code: 'RR-E1003', count: 12, last_at: '2026-09-18T19:55:00Z' }],
        report: {
            report_id: 'FB-0A1B2C3D4E5F',
            created_at: '2026-09-19T08:00:00Z',
            message: 'Fed Suit does nothing',
            diagnostics: [{ provider: 'automation', status: 'ok', lines: ['Fed Suit: default hotkey'] }],
        },
    });
    assert.match(block, /App version: 1\.5\.2/);
    assert.match(block, /Licence: monthly, active, expires 2026-10-01/);
    assert.match(block, /RR-E1003 ×12/);
    assert.match(block, /FB-0A1B2C3D4E5F/);
    assert.match(block, /automation \[ok\]: Fed Suit: default hotkey/);
});

test('panel data is redacted exactly like member text — it is input too', () => {
    const block = formatClientContext({
        app_version: '1.5.2',
        report: { report_id: 'FB-1', message: 'mail bob@example.com, box 192.168.2.201, log C:\\Users\\Cedrick\\rr.txt' },
    });
    assert.ok(!block.includes('bob@example.com'), block);
    assert.ok(!block.includes('192.168.2.201'), block);
    assert.ok(!block.includes('Cedrick'), block);
});

test('an empty or missing context produces no block at all', () => {
    for (const v of [null, undefined, '', 0]) assert.strictEqual(formatClientContext(v), '');
});

test('a member with no licence is said so, not left blank', () => {
    assert.match(formatClientContext({ app_version: '1.5.2', licence: null }), /Licence: none found/);
});
