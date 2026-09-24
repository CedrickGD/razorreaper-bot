const test = require('node:test');
const assert = require('node:assert');
const {
    diffInvites, newStore, parseStore, isFake, recordJoin, recordLeave, countsFor, leaderboard,
} = require('../invite-tracker');

const inv = (uses, inviterId) => ({ uses, inviterId });
const DAY = 86_400_000;

test('diffInvites: the one invite whose uses went up is the one', () => {
    const before = { a: inv(3, 'A'), b: inv(1, 'B') };
    const after = { a: inv(3, 'A'), b: inv(2, 'B') };
    assert.deepStrictEqual(diffInvites(before, after, null, null), { via: 'invite', code: 'b', inviter: 'B' });
});

test('diffInvites: an invite created since the last snapshot counts from 0', () => {
    assert.deepStrictEqual(diffInvites({ a: inv(3, 'A') }, { a: inv(3, 'A'), n: inv(1, 'N') }, null, null),
        { via: 'invite', code: 'n', inviter: 'N' });
});

test('diffInvites: nothing went up, two went up, or no snapshot → unknown, never a guess', () => {
    const before = { a: inv(1, 'A'), b: inv(1, 'B') };
    assert.strictEqual(diffInvites(before, before, null, null).via, 'unknown');
    assert.strictEqual(diffInvites(before, { a: inv(2, 'A'), b: inv(2, 'B') }, null, null).via, 'unknown');
    assert.strictEqual(diffInvites(null, before, null, null).via, 'unknown');
    assert.strictEqual(diffInvites(before, null, null, null).via, 'unknown');
});

test('diffInvites: only the vanity count went up → vanity; vanity plus an invite → unknown', () => {
    const before = { a: inv(1, 'A') };
    assert.deepStrictEqual(diffInvites(before, before, 10, 11), { via: 'vanity', code: null, inviter: null });
    assert.strictEqual(diffInvites(before, { a: inv(2, 'A') }, 10, 11).via, 'unknown');
    assert.strictEqual(diffInvites(before, before, null, 11).via, 'unknown');
});

test('diffInvites: an invite deleted between the snapshot and the join is never the answer', () => {
    // a one-use invite that got used up disappears instead of counting up
    assert.strictEqual(diffInvites({ a: inv(0, 'A'), b: inv(4, 'B') }, { b: inv(4, 'B') }, null, null).via, 'unknown');
    assert.deepStrictEqual(diffInvites({ a: inv(0, 'A'), b: inv(4, 'B') }, { b: inv(5, 'B') }, null, null),
        { via: 'invite', code: 'b', inviter: 'B' });
});

test('isFake: younger than the limit is fake, exactly the limit is not', () => {
    const joined = 100 * DAY;
    assert.strictEqual(isFake(joined - 7 * DAY + 1, joined, 7), true);
    assert.strictEqual(isFake(joined - 7 * DAY, joined, 7), false);
    assert.strictEqual(isFake(joined - 30 * DAY, joined, 7), false);
});

test('earlier baseline: current uses per inviter, and total = regular + earlier', () => {
    const store = newStore({ a: inv(3, 'A'), b: inv(2, 'A'), c: inv(4, 'C'), z: inv(0, 'Z'), w: inv(5, null) }, 0);
    assert.deepStrictEqual(store.earlier, { A: 5, C: 4 });
    assert.deepStrictEqual(store.joins, {});
    recordJoin(store, 'm1', { via: 'invite', code: 'a', inviter: 'A' }, false);
    assert.deepStrictEqual(countsFor(store, 'A'), { regular: 1, earlier: 5, left: 0, fake: 0, total: 6 });
});

test('fake and left joins are counted but not in the total', () => {
    const store = newStore();
    const viaA = { via: 'invite', code: 'a', inviter: 'A' };
    recordJoin(store, 'm1', viaA, false);
    recordJoin(store, 'm2', viaA, true);
    recordJoin(store, 'm3', viaA, false);
    assert.strictEqual(recordLeave(store, 'm3'), true);
    assert.strictEqual(recordLeave(store, 'm3'), false);
    assert.strictEqual(recordLeave(store, 'never-seen'), false);
    assert.deepStrictEqual(countsFor(store, 'A'), { regular: 1, earlier: 0, left: 1, fake: 1, total: 1 });
});

test('a rejoin via another inviter moves the member over, counted once', () => {
    const store = newStore();
    recordJoin(store, 'm1', { via: 'invite', code: 'a', inviter: 'A' }, false);
    recordLeave(store, 'm1');
    recordJoin(store, 'm1', { via: 'invite', code: 'b', inviter: 'B' }, false);
    assert.deepStrictEqual(countsFor(store, 'A'), { regular: 0, earlier: 0, left: 0, fake: 0, total: 0 });
    assert.deepStrictEqual(countsFor(store, 'B'), { regular: 1, earlier: 0, left: 0, fake: 0, total: 1 });
    assert.strictEqual(store.joins.m1.left, false);
});

test('leaderboard: by total, ties by regular then id, zero totals left out, caller rank', () => {
    const store = newStore({ x: inv(3, 'E'), y: inv(1, 'D') });
    const join = (m, inviter) => recordJoin(store, m, { via: 'invite', code: 'c', inviter }, false);
    join('1', 'A'); join('2', 'A'); join('3', 'A');   // A: 3 regular
    join('4', 'B'); join('5', 'B'); join('6', 'B');   // B: 3 regular (tie with A, A < B)
    join('7', 'D');                                    // D: 1 regular + 1 earlier = 2
    join('8', 'F'); recordLeave(store, '8');           // F: 0 → not on the board
    recordJoin(store, '9', { via: 'vanity', code: null, inviter: null }, false);
    const { top, caller } = leaderboard(store, 3, 'D');
    assert.deepStrictEqual(top.map(r => [r.rank, r.inviterId, r.total]), [[1, 'A', 3], [2, 'B', 3], [3, 'E', 3]]);
    assert.deepStrictEqual([caller.rank, caller.total], [4, 2]);
    assert.strictEqual(leaderboard(store, 10, 'F').caller, null);
    assert.strictEqual(leaderboard(store, 10, 'A').top.length, 4);
});

test('parseStore: a valid store round-trips, a corrupt or foreign one is null', () => {
    const store = newStore({ a: inv(2, 'A') }, 0);
    recordJoin(store, 'm1', { via: 'invite', code: 'a', inviter: 'A' }, false, 0);
    assert.deepStrictEqual(parseStore(JSON.stringify(store)), store);
    for (const bad of ['{ not json', '', 'null', '[]', '{"v":2,"earlier":{},"joins":{}}', '{"v":1,"earlier":{}}', '{"v":1,"earlier":[],"joins":{}}']) {
        assert.strictEqual(parseStore(bad), null, bad);
    }
});
