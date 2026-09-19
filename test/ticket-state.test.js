const test = require('node:test');
const assert = require('node:assert');
const {
    buildTopic, parseTopic, nextTicketNumber, ticketChannelName, checkLimits,
    slowmodeSeconds, deletableTickets, makeWaiting, SLOWMODE_MAX,
} = require('../ticket-state');

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const ch = (name, opener, hoursAgo = 1, cat = 'bug') => ({
    name,
    topic: opener === null ? null : buildTopic({ opener, cat }),
    createdTimestamp: NOW - hoursAgo * HOUR,
});

// ── topic round-trip ──────────────────────────────────────────────────────────

test('a topic survives the round trip', () => {
    const state = { opener: '947783551938592828', cat: 'scripts', ai: false, replies: 5, from: 1_700_000_100, closed: 1_700_000_900 };
    assert.deepStrictEqual(parseTopic(buildTopic(state)), state);
});

test('defaults: a fresh ticket is AI-on, unstamped and never closed', () => {
    assert.deepStrictEqual(parseTopic(buildTopic({ opener: '1', cat: 'install' })), {
        opener: '1', cat: 'install', ai: true, replies: 0, from: 0, closed: 0,
    });
});

test('from and closed stay out of the topic until they exist', () => {
    assert.strictEqual(buildTopic({ opener: '1', cat: 'bug' }), 'rr-ticket opener=1 cat=bug ai=on replies=0');
    assert.match(buildTopic({ opener: '1', cat: 'bug', closed: 42 }), / closed=42$/);
});

test('topics that are not ours parse to null, whatever they contain', () => {
    for (const bad of [null, undefined, '', 42, 'Support ticket for @bob', 'rr-ticketish opener=1',
        'rr-ticket cat=bug ai=on', 'rr-ticket opener=notanid cat=bug']) {
        assert.strictEqual(parseTopic(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
});

test('a hand-mangled replies counter falls back to 0 instead of NaN', () => {
    assert.strictEqual(parseTopic('rr-ticket opener=1 cat=bug ai=on replies=lots').replies, 0);
    assert.strictEqual(parseTopic('rr-ticket opener=1 cat=bug ai=on replies=-3').replies, 0);
});

test('an unknown key in the topic is ignored, the rest still reads', () => {
    const state = parseTopic('rr-ticket opener=7 cat=bug ai=off replies=2 claimed=9');
    assert.deepStrictEqual(state, { opener: '7', cat: 'bug', ai: false, replies: 2, from: 0, closed: 0 });
});

// ── numbering ─────────────────────────────────────────────────────────────────

test('the next number is one past the highest ticket OR closed channel', () => {
    assert.strictEqual(nextTicketNumber(['ticket-0007', 'closed-0042', 'general', 'ticket-0003']), 43);
});

test('numbering starts at 1 in a server that has never had a ticket', () => {
    assert.strictEqual(nextTicketNumber([]), 1);
    assert.strictEqual(nextTicketNumber(['general', 'verify', 'closed-tickets-archive']), 1);
});

test('ticket numbers are padded to four digits', () => {
    assert.strictEqual(ticketChannelName(7), 'ticket-0007');
    assert.strictEqual(ticketChannelName(12345), 'ticket-12345');
});

// ── limits ────────────────────────────────────────────────────────────────────

test('a member with no tickets may open one', () => {
    assert.deepStrictEqual(checkLimits([ch('ticket-0001', '999')], '1', NOW), { ok: true });
});

test('one open ticket blocks a second, and names the one already open', () => {
    const res = checkLimits([ch('ticket-0001', '1')], '1', NOW);
    assert.deepStrictEqual(res, { ok: false, reason: 'open', open: 'ticket-0001' });
});

test('three tickets inside 24h blocks the fourth even when all are closed', () => {
    const channels = [ch('closed-0001', '1', 2), ch('closed-0002', '1', 5), ch('closed-0003', '1', 20)];
    assert.deepStrictEqual(checkLimits(channels, '1', NOW), { ok: false, reason: 'daily', count: 3 });
});

test('tickets older than 24h do not count toward the daily limit', () => {
    const channels = [ch('closed-0001', '1', 25), ch('closed-0002', '1', 48), ch('closed-0003', '1', 30)];
    assert.deepStrictEqual(checkLimits(channels, '1', NOW), { ok: true });
});

test('someone else\'s tickets never count against you', () => {
    const channels = [ch('ticket-0001', '2'), ch('closed-0002', '2', 2), ch('closed-0003', '2', 3)];
    assert.deepStrictEqual(checkLimits(channels, '1', NOW), { ok: true });
});

test('channels without one of our topics are invisible to the limits', () => {
    // Ticket Tool leftovers and hand-made ticket channels have no rr-ticket topic.
    const channels = [ch('ticket-0001', null), ch('closed-0002', null, 2)];
    assert.deepStrictEqual(checkLimits(channels, '1', NOW), { ok: true });
});

test('the limits are configurable (staff could be given more headroom)', () => {
    const channels = [ch('ticket-0001', '1'), ch('closed-0002', '1', 2)];
    assert.deepStrictEqual(checkLimits(channels, '1', NOW, { maxOpen: 2, maxPerDay: 5 }), { ok: true });
});

// ── Slowmode ──────────────────────────────────────────────────────────────────
// A bad env var here makes channels.create() throw, which means no ticket at all — so the clamp
// matters more than the number it clamps.

test('the slowmode default survives a missing or blank env var', () => {
    for (const v of [undefined, null, '', '   ']) assert.strictEqual(slowmodeSeconds(v), 45);
});

test('nonsense and negative slowmode fall back instead of throwing later', () => {
    for (const v of ['abc', '-5', NaN, {}]) assert.strictEqual(slowmodeSeconds(v), 45);
});

test('slowmode is clamped to what Discord actually accepts', () => {
    assert.strictEqual(slowmodeSeconds('999999'), SLOWMODE_MAX);
    assert.strictEqual(slowmodeSeconds('0'), 0);          // 0 is a real choice: no cooldown
    assert.strictEqual(slowmodeSeconds('30.9'), 30);
});

// ── Auto-delete ───────────────────────────────────────────────────────────────

const closedCh = (name, secondsAgo, extra = {}) => ({
    id: name,
    name,
    topic: buildTopic({ opener: '1', cat: 'bug', ai: false, closed: Math.floor(NOW / 1000) - secondsAgo, ...extra }),
});

test('a ticket closed longer ago than the window is deleted', () => {
    const due = deletableTickets([closedCh('closed-0001', 25 * 3600)], { now: NOW, hours: 24 });
    assert.deepStrictEqual(due.map(c => c.name), ['closed-0001']);
});

test('a ticket closed inside the window is left alone', () => {
    assert.deepStrictEqual(deletableTickets([closedCh('closed-0002', 3600)], { now: NOW, hours: 24 }), []);
});

test('0 hours means never, whatever is due', () => {
    assert.deepStrictEqual(deletableTickets([closedCh('closed-0003', 999 * 3600)], { now: NOW, hours: 0 }), []);
});

test('the sweep only ever touches closed-NNNN channels carrying one of our topics', () => {
    const old = Math.floor(NOW / 1000) - 99 * 3600;
    const channels = [
        { id: 'a', name: 'closed-shop', topic: buildTopic({ opener: '1', cat: 'bug', closed: old }) },  // not a ticket name
        { id: 'b', name: 'ticket-0004', topic: buildTopic({ opener: '1', cat: 'bug', closed: old }) },  // still open
        { id: 'c', name: 'closed-0005', topic: 'Ticket Tool leftover' },                                 // not our topic
        { id: 'd', name: 'closed-0006', topic: null },
        { id: 'e', name: 'closed-0007', topic: buildTopic({ opener: '1', cat: 'bug', ai: false }) },      // closed before this shipped
    ];
    assert.deepStrictEqual(deletableTickets(channels, { now: NOW, hours: 1 }), []);
});

// ── Waiting for the support report ────────────────────────────────────────────

test('a ticket waits from the moment the report was asked for, then stops', () => {
    let now = NOW;
    const w = makeWaiting(30 * 60 * 1000, () => now);
    assert.strictEqual(w.active('c1'), null);
    w.start('c1');
    assert.strictEqual(w.active('c1').since, NOW);
    w.stop('c1');
    assert.strictEqual(w.active('c1'), null);
});

test('a wait expires by itself and cleans up after the 30 minutes', () => {
    let now = NOW;
    const w = makeWaiting(30 * 60 * 1000, () => now);
    w.start('c1');
    now = NOW + 29 * 60 * 1000;
    assert.ok(w.active('c1'));
    now = NOW + 31 * 60 * 1000;
    assert.strictEqual(w.active('c1'), null);
    assert.strictEqual(w.size, 0);
});

test('waiting is per ticket — one member waiting never silences another ticket', () => {
    const w = makeWaiting(1000, () => NOW);
    w.start('c1');
    assert.strictEqual(w.active('c2'), null);
    assert.ok(w.active('c1'));
});
