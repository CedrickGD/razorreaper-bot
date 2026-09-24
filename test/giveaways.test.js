const test = require('node:test');
const assert = require('node:assert');
const { parseDuration, pickWinners, contestStandings, dueItems, newStore, parseStore, STANDINGS_EVERY_MS } = require('../giveaways');

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

test('parseDuration: units and combos', () => {
    assert.strictEqual(parseDuration('30m'), 30 * MIN);
    assert.strictEqual(parseDuration('12h'), 12 * HOUR);
    assert.strictEqual(parseDuration('2d'), 2 * DAY);
    assert.strictEqual(parseDuration('1w'), 7 * DAY);
    assert.strictEqual(parseDuration('1d12h'), 36 * HOUR);
    assert.strictEqual(parseDuration(' 1D 30M '), DAY + 30 * MIN);
});

test('parseDuration: limits are 1 minute and 60 days, inclusive', () => {
    assert.strictEqual(parseDuration('1m'), MIN);
    assert.strictEqual(parseDuration('60d'), 60 * DAY);
    assert.strictEqual(parseDuration('0m'), null);
    assert.strictEqual(parseDuration('60d1m'), null);
    assert.strictEqual(parseDuration('9w'), null);
    assert.strictEqual(parseDuration('9'.repeat(400) + 'd'), null);
});

test('parseDuration: anything else is refused', () => {
    for (const bad of ['', null, undefined, '10', 'm', '1s', '1.5h', '-1h', '1h-', 'tomorrow', '1h abc']) {
        assert.strictEqual(parseDuration(bad), null, String(bad));
    }
});

// Always takes the first remaining entrant: the draw order is then the pool order.
const first = () => 0;

test('pickWinners: n distinct winners, never a duplicate entrant', () => {
    assert.deepStrictEqual(pickWinners(['a', 'b', 'a', 'c', 'b'], 3, first), ['a', 'b', 'c']);
    const seen = pickWinners(['a', 'b', 'c', 'd', 'e'], 4);
    assert.strictEqual(new Set(seen).size, 4);
});

test('pickWinners: fewer entrants than winners → everyone wins; none → none', () => {
    assert.deepStrictEqual(pickWinners(['a', 'b'], 5, first).sort(), ['a', 'b']);
    assert.deepStrictEqual(pickWinners([], 3, first), []);
});

test('pickWinners: uses the injected randomInt over the shrinking pool', () => {
    const calls = [];
    const last = n => { calls.push(n); return n - 1; };
    assert.deepStrictEqual(pickWinners(['a', 'b', 'c', 'd'], 2, last), ['d', 'c']);
    assert.deepStrictEqual(calls, [4, 3]);
});

test('pickWinners: a reroll skips the previous winners while others are left', () => {
    assert.deepStrictEqual(pickWinners(['a', 'b', 'c'], 1, first, ['a']), ['b']);
    assert.deepStrictEqual(pickWinners(['a', 'b', 'c'], 2, first, ['a', 'b']), ['c', 'a']);
    assert.deepStrictEqual(pickWinners(['a'], 1, first, ['a']), ['a']);
});

const T0 = Date.parse('2026-09-24T12:00:00Z');
const contest = { startsAt: T0, endsAt: T0 + DAY };
const join = (inviter, at, extra = {}) => ({ inviter, code: 'x', via: 'invite', at: new Date(at).toISOString(), left: false, fake: false, ...extra });
const store = joins => ({ v: 1, earlier: {}, joins });

test('contestStandings: only invite joins inside the window count, edges included', () => {
    const rows = contestStandings(store({
        m1: join('A', T0 - 1),              // before
        m2: join('A', T0),                  // start edge
        m3: join('A', T0 + DAY),            // end edge
        m4: join('A', T0 + DAY + 1),        // after
        m5: join('B', T0 + HOUR, { via: 'vanity', inviter: null }),
        m6: join(null, T0 + HOUR, { via: 'unknown' }),
    }), contest, T0 + 2 * DAY);
    assert.deepStrictEqual(rows.map(r => [r.inviterId, r.count, r.rank]), [['A', 2, 1]]);
});

test('contestStandings: fake and left joins do not count', () => {
    const rows = contestStandings(store({
        m1: join('A', T0 + HOUR, { fake: true }),
        m2: join('A', T0 + HOUR, { left: true }),
        m3: join('B', T0 + HOUR),
    }), contest, T0 + 2 * DAY);
    assert.deepStrictEqual(rows.map(r => r.inviterId), ['B']);
});

test('contestStandings: ties go to whoever reached the count first, then id', () => {
    const rows = contestStandings(store({
        m1: join('B', T0 + 1 * HOUR), m2: join('B', T0 + 5 * HOUR),
        m3: join('A', T0 + 2 * HOUR), m4: join('A', T0 + 6 * HOUR),
        m5: join('C', T0 + 3 * HOUR), m6: join('C', T0 + 4 * HOUR),
        m7: join('E', T0 + 7 * HOUR), m8: join('D', T0 + 7 * HOUR),
        m9: join('F', T0 + 8 * HOUR), m10: join('F', T0 + 9 * HOUR), m11: join('F', T0 + 10 * HOUR),
    }), contest, T0 + 2 * DAY);
    assert.deepStrictEqual(rows.map(r => `${r.rank}${r.inviterId}${r.count}`), ['1F3', '2C2', '3B2', '4A2', '5D1', '6E1']);
});

test('contestStandings: a rejoin counts once, for whoever invited them this time', () => {
    // recordJoin replaces the member's record, so the store only ever holds the latest join
    const rows = contestStandings(store({ m1: join('B', T0 + HOUR) }), contest, T0 + 2 * DAY);
    assert.deepStrictEqual(rows.map(r => [r.inviterId, r.count]), [['B', 1]]);
    assert.deepStrictEqual(contestStandings(store({}), contest, T0), []);
    assert.deepStrictEqual(contestStandings(null, contest, T0), []);
});

test('dueItems: ended-but-active giveaways, a due contest, standings every 10 minutes', () => {
    const s = newStore();
    s.giveaways = [
        { messageId: '1', state: 'active', endsAt: 100 },
        { messageId: '2', state: 'active', endsAt: 101 },
        { messageId: '3', state: 'ended', endsAt: 50 },
        { messageId: '4', state: 'cancelled', endsAt: 50 },
    ];
    assert.deepStrictEqual(dueItems(s, 100).giveaways.map(g => g.messageId), ['1']);
    assert.strictEqual(dueItems(s, 100).contest, null);

    s.contest = { state: 'active', startsAt: 0, endsAt: DAY, lastStandingsAt: 0 };
    assert.strictEqual(dueItems(s, STANDINGS_EVERY_MS - 1).standings, null);
    assert.strictEqual(dueItems(s, STANDINGS_EVERY_MS).standings, s.contest);
    assert.strictEqual(dueItems(s, STANDINGS_EVERY_MS).contest, null);
    assert.strictEqual(dueItems(s, DAY).contest, s.contest);
    assert.strictEqual(dueItems(s, DAY).standings, null);
    s.contest.state = 'ended';
    assert.deepStrictEqual([dueItems(s, DAY).contest, dueItems(s, DAY).standings], [null, null]);
});

test('parseStore: a written store round-trips, anything else is null', () => {
    const s = newStore();
    s.giveaways.push({ messageId: '1', state: 'active' });
    assert.deepStrictEqual(parseStore(JSON.stringify(s)), s);
    for (const bad of ['', '{', 'null', '[]', '{"v":2,"giveaways":[],"contest":null,"pastContests":[]}',
        '{"v":1,"giveaways":{},"contest":null,"pastContests":[]}', '{"v":1,"giveaways":[],"contest":[],"pastContests":[]}',
        '{"v":1,"giveaways":[],"pastContests":[]}']) {
        assert.strictEqual(parseStore(bad), null, bad);
    }
});
