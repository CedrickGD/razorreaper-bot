const test = require('node:test');
const assert = require('node:assert');
const { buildTopic, parseTopic, nextTicketNumber, ticketChannelName, checkLimits } = require('../ticket-state');

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const ch = (name, opener, hoursAgo = 1, cat = 'bug') => ({
    name,
    topic: opener === null ? null : buildTopic({ opener, cat }),
    createdTimestamp: NOW - hoursAgo * HOUR,
});

// ── topic round-trip ──────────────────────────────────────────────────────────

test('a topic survives the round trip', () => {
    const state = { opener: '947783551938592828', cat: 'scripts', ai: false, replies: 5 };
    assert.deepStrictEqual(parseTopic(buildTopic(state)), state);
});

test('defaults: a fresh ticket is AI-on with no replies yet', () => {
    assert.deepStrictEqual(parseTopic(buildTopic({ opener: '1', cat: 'install' })), {
        opener: '1', cat: 'install', ai: true, replies: 0,
    });
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
    assert.deepStrictEqual(state, { opener: '7', cat: 'bug', ai: false, replies: 2 });
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
