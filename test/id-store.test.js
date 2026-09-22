const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIds, saveIds, looseName } = require('../id-store');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ids-')), 'sub', 'ids.json');

test('looseName strips the owner\'s styling down to the word', () => {
    assert.strictEqual(looseName('├│・ticket-log'), 'ticketlog');
    assert.strictEqual(looseName('├│・createt-icket'), 'createticket');
    assert.strictEqual(looseName('| ====== TICKETS ====== |'), 'tickets');
    assert.strictEqual(looseName('reaper-lounge'), 'reaperlounge');
    assert.strictEqual(looseName(undefined), '');
});

test('looseName maps the live role names onto the staff words', () => {
    const live = ['👑 Owner', '🛡️ Admin', '⚔️ Moderator', '🎫 Support Staff', 'Lifetime', 'RR-Customer', '👤 Member', '🔔 Ticket Ping'];
    assert.deepStrictEqual(live.map(looseName),
        ['owner', 'admin', 'moderator', 'supportstaff', 'lifetime', 'rrcustomer', 'member', 'ticketping']);
});

test('loadIds: missing or corrupt file is {} and never throws', () => {
    const file = tmpFile();
    assert.deepStrictEqual(loadIds(file), {});
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    assert.deepStrictEqual(loadIds(file), {});
    fs.writeFileSync(file, '["an", "array"]');
    assert.deepStrictEqual(loadIds(file), {});
});

test('saveIds round-trips through loadIds, creating the directory and leaving no temp file', () => {
    const file = tmpFile();
    const ids = { ticketLog: '123', staffRoles: ['1', '2'] };
    assert.strictEqual(saveIds(file, ids), true);
    assert.deepStrictEqual(loadIds(file), ids);
    assert.strictEqual(fs.existsSync(`${file}.tmp`), false);
});

test('saveIds logs instead of throwing when it cannot write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ids-'));
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.strictEqual(saveIds(path.join(blocker, 'ids.json'), { a: '1' }), false);
    } finally {
        console.warn = warn;
    }
});
