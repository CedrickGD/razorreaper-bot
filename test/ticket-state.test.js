const test = require('node:test');
const assert = require('node:assert');
const {
    buildTopic, parseTopic, rebuildTicketState, nextTicketNumber, ticketChannelName, checkLimits,
    slowmodeSeconds, deletableTickets, makeWaiting, parseBotCommand,
    SLOWMODE_MAX, TICKET_BUTTONS, TICKET_COMMANDS,
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

// ── what a restart lost ───────────────────────────────────────────────────────
// A deploy restarted the bot in the middle of the owner's first real ticket. Nothing that changes
// while a ticket is open may cost a channel edit any more, so it is read back out of the bot's
// own control messages — and a button is only live while what it asks for is still open.

let clock = NOW;
const botSays = (buttons = [], ts = (clock += 1000)) => ({ bot: true, text: false, buttons, ts });
const botAnswer = (ts = (clock += 1000)) => ({ bot: true, text: true, buttons: [], ts });
const member = (ts = (clock += 1000)) => ({ bot: false, text: true, buttons: [], ts });
const btn = (id, disabled = false) => ({ id, disabled });

test('a ticket nobody interrupted is AI-on, with its answers counted', () => {
    assert.deepStrictEqual(rebuildTicketState([botSays(), member(), botAnswer(), member(), botAnswer()]), {
        ai: true, replies: 2, reportAsked: false, waitingSince: 0, closedAt: 0, sawHandoff: false,
    });
});

test('nothing at all is a fresh ticket, not a broken one', () => {
    assert.deepStrictEqual(rebuildTicketState(), {
        ai: true, replies: 0, reportAsked: false, waitingSince: 0, closedAt: 0, sawHandoff: false,
    });
});

test('a live "Re-enable AI" button means the AI stepped aside', () => {
    const state = rebuildTicketState([botAnswer(), botSays([btn(TICKET_BUTTONS.aiOn)])]);
    assert.strictEqual(state.ai, false);
});

test('a greyed-out one means it was brought back, and the reply cap started over', () => {
    const state = rebuildTicketState([
        ...Array.from({ length: 8 }, () => botAnswer()),
        botSays([btn(TICKET_BUTTONS.aiOn, true)]),   // pressed: the hand-off is spent
        member(), botAnswer(),
    ]);
    assert.strictEqual(state.ai, true);
    assert.strictEqual(state.replies, 1, 'the eight answers before the re-enable are a closed round');
});

test('the newest hand-off wins, however often the AI went off and on', () => {
    const state = rebuildTicketState([
        botSays([btn(TICKET_BUTTONS.aiOn, true)]), botAnswer(),
        botSays([btn(TICKET_BUTTONS.aiOn)]),
    ]);
    assert.strictEqual(state.ai, false);
});

test('a live "I\'ve sent it" button means the ticket is still waiting for the report', () => {
    const asked = botSays([btn(TICKET_BUTTONS.reportSent)]);
    const state = rebuildTicketState([botAnswer(), asked]);
    assert.deepStrictEqual([state.reportAsked, state.waitingSince], [true, asked.ts]);
});

test('an answered report prompt is remembered as asked, but waits for nothing', () => {
    const skipped = rebuildTicketState([botSays([btn(TICKET_BUTTONS.reportSent, true)])]);
    assert.deepStrictEqual([skipped.reportAsked, skipped.waitingSince], [true, 0]);
    // The Report ID route never touches the buttons — the answer that followed it is the proof.
    const answered = rebuildTicketState([botSays([btn(TICKET_BUTTONS.reportSent)]), botAnswer()]);
    assert.deepStrictEqual([answered.reportAsked, answered.waitingSince], [true, 0]);
});

// The close renames the channel in an edit that is deliberately not awaited, so for a while a
// closed ticket is still called ticket-NNNN. The bot's own close message is what knows better.
test('the "Ticket closed" message is the close, whatever the channel is still called', () => {
    const closed = botSays([btn(TICKET_BUTTONS.del)]);
    const state = rebuildTicketState([botAnswer(), closed]);
    assert.deepStrictEqual([state.closedAt, state.ai], [closed.ts, false]);
});

test('members and other bots write no state at all', () => {
    const state = rebuildTicketState([
        member(), { bot: false, text: false, buttons: [btn(TICKET_BUTTONS.aiOn)], ts: NOW },
        { bot: true, text: false, buttons: [btn('verify:start')], ts: NOW + 1 },
    ]);
    assert.deepStrictEqual(state, { ai: true, replies: 0, reportAsked: false, waitingSince: 0, closedAt: 0, sawHandoff: false });
});

// hydrateTicket may not trust a FULL window of messages on its own — the hand-off could have
// scrolled out of it. It may trust one it can see: the scan returns the newest messages, so a
// hand-off inside it is the newest in the channel. That difference is this flag.
test('a hand-off that was seen says so, so a full window is not distrusted twice', () => {
    assert.strictEqual(rebuildTicketState([botAnswer(), member()]).sawHandoff, false);
    assert.strictEqual(rebuildTicketState([botSays([btn(TICKET_BUTTONS.aiOn)])]).sawHandoff, true);
    const back = rebuildTicketState([botSays([btn(TICKET_BUTTONS.aiOn, true)]), member(), botAnswer()]);
    assert.deepStrictEqual([back.ai, back.sawHandoff], [true, true], 're-enabled, and on evidence');
});

// ── numbering ─────────────────────────────────────────────────────────────────

test('the next number is one past the highest ticket OR closed channel', () => {
    assert.strictEqual(nextTicketNumber(['ticket-0007', 'closed-0042', 'general', 'ticket-0003']), 43);
});

test('numbering starts at 1 in a server that has never had a ticket', () => {
    assert.strictEqual(nextTicketNumber([]), 1);
    assert.strictEqual(nextTicketNumber(['general', 'verify', 'closed-tickets-archive']), 1);
});

// Auto-delete removes closed channels, so the channel list stops being the whole history of the
// numbers handed out. Without the floor a swept server starts again at 1 and two different
// tickets end up sharing a number — and a #ticket-log title.
test('a number the channels have forgotten is not handed out twice', () => {
    assert.strictEqual(nextTicketNumber(['general'], 42), 43);
    assert.strictEqual(nextTicketNumber(['ticket-0007'], 42), 43);
    assert.strictEqual(nextTicketNumber(['closed-0099'], 42), 100, 'the channels may know more');
    for (const floor of [0, -5, NaN, undefined, null]) {
        assert.strictEqual(nextTicketNumber(['ticket-0007'], floor), 8, String(floor));
    }
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

// ── limits, per category ──────────────────────────────────────────────────────
// The owner asked for one open ticket PER CATEGORY: a licence question and a bug report are two
// conversations, and closing one to ask the other is what he did not want to do any more.

test('an open ticket only blocks its own category', () => {
    const channels = [ch('ticket-0001', '1', 1, 'license')];
    assert.deepStrictEqual(checkLimits(channels, '1', NOW, { cat: 'bug' }), { ok: true });
    assert.deepStrictEqual(checkLimits(channels, '1', NOW, { cat: 'license' }),
        { ok: false, reason: 'open', open: 'ticket-0001' });
});

test('a topic from before categories existed counts as "other"', () => {
    const legacy = { name: 'ticket-0001', topic: 'rr-ticket opener=1 ai=on replies=0', createdTimestamp: NOW - HOUR };
    assert.deepStrictEqual(checkLimits([legacy], '1', NOW, { cat: 'other' }),
        { ok: false, reason: 'open', open: 'ticket-0001' });
    assert.deepStrictEqual(checkLimits([legacy], '1', NOW, { cat: 'bug' }), { ok: true });
});

test('a ticket this process has closed is not open, whatever the channel is still called', () => {
    // The close rename is not awaited any more — it can sit in Discord's queue for minutes.
    const closing = { ...ch('ticket-0001', '1', 1, 'bug'), closed: true };
    assert.deepStrictEqual(checkLimits([closing], '1', NOW, { cat: 'bug' }), { ok: true });
    assert.deepStrictEqual(checkLimits([{ ...closing, closed: false }], '1', NOW, { cat: 'bug' }),
        { ok: false, reason: 'open', open: 'ticket-0001' });
});

test('without a category every open ticket still counts (the old behaviour)', () => {
    const channels = [ch('ticket-0001', '1', 1, 'license')];
    assert.deepStrictEqual(checkLimits(channels, '1', NOW), { ok: false, reason: 'open', open: 'ticket-0001' });
});

test('the daily cap still bites, one category at a time', () => {
    const channels = [ch('closed-0001', '1', 2, 'bug'), ch('closed-0002', '1', 5, 'license'), ch('closed-0003', '1', 6, 'install')];
    assert.deepStrictEqual(checkLimits(channels, '1', NOW, { cat: 'scripts' }), { ok: false, reason: 'daily', count: 3 });
    // …and a cap derived from the number of categories leaves room for one of each.
    assert.deepStrictEqual(checkLimits(channels, '1', NOW, { cat: 'scripts', maxPerDay: 6 }), { ok: true });
});

// ── "@bot close" ──────────────────────────────────────────────────────────────

test('a mention at the start of the message is a command', () => {
    for (const text of ['<@42> close', '<@!42> close', '  <@42>   /CLOSE  ']) {
        assert.deepStrictEqual(parseBotCommand(text, '42'), { action: 'close', reason: '' }, text);
    }
});

test('everything after the command word is the reason', () => {
    assert.deepStrictEqual(parseBotCommand('<@42> close solved, thanks', '42'),
        { action: 'close', reason: 'solved, thanks' });
    assert.deepStrictEqual(parseBotCommand('<@42> transcript', '42'), { action: 'transcript', reason: '' });
});

test('all five commands are reachable this way', () => {
    for (const c of TICKET_COMMANDS) {
        assert.deepStrictEqual(parseBotCommand(`<@42> ${c}`, '42'), { action: c, reason: '' });
    }
});

test('a mention with an unknown word asks for the list, not for nothing', () => {
    for (const text of ['<@42> foo', '<@42>', '<@42> /', '<@42> closed']) {
        assert.deepStrictEqual(parseBotCommand(text, '42'), { action: '', reason: '' }, text);
    }
});

test('a mention that is not at the start is a sentence about the bot, not an order', () => {
    for (const text of ['ask <@42> close', 'close <@42>', 'please <@42> delete this']) {
        assert.strictEqual(parseBotCommand(text, '42'), null, text);
    }
});

// Staff picking "@RazorReaper" out of the autocomplete usually get the bot's MANAGED ROLE, not
// its user — same name, different mention — and a close that silently does nothing is the result.
test('the bot\'s own role mention is the bot', () => {
    assert.deepStrictEqual(parseBotCommand('<@&7> close', '42', '7'), { action: 'close', reason: '' });
    assert.strictEqual(parseBotCommand('<@&8> close', '42', '7'), null, 'somebody else\'s role');
    assert.strictEqual(parseBotCommand('<@&7> close', '42'), null, 'no role to compare against');
});

test('another bot\'s mention, or none at all, is none of our business', () => {
    assert.strictEqual(parseBotCommand('<@99> close', '42'), null);
    assert.strictEqual(parseBotCommand('close', '42'), null);
    assert.strictEqual(parseBotCommand('', '42'), null);
    assert.strictEqual(parseBotCommand(null, '42'), null);
    // No bot id (the gateway has not handed us one yet) must never match either.
    assert.strictEqual(parseBotCommand('<@42> close', ''), null);
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

// The close writes its stamp in the same edit as the rename, and that edit is no longer awaited:
// until it lands, the only thing that knows when the ticket closed is the bot itself.
test('a close this process remembers counts even before the stamp lands', () => {
    const channels = [{ id: 'c1', name: 'closed-0008', topic: buildTopic({ opener: '1', cat: 'bug' }) }];
    const closedAt = () => NOW - 25 * HOUR;
    assert.deepStrictEqual(deletableTickets(channels, { now: NOW, hours: 24 }), [], 'no stamp, nothing known');
    assert.deepStrictEqual(deletableTickets(channels, { now: NOW, hours: 24, closedAt }).map(c => c.id), ['c1']);
    assert.deepStrictEqual(deletableTickets(channels, { now: NOW, hours: 48, closedAt }), [], 'still inside the window');
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

// A wait read back out of the history after a restart has already been running for a while.
test('a rebuilt wait expires when it was always going to, not 30 minutes later', () => {
    let now = NOW;
    const w = makeWaiting(30 * 60 * 1000, () => now);
    w.start('c1', NOW - 29 * 60 * 1000);
    assert.ok(w.active('c1'), 'one minute left');
    now = NOW + 2 * 60 * 1000;
    assert.strictEqual(w.active('c1'), null);
});

test('waiting is per ticket — one member waiting never silences another ticket', () => {
    const w = makeWaiting(1000, () => NOW);
    w.start('c1');
    assert.strictEqual(w.active('c2'), null);
    assert.ok(w.active('c1'));
});
