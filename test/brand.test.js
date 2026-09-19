// The design rules the owner asked for ("weniger ist mehr") only hold if they are enforced in
// code rather than remembered by whoever writes the next embed. This pins the enforcement.
// discord.js is required through brand.js, but nothing here logs in.
const test = require('node:test');
const assert = require('node:assert');
const {
    rrEmbed, brandTitle, brandBody, brandThumb, shortLine, humanDuration, ticketLogEntry,
    BRAND, BRAND_FOOTER, MAX_TITLE_WORDS, MAX_BLOCK_LINES,
} = require('../brand');

/** Emoji-presentation characters, which is what "no emoji spam" is about. */
const emojiCount = (text) => (String(text).match(/\p{Extended_Pictographic}/gu) || []).length;

// ── Titles ────────────────────────────────────────────────────────────────────

test('a title is cut to five words', () => {
    assert.strictEqual(brandTitle('one two three four five six seven'), 'one two three four five');
    assert.strictEqual(MAX_TITLE_WORDS, 5);
});

test('a title is normalised, not just truncated', () => {
    assert.strictEqual(brandTitle('  Ticket   0042  '), 'Ticket 0042');
    assert.strictEqual(brandTitle(null), '');
});

// ── Blocks ────────────────────────────────────────────────────────────────────

test('blocks are separated by exactly one blank line', () => {
    assert.strictEqual(brandBody(['first', 'second', 'third']), 'first\n\nsecond\n\nthird');
});

test('a block never grows past two lines — that is what a wall of text is', () => {
    assert.strictEqual(brandBody(['a\nb\nc\nd']), 'a\nb');
    assert.strictEqual(MAX_BLOCK_LINES, 2);
});

test('falsy blocks drop out, so a call site can write `cond && line` inline', () => {
    assert.strictEqual(brandBody(['kept', false, null, undefined, '', '  ', 'also kept']), 'kept\n\nalso kept');
});

test('a bare string is a single block', () => {
    assert.strictEqual(brandBody('just this'), 'just this');
});

test('the description stays inside Discord\'s own ceiling', () => {
    assert.strictEqual(brandBody(['x'.repeat(9000)]).length, 4096);
});

// ── The embed itself ──────────────────────────────────────────────────────────

test('every embed carries the client\'s accent colour and the RazorReaper footer', () => {
    const e = rrEmbed({ title: 'Ticket open', blocks: ['Your ticket is here.'] }).toJSON();
    assert.strictEqual(e.color, BRAND);
    assert.strictEqual(BRAND, 0x8b5cf6);   // --accent-purple, RazorReaper/wwwroot/css/shared/theme.css
    assert.strictEqual(e.footer.text, BRAND_FOOTER);
});

test('the helper adds no emoji of its own — the budget of one belongs to the call site', () => {
    const e = rrEmbed({ title: '💳 Your purchase', blocks: ['Lifetime · active'] }).toJSON();
    assert.strictEqual(emojiCount(e.title) + emojiCount(e.description) + emojiCount(e.footer.text), 1);
});

test('form fields pass through verbatim — capping those would eat the member\'s own answer', () => {
    const e = rrEmbed({ fields: [{ name: 'Problem', value: 'line one\nline two\nline three' }] }).toJSON();
    assert.strictEqual(e.fields[0].value, 'line one\nline two\nline three');
});

test('field values are still clipped to what Discord accepts', () => {
    const e = rrEmbed({ fields: [{ name: 'Problem', value: 'x'.repeat(2000) }] }).toJSON();
    assert.strictEqual(e.fields[0].value.length, 1024);
});

test('an empty embed is legal — nothing throws on a missing title or body', () => {
    const e = rrEmbed().toJSON();
    assert.strictEqual(e.title, undefined);
    assert.strictEqual(e.description, undefined);
});

test('footer: null removes it (ephemeral refusals do not need branding)', () => {
    assert.strictEqual(rrEmbed({ blocks: ['no'], footer: null }).toJSON().footer, undefined);
});

test('the thumbnail prefers the server icon and falls back to the bot avatar', () => {
    const guild = { iconURL: () => 'https://cdn/guild.png' };
    const bot = { displayAvatarURL: () => 'https://cdn/bot.png' };
    assert.strictEqual(brandThumb(guild, bot), 'https://cdn/guild.png');
    assert.strictEqual(brandThumb({ iconURL: () => null }, bot), 'https://cdn/bot.png');
    assert.strictEqual(brandThumb(null, null), null);
});

// ── Small text helpers ────────────────────────────────────────────────────────

test('shortLine flattens newlines and caps', () => {
    assert.strictEqual(shortLine('a\n\n  b  \nc'), 'a b c');
    assert.strictEqual(shortLine('x'.repeat(50), 10), `${'x'.repeat(10)}…`);
});

test('a duration reads like a human wrote it', () => {
    assert.strictEqual(humanDuration(12_000), '12s');
    assert.strictEqual(humanDuration(3 * 60_000), '3m');
    assert.strictEqual(humanDuration((2 * 60 + 14) * 60_000), '2h 14m');
    assert.strictEqual(humanDuration(-5), '0s');
});

// ── The #ticket-log entry ─────────────────────────────────────────────────────

test('open and close produce the SAME title, so the close edits one row instead of posting two', () => {
    const open = ticketLogEntry({ ticketName: 'ticket-0042', opener: '<@1>', category: 'Bug / Crash' });
    const closed = ticketLogEntry({ ticketName: 'ticket-0042', opener: '<@1>', category: 'Bug / Crash', status: 'closed' });
    assert.strictEqual(open.title, 'Ticket 0042');
    assert.strictEqual(closed.title, open.title);
});

test('the open entry names the member, the category and the problem', () => {
    const { blocks } = ticketLogEntry({
        ticketName: 'ticket-0007', opener: '<@1>', category: 'Scripts & Automation',
        problem: 'Fed Suit does\nnothing at all',
    });
    assert.strictEqual(brandBody(blocks), '<@1> • Scripts & Automation\n\nProblem: Fed Suit does nothing at all');
});

test('the closed entry carries status, duration, messages, who closed it, replies and provider', () => {
    const { blocks } = ticketLogEntry({
        ticketName: 'ticket-0007', opener: '<@1>', category: 'Bug / Crash', status: 'closed',
        closedBy: 'cedrick', openMs: 74 * 60_000, messages: 24, aiReplies: 3, provider: 'claude',
    });
    const body = brandBody(blocks);
    assert.match(body, /closed/);
    assert.match(body, /Open for 1h 14m • 24 messages/);
    assert.match(body, /Closed by cedrick • 3 AI replies • claude/);
});

test('one AI reply is not "1 AI replies", and a missing provider adds nothing', () => {
    const { blocks } = ticketLogEntry({
        ticketName: 'ticket-1', opener: '<@1>', category: 'Bug', status: 'closed',
        closedBy: 'x', aiReplies: 1, messages: 1,
    });
    const body = brandBody(blocks);
    assert.match(body, /1 AI reply$/);
    assert.match(body, /• 1 message$/m);
});

test('a rejected form gets its own title, so it can never be mistaken for a ticket row', () => {
    const entry = ticketLogEntry({
        status: 'false_topic', opener: '<@1>', category: 'Something else', problem: 'Asked for a free key.',
    });
    assert.strictEqual(entry.title, '⚠️ False topic');
    assert.match(brandBody(entry.blocks), /no channel created/);
});

test('every log entry obeys the block rules it will be rendered with', () => {
    const entries = [
        ticketLogEntry({ ticketName: 'ticket-1', opener: '<@1>', category: 'Bug', problem: 'a\nb\nc\nd' }),
        ticketLogEntry({ ticketName: 'ticket-1', opener: '<@1>', category: 'Bug', status: 'closed', closedBy: 'x' }),
        ticketLogEntry({ status: 'false_topic', opener: '<@1>', category: 'Bug', problem: 'x'.repeat(500) }),
    ];
    for (const { title, blocks } of entries) {
        assert.ok(brandTitle(title).split(' ').length <= MAX_TITLE_WORDS, title);
        for (const b of blocks.filter(Boolean)) {
            assert.ok(String(b).split('\n').length <= MAX_BLOCK_LINES, `too many lines: ${b}`);
        }
        assert.ok(emojiCount(title) + emojiCount(brandBody(blocks)) <= 1, `emoji spam in ${title}`);
    }
});
