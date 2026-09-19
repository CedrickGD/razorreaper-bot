const test = require('node:test');
const assert = require('node:assert');
const { planRoleChanges } = require('../role-plan');

const ROLES = { verified: 'R_CUST', lifetime: 'R_LIFE' };
const member = (id, roles = [], bot = false) => ({ id, bot, roles });

test('grants the customer role to an active link that has none', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: true, lifetime: false }] },
        [member('1')],
        ROLES,
    );
    assert.deepStrictEqual(plan, { ok: true, changes: [{ id: '1', add: ['R_CUST'], remove: [] }] });
});

test('grants customer + Lifetime for a lifetime link, and only Lifetime when the customer role is already held', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: true, lifetime: true }, { discord_id: '2', active: true, lifetime: true }] },
        [member('1'), member('2', ['R_CUST'])],
        ROLES,
    );
    assert.deepStrictEqual(plan.changes, [
        { id: '1', add: ['R_CUST', 'R_LIFE'], remove: [] },
        { id: '2', add: ['R_LIFE'], remove: [] },
    ]);
});

test('strips both roles when the link went inactive, and ignores bots and untouched members', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: false, lifetime: true }, { discord_id: '3', active: true, lifetime: false }] },
        [member('1', ['R_CUST', 'R_LIFE']), member('2', ['R_CUST'], true), member('3', ['R_CUST'])],
        ROLES,
    );
    assert.deepStrictEqual(plan.changes, [{ id: '1', add: [], remove: ['R_CUST', 'R_LIFE'] }]);
});

test('drops Lifetime but keeps the customer role when a lifetime licence became a timed one', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: true, lifetime: false }] },
        [member('1', ['R_CUST', 'R_LIFE'])],
        ROLES,
    );
    assert.deepStrictEqual(plan.changes, [{ id: '1', add: [], remove: ['R_LIFE'] }]);
});

test('leaves the Lifetime role alone when it could not be resolved', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: true, lifetime: true }] },
        [member('1', ['R_CUST', 'R_LIFE'])],
        { verified: 'R_CUST', lifetime: null },
    );
    assert.deepStrictEqual(plan.changes, []);
});

test('a licence with two Discord accounts: the lifetime flag applies to both', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: true, lifetime: false }, { discord_id: '1', active: true, lifetime: true }] },
        [member('1')],
        ROLES,
    );
    assert.deepStrictEqual(plan.changes, [{ id: '1', add: ['R_CUST', 'R_LIFE'], remove: [] }]);
});

// ── The three safety cases: a bad answer must never mass-strip ────────────────

test('safety: a failed/non-ok call changes nothing', () => {
    for (const bad of [null, undefined, {}, { ok: false, links: [] }, { ok: true }]) {
        const plan = planRoleChanges(bad, [member('1', ['R_CUST', 'R_LIFE'])], ROLES);
        assert.strictEqual(plan.ok, false, `expected abort for ${JSON.stringify(bad)}`);
        assert.ok(plan.reason);
    }
});

test('safety: links is not an array -> abort', () => {
    const plan = planRoleChanges({ ok: true, links: 'nope' }, [member('1', ['R_CUST'])], ROLES);
    assert.strictEqual(plan.ok, false);
});

test('safety: an empty links list while members still hold the customer role -> abort', () => {
    const plan = planRoleChanges({ ok: true, links: [] }, [member('1', ['R_CUST']), member('2')], ROLES);
    assert.strictEqual(plan.ok, false);
    assert.match(plan.reason, /empty links list while 1 member/);
});

test('an empty links list with nobody holding the role is a legitimate no-op', () => {
    const plan = planRoleChanges({ ok: true, links: [] }, [member('1'), member('2', ['R_CUST'], true)], ROLES);
    assert.deepStrictEqual(plan, { ok: true, changes: [] });
});
