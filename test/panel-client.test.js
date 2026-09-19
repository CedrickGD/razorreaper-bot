// The bot half of the bot ↔ panel contract. No network: `post` is a stub, so the shapes below
// are exactly what the panel side has to accept.
const test = require('node:test');
const assert = require('node:assert');
const {
    findReportId, maskTail, shortDate, purchaseBlocks, ticketUploadPayload, uploadTicket,
    MAX_UPLOAD_BYTES,
} = require('../panel-client');

// ── Report IDs ────────────────────────────────────────────────────────────────
// The client shows `Report ID: FB-…` after a support report; a member pastes it into the ticket.

test('a Report ID is found in whatever the member types around it', () => {
    assert.strictEqual(findReportId('here you go: FB-0A1B2C3D4E5F thanks'), 'FB-0A1B2C3D4E5F');
    assert.strictEqual(findReportId('fb-000123'), 'FB-000123');
    assert.strictEqual(findReportId('Report ID: FB-ABC123'), 'FB-ABC123');
});

test('ordinary support prose is not mistaken for a Report ID', () => {
    for (const text of ['it still fails', 'RR-E1003 again', 'FB-', 'FB', '', null]) {
        assert.strictEqual(findReportId(text), null, String(text));
    }
});

// ── Masking ───────────────────────────────────────────────────────────────────
// The panel masks already. Doing it again is four characters of code at a trust boundary.

test('only the last four characters of an order reference survive', () => {
    assert.strictEqual(maskTail('ORD-98217734AB12'), '…AB12');
    assert.strictEqual(maskTail('AB12'), 'AB12');
    assert.strictEqual(maskTail('  '), null);
    assert.strictEqual(maskTail(null), null);
});

test('masking something the panel already masked changes nothing that matters', () => {
    assert.strictEqual(maskTail(maskTail('ORD-98217734AB12')), '…AB12');
});

test('a date becomes a plain day, and nonsense becomes nothing', () => {
    assert.strictEqual(shortDate('2026-04-12T09:31:00Z'), '2026-04-12');
    assert.strictEqual(shortDate('not a date'), null);
    assert.strictEqual(shortDate(null), null);
});

// ── The purchase embed ────────────────────────────────────────────────────────

test('a lifetime purchase reads as lifetime and never expires', () => {
    const blocks = purchaseBlocks([{
        plan: 'monthly', lifetime: true, status: 'active', purchasedAt: '2026-04-12T09:00:00Z',
        orderRef: 'ORD-98217734AB12', keyLast4: '7F3C', seatsUsed: 1, seatsMax: 3, source: 'sellhub',
    }]);
    assert.strictEqual(blocks[0], '**Lifetime** · active\nBought 2026-04-12 · expires never');
    assert.strictEqual(blocks[1], 'Order …AB12 · key ••••7F3C · seats 1/3 · sellhub');
});

test('a timed plan shows its length and its real expiry', () => {
    const blocks = purchaseBlocks([{
        plan: 'Monthly', durationDays: 30, lifetime: false, status: 'expired',
        purchasedAt: '2026-04-12', expiresAt: '2026-05-12',
    }]);
    assert.match(blocks[0], /\*\*Monthly \(30 days\)\*\* · expired/);
    assert.match(blocks[0], /expires 2026-05-12/);
});

test('nothing that could identify the customer reaches the embed', () => {
    const blocks = purchaseBlocks([{
        plan: 'Lifetime', lifetime: true, status: 'active',
        orderRef: 'ORD-98217734AB12', keyLast4: '7F3C',
    }]).join('\n');
    assert.ok(!blocks.includes('ORD-98217734'), blocks);
    assert.ok(blocks.includes('…AB12'));
    assert.ok(!/@/.test(blocks), 'no e-mail shape may survive');
});

test('no purchases says so in one line instead of showing an empty embed', () => {
    assert.deepStrictEqual(purchaseBlocks([]), ['No purchase is recorded for this Discord account.']);
    assert.deepStrictEqual(purchaseBlocks(null), ['No purchase is recorded for this Discord account.']);
});

test('the embed never grows past three purchases', () => {
    const one = { plan: 'Monthly', status: 'expired', orderRef: 'ORD-1234' };
    assert.strictEqual(purchaseBlocks([one, one, one, one, one]).length, 6);  // two blocks each, capped at 3
});

test('a purchase with no order detail yields one block, not an empty second one', () => {
    assert.strictEqual(purchaseBlocks([{ plan: 'Monthly', status: 'expired' }]).length, 1);
});

test('every purchase block obeys the two-line rule', () => {
    for (const b of purchaseBlocks([{ plan: 'Lifetime', lifetime: true, status: 'active', orderRef: 'X1234' }])) {
        assert.ok(b.split('\n').length <= 2, b);
    }
});

// ── The ticket upload ─────────────────────────────────────────────────────────

const PAYLOAD_KEYS = [
    'channel_id', 'ticket_no', 'channel_name', 'discord_id', 'discord_tag', 'category', 'status',
    'opened_at', 'closed_at', 'closed_by', 'ai_replies', 'message_count', 'provider', 'transcript_html',
];

test('the upload body is exactly the contract, no more and no less', () => {
    const body = ticketUploadPayload({
        channelId: '123', ticketNo: '0042', channelName: 'ticket-0042',
        discordId: '947', discordTag: 'cedrick', category: 'bug', status: 'closed',
        openedAt: Date.parse('2026-09-19T10:00:00Z'), closedAt: Date.parse('2026-09-19T11:14:00Z'),
        closedBy: 'cedrick', aiReplies: 3, messageCount: 24, provider: 'claude',
        transcriptHtml: '<!DOCTYPE html>…',
    });
    assert.deepStrictEqual(Object.keys(body).sort(), [...PAYLOAD_KEYS].sort());
    assert.strictEqual(body.ticket_no, 42);
    assert.strictEqual(body.opened_at, '2026-09-19T10:00:00.000Z');
    assert.strictEqual(body.closed_at, '2026-09-19T11:14:00.000Z');
    assert.strictEqual(body.status, 'closed');
});

test('missing optional fields are null, never undefined — undefined vanishes in JSON', () => {
    const body = ticketUploadPayload({ channelId: '1', channelName: 'false-topic', status: 'false_topic' });
    for (const key of PAYLOAD_KEYS) assert.notStrictEqual(body[key], undefined, key);
    assert.strictEqual(body.discord_id, null);
    assert.strictEqual(body.provider, null);
    assert.strictEqual(body.ai_replies, 0);
    assert.strictEqual(body.category, 'other');
});

test('a normal upload is one call and the panel\'s answer comes straight back', async () => {
    const calls = [];
    const post = async (path, body) => { calls.push([path, body]); return { status: 200, data: { ok: true, id: 7 } }; };
    const res = await uploadTicket(post, ticketUploadPayload({ channelId: '1', status: 'closed' }), () => 'smaller');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], '/api/discord/tickets');
    assert.deepStrictEqual(res.data, { ok: true, id: 7 });
});

test('a 413 is retried ONCE with a shorter transcript, and nothing else changes', async () => {
    const bodies = [];
    const post = async (_path, body) => {
        bodies.push(body);
        return bodies.length === 1 ? { status: 413, data: { ok: false, error: 'too large' } } : { status: 200, data: { ok: true, id: 8 } };
    };
    const payload = ticketUploadPayload({ channelId: '1', channelName: 'ticket-1', status: 'closed', transcriptHtml: 'x'.repeat(50) });
    const res = await uploadTicket(post, payload, () => 'SHORTER');

    assert.strictEqual(bodies.length, 2);
    assert.strictEqual(bodies[1].transcript_html, 'SHORTER');
    assert.deepStrictEqual({ ...bodies[0], transcript_html: null }, { ...bodies[1], transcript_html: null });
    assert.strictEqual(res.data.id, 8);
});

test('a 413 with nothing left to drop gives up instead of looping', async () => {
    let calls = 0;
    const post = async () => { calls++; return { status: 413, data: { ok: false } }; };
    const res = await uploadTicket(post, ticketUploadPayload({ channelId: '1', status: 'closed' }), () => null);
    assert.strictEqual(calls, 1);
    assert.strictEqual(res.status, 413);
});

test('a second 413 is not retried a third time', async () => {
    let calls = 0;
    const post = async () => { calls++; return { status: 413, data: { ok: false } }; };
    await uploadTicket(post, ticketUploadPayload({ channelId: '1', status: 'closed' }), () => 'still too big');
    assert.strictEqual(calls, 2);
});

test('the body cap the retry exists for is the panel\'s own', () => {
    assert.strictEqual(MAX_UPLOAD_BYTES, 800 * 1024);
});
