const test = require('node:test');
const assert = require('node:assert');
const { planRoleChanges, classifyVerifyMessage } = require('../role-plan');

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

test('a lifetime link gets only Lifetime; a lifetime holder with both roles loses the customer role', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: true, lifetime: true }, { discord_id: '2', active: true, lifetime: true }] },
        [member('1'), member('2', ['R_CUST', 'R_LIFE'])],
        ROLES,
    );
    assert.deepStrictEqual(plan.changes, [
        { id: '1', add: ['R_LIFE'], remove: [] },
        { id: '2', add: [], remove: ['R_CUST'] },
    ]);
});

test('switching between a monthly and a lifetime licence swaps the roles', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: true, lifetime: true }, { discord_id: '2', active: true, lifetime: false }] },
        [member('1', ['R_CUST']), member('2', ['R_LIFE'])],
        ROLES,
    );
    assert.deepStrictEqual(plan.changes, [
        { id: '1', add: ['R_LIFE'], remove: ['R_CUST'] },
        { id: '2', add: ['R_CUST'], remove: ['R_LIFE'] },
    ]);
});

test('a lifetime link that lapses loses Lifetime and gains nothing', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: false, lifetime: true }] },
        [member('1', ['R_LIFE'])],
        ROLES,
    );
    assert.deepStrictEqual(plan.changes, [{ id: '1', add: [], remove: ['R_LIFE'] }]);
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

test('while Lifetime cannot be resolved, lifetime links keep (or get) the customer role instead', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: true, lifetime: true }, { discord_id: '2', active: true, lifetime: true }] },
        [member('1', ['R_CUST', 'R_LIFE']), member('2')],
        { verified: 'R_CUST', lifetime: null },
    );
    assert.deepStrictEqual(plan.changes, [{ id: '2', add: ['R_CUST'], remove: [] }]);
});

test('a licence with two Discord accounts: the lifetime flag applies to both', () => {
    const plan = planRoleChanges(
        { ok: true, links: [{ discord_id: '1', active: true, lifetime: false }, { discord_id: '1', active: true, lifetime: true }] },
        [member('1')],
        ROLES,
    );
    assert.deepStrictEqual(plan.changes, [{ id: '1', add: ['R_LIFE'], remove: [] }]);
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

test('safety: holders of Lifetime alone count too -> abort', () => {
    const plan = planRoleChanges({ ok: true, links: [] }, [member('1', ['R_LIFE']), member('2', ['R_LIFE'])], ROLES);
    assert.strictEqual(plan.ok, false);
    assert.match(plan.reason, /empty links list while 2 member/);
});

test('an empty links list with nobody holding the role is a legitimate no-op', () => {
    const plan = planRoleChanges({ ok: true, links: [] }, [member('1'), member('2', ['R_CUST'], true)], ROLES);
    assert.deepStrictEqual(plan, { ok: true, changes: [] });
});

// ── #verify chat classifier ──────────────────────────────────────────────────

test('#verify: anything shaped like a licence key is a key, wherever it sits', () => {
    for (const text of [
        'ABCD-1234-EF56-7890',
        'my key is abcd-1234-ef56-7890 pls',
        '4A3B-4C1D-9E2F-0123456789AB',          // what the panel actually issues (4-4-4-12)
        '/verify key:4A3B-4C1D-9E2F-0123456789AB', // typed instead of run as a command
        'ABCD1234EF567890',
        'here: 4a3b4c1d9e2f0123456789ab ok',
    ]) assert.strictEqual(classifyVerifyMessage(text), 'key', text);
});

test('#verify: questions about verifying are related, in English and German', () => {
    for (const text of [
        'how do I verify?', 'Verification failed', 'where is my license', 'licence expired',
        'Lizenz geht nicht', 'no role after buying', 'rolle fehlt', 'which code?', 'premium chat?',
        'I bought lifetime', 'how to activate', 'wie aktiviere ich das', 'link discord', 'help', 'lost my key',
    ]) assert.strictEqual(classifyVerifyMessage(text), 'related', text);
});

test('#verify: everything else is other — ids, long words and look-alikes are not keys', () => {
    for (const text of [
        '', undefined, 'hi', 'gm everyone', 'lol', 'keyboard broke', 'helpful people here',
        '<@123456789012345678>', 'responsibilities', 'ABC-1234-EF56-7890',
    ]) assert.strictEqual(classifyVerifyMessage(text), 'other', String(text));
});
