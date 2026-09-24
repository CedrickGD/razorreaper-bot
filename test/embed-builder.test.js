// /buildembed checks Discord's limits itself so a staff member reads a sentence instead of an API
// error, and it round-trips drafts through JSON and existing messages. This pins both.
// discord.js is required through embed-builder.js, but nothing here logs in.
const test = require('node:test');
const assert = require('node:assert');
const {
    newState, applyEdit, validate, parseColor, toMessagePayload, toJson,
    fromMessage, fromJson, editRefusal, allowedMentionsFor, builderView, builderModal, modalPrefill,
} = require('../embed-builder');
const { BRAND, BRAND_FOOTER } = require('../brand');

const draft = (patch = {}) => ({ ...newState(), ...patch });
const ok = (r) => { assert.ok(r.ok, r.error); return r.state; };
const refused = (r, pattern) => { assert.strictEqual(r.ok, false); assert.match(r.error, pattern); };
const ID = '123456789012345678';

// ── Colours ───────────────────────────────────────────────────────────────────

test('a hex colour is read with #, 0x or bare, and nothing else', () => {
    for (const s of ['#8b5cf6', '8b5cf6', '0x8b5cf6', ' 0X8B5CF6 ']) assert.strictEqual(parseColor(s), 0x8b5cf6);
    for (const s of ['#8b5cf', 'purple', '#8b5cf6aa', '', null]) assert.strictEqual(parseColor(s), null);
    assert.strictEqual(parseColor(0xffffff), 0xffffff);
    assert.strictEqual(parseColor(0x1000000), null);
});

test('a new draft is RR purple and empty; presets, custom hex and "no colour" set it', () => {
    assert.strictEqual(newState().color, BRAND);
    assert.strictEqual(ok(applyEdit(newState(), 'colour', { key: 'gold' })).color, 0xf0b132);
    assert.strictEqual(ok(applyEdit(newState(), 'colour', { key: 'none' })).color, null);
    assert.strictEqual(ok(applyEdit(newState(), 'hex', { hex: '#123abc' })).color, 0x123abc);
    refused(applyEdit(newState(), 'hex', { hex: 'blue' }), /not a hex colour/);
});

// ── Limits ────────────────────────────────────────────────────────────────────

test('every Discord text limit is refused with a sentence, one character past it', () => {
    const cases = [
        ['title', 256], ['description', 4096], ['authorName', 256], ['footerText', 2048], ['content', 2000],
    ];
    for (const [key, max] of cases) {
        assert.strictEqual(validate(draft({ [key]: 'x'.repeat(max) })), null, key);
        assert.match(validate(draft({ [key]: 'x'.repeat(max + 1) })), new RegExp(`limit is ${max}`), key);
    }
});

test('fields: at most 25, name 256, value 1024, and both are needed', () => {
    const f = (name = 'n', value = 'v') => ({ name, value, inline: false });
    assert.strictEqual(validate(draft({ fields: Array(25).fill(f()) })), null);
    assert.match(validate(draft({ fields: Array(26).fill(f()) })), /at most 25/);
    assert.match(validate(draft({ fields: [f('x'.repeat(257))] })), /limit is 256/);
    assert.match(validate(draft({ fields: [f('n', 'x'.repeat(1025))] })), /limit is 1024/);
    assert.match(validate(draft({ fields: [f('n', '')] })), /needs a name and a value/);
});

test('the whole embed holds at most 6000 characters of text', () => {
    const d = draft({ description: 'x'.repeat(4000), footerText: 'x'.repeat(2000) });
    assert.strictEqual(validate(d), null);
    assert.match(validate({ ...d, title: 'x' }), /6001 characters.*limit is 6000/);
});

test('link buttons: at most 5, a label of 1–80, an http(s) link, a real emoji', () => {
    const b = (patch = {}) => ({ label: 'Shop', url: 'https://razorreaper.app', emoji: '', ...patch });
    assert.strictEqual(validate(draft({ buttons: Array(5).fill(b()) })), null);
    assert.match(validate(draft({ buttons: Array(6).fill(b()) })), /At most 5/);
    assert.match(validate(draft({ buttons: [b({ label: 'x'.repeat(81) })] })), /1–80/);
    assert.match(validate(draft({ buttons: [b({ label: '' })] })), /1–80/);
    assert.match(validate(draft({ buttons: [b({ url: 'ftp://x.y' })] })), /http\(s\)/);
    assert.match(validate(draft({ buttons: [b({ emoji: 'fire' })] })), /not an emoji/);
    assert.strictEqual(validate(draft({ buttons: [b({ emoji: '🔥' }), b({ emoji: `<a:spin:${ID}>` })] })), null);
});

test('every URL must be http(s)', () => {
    const base = { title: 't', authorName: 'a', footerText: 'f' };
    for (const key of ['url', 'authorIcon', 'authorUrl', 'footerIcon', 'thumbnail', 'image']) {
        assert.strictEqual(validate(draft({ ...base, [key]: 'https://cdn.example.com/a.png' })), null, key);
        assert.strictEqual(validate(draft({ ...base, [key]: 'http://example.com' })), null, key);
        for (const bad of ['javascript:alert(1)', 'attachment://a.png', 'not a url']) {
            assert.match(validate(draft({ ...base, [key]: bad })), /http\(s\) link/, `${key}=${bad}`);
        }
    }
});

test('icons and links Discord would silently drop are refused', () => {
    assert.match(validate(draft({ url: 'https://x.y' })), /needs a title/);
    assert.match(validate(draft({ authorIcon: 'https://x.y/a.png' })), /author name/);
    assert.match(validate(draft({ footerIcon: 'https://x.y/a.png' })), /footer text/);
});

test('there has to be something to send — content alone is fine, colour alone is not', () => {
    assert.strictEqual(validate(newState()), null);   // a half-built draft is fine
    assert.match(validate(newState(), { sending: true }), /Nothing to send/);
    assert.strictEqual(validate(draft({ content: 'hi' }), { sending: true }), null);
    assert.strictEqual(validate(draft({ thumbnail: 'https://x.y/a.png' }), { sending: true }), null);
});

test('a refused edit leaves the old state untouched', () => {
    const s = draft({ title: 'Keep me' });
    refused(applyEdit(s, 'text', { title: 'x'.repeat(300) }), /limit is 256/);
    assert.strictEqual(s.title, 'Keep me');
});

// ── Edits ─────────────────────────────────────────────────────────────────────

test('a field is added, edited, and removed by emptying name and value', () => {
    let s = ok(applyEdit(newState(), 'addField', { name: ' Price ', value: '9 €', inline: 'yes' }));
    assert.deepStrictEqual(s.fields, [{ name: 'Price', value: '9 €', inline: true }]);
    s = ok(applyEdit(s, 'addField', { name: 'Two', value: '2', inline: 'no' }));
    s = ok(applyEdit(s, 'editField', { index: '0', name: 'Cost', value: '10 €', inline: 'no' }));
    assert.deepStrictEqual(s.fields[0], { name: 'Cost', value: '10 €', inline: false });
    s = ok(applyEdit(s, 'editField', { index: '0', name: '', value: '' }));
    assert.deepStrictEqual(s.fields.map(f => f.name), ['Two']);
    refused(applyEdit(s, 'editField', { index: '5', name: 'x', value: 'y' }), /no longer exists/);
    refused(applyEdit(s, 'addField', { name: 'only a name', value: '' }), /needs a name and a value/);
});

test('icons: RR logo fills in a name/footer text so the pick is visible; removes clear only the icon', () => {
    const ctx = { logoUrl: 'https://cdn.x/logo.png', botAvatar: 'https://cdn.x/bot.png', userAvatar: 'https://cdn.x/me.png', userName: 'Cedi' };
    let s = ok(applyEdit(newState(), 'icons', { pick: 'logoAuthor', ...ctx }));
    assert.deepStrictEqual([s.authorName, s.authorIcon], ['RazorReaper', ctx.logoUrl]);
    s = ok(applyEdit(s, 'icons', { pick: 'logoFooter', ...ctx }));
    assert.deepStrictEqual([s.footerText, s.footerIcon], [BRAND_FOOTER, ctx.logoUrl]);
    s = ok(applyEdit(s, 'icons', { pick: 'meAuthor', ...ctx }));
    assert.deepStrictEqual([s.authorName, s.authorIcon], ['Cedi', ctx.userAvatar]);
    s = ok(applyEdit(s, 'icons', { pick: 'botThumb', ...ctx }));
    assert.strictEqual(s.thumbnail, ctx.botAvatar);
    s = ok(applyEdit(s, 'icons', { pick: 'rmFooterIcon', ...ctx }));
    assert.deepStrictEqual([s.footerText, s.footerIcon], [BRAND_FOOTER, '']);
});

test('RR style sets the house look and keeps the words; reset empties everything', () => {
    const s = ok(applyEdit(draft({ title: 'Mine', color: 0x00ff00 }), 'rrStyle', { logoUrl: 'https://cdn.x/logo.png' }));
    assert.deepStrictEqual([s.title, s.color, s.thumbnail, s.footerText, s.timestamp],
        ['Mine', BRAND, 'https://cdn.x/logo.png', BRAND_FOOTER, true]);
    assert.deepStrictEqual(ok(applyEdit(s, 'reset')), newState());
});

// ── Payload, mentions ─────────────────────────────────────────────────────────

test('the payload: content, one embed, and a link-button row only when there are buttons', () => {
    const plain = toMessagePayload(draft({ title: 'Hi' }));
    assert.deepStrictEqual(plain, { content: '', embeds: [{ color: BRAND, title: 'Hi' }], components: [] });

    const withButtons = toMessagePayload(draft({
        content: 'Look', buttons: [{ label: 'Shop', url: 'https://razorreaper.app', emoji: '🛒' }],
    }));
    assert.deepStrictEqual(withButtons.embeds, []);   // nothing visible in the embed → not sent
    assert.deepStrictEqual(withButtons.components, [{
        type: 1, components: [{ type: 2, style: 5, label: 'Shop', url: 'https://razorreaper.app', emoji: { name: '🛒' } }],
    }]);
});

test('mentions: only the users and roles in the content; @everyone only with the permission', () => {
    const content = `<@${ID}> <@!${ID}> <@&${ID}> @everyone`;
    const allowed = allowedMentionsFor(content, true);
    assert.deepStrictEqual(allowed, {
        allowedMentions: { users: [ID], roles: [ID], parse: ['everyone'] }, everyoneDropped: false,
    });
    const denied = allowedMentionsFor(content, false);
    assert.deepStrictEqual(denied.allowedMentions, { users: [ID], roles: [ID] });
    assert.strictEqual(denied.everyoneDropped, true);
    assert.deepStrictEqual(allowedMentionsFor('no pings', false), {
        allowedMentions: { users: [], roles: [] }, everyoneDropped: false,
    });
});

// ── JSON and messages ─────────────────────────────────────────────────────────

const full = () => draft({
    content: 'Hello <@&123456789012345678>', title: 'Title', url: 'https://razorreaper.app', description: 'Text\nmore',
    color: 0xf0b132, authorName: 'RR', authorIcon: 'https://cdn.x/a.png', authorUrl: 'https://razorreaper.app',
    footerText: 'Foot', footerIcon: 'https://cdn.x/f.png', thumbnail: 'https://cdn.x/t.png', image: 'https://cdn.x/i.png',
    timestamp: true, fields: [{ name: 'A', value: '1', inline: true }, { name: 'B', value: '2', inline: false }],
    buttons: [{ label: 'Shop', url: 'https://razorreaper.app', emoji: `<:rr:${ID}>` }, { label: 'Docs', url: 'https://x.y', emoji: '' }],
});

test('export → import gives back the same draft', () => {
    const s = full();
    assert.deepStrictEqual(ok(fromJson(toJson(s))), s);
    assert.deepStrictEqual(ok(applyEdit(newState(), 'import', { json: toJson(s) })), s);
});

test('a sent message reads back into the same draft (the edit option)', () => {
    const s = full();
    assert.deepStrictEqual(fromMessage(toMessagePayload(s)), s);
    // No colour survives too: an embed without `color` is "no colour", not RR purple.
    const none = draft({ title: 'x', color: null });
    assert.deepStrictEqual(fromMessage(toMessagePayload(none)), none);
});

test('import takes a raw embed, a Discord message, and a Discohook share', () => {
    const embed = { title: 'Raw', color: 0x22c55e, somethingElse: 1 };
    assert.deepStrictEqual([ok(fromJson(JSON.stringify(embed))).title, ok(fromJson(JSON.stringify(embed))).color], ['Raw', 0x22c55e]);
    const message = { content: 'hi', embeds: [{ description: 'first' }, { description: 'second' }] };
    const fromMsg = ok(fromJson(JSON.stringify(message)));
    assert.deepStrictEqual([fromMsg.content, fromMsg.description], ['hi', 'first']);
    const share = { version: 'd2', messages: [{ data: message }] };
    assert.deepStrictEqual(ok(fromJson(JSON.stringify(share))), fromMsg);
});

test('invalid or empty JSON is an error and the draft stays as it was', () => {
    const s = draft({ title: 'Keep me' });
    refused(applyEdit(s, 'import', { json: '{ not json' }), /not valid JSON/);
    refused(applyEdit(s, 'import', { json: '42' }), /No message or embed/);
    refused(applyEdit(s, 'import', { json: '{"messages": []}' }), /No message or embed/);
    refused(applyEdit(s, 'import', { json: JSON.stringify({ title: 'x'.repeat(300) }) }), /limit is 256/);
    assert.strictEqual(s.title, 'Keep me');
});

test('only the bot\'s own single-embed, link-button-only messages are editable', () => {
    const msg = { authorId: 'BOT', embeds: [{ type: 'rich' }], components: [{ type: 1, components: [{ type: 2, style: 5 }] }] };
    assert.strictEqual(editRefusal(msg, 'BOT'), null);
    assert.match(editRefusal(msg, 'OTHER'), /messages I sent/);
    assert.match(editRefusal({ ...msg, embeds: [{ type: 'rich' }, { type: 'rich' }] }, 'BOT'), /more than one embed/);
    assert.match(editRefusal({ ...msg, components: [{ type: 1, components: [{ type: 3 }] }] }, 'BOT'), /menus or buttons/);
});

// ── The builder UI ────────────────────────────────────────────────────────────

test('the builder is five valid rows, the embed as sent, and the link buttons as a text line', () => {
    const s = full();
    const view = builderView(s, 'SID', { targetName: 'announcements' });
    const rows = view.components.map(r => r.toJSON());   // the builders validate here
    assert.strictEqual(rows.length, 5);
    assert.ok(rows.flatMap(r => r.components).every(c => c.custom_id.startsWith('eb:SID:')));
    assert.match(view.content, /#announcements/);
    assert.match(view.content, /Link buttons: <:rr:\d+> Shop · Docs/);
    assert.match(view.content, /Hello <@&/);
    assert.deepStrictEqual(view.allowedMentions, { parse: [] });
    assert.strictEqual(view.embeds[0].title, 'Title');
    assert.match(JSON.stringify(rows[4]), /Send to #announcements/);
    assert.match(JSON.stringify(builderView(s, 'SID', { targetName: 'x', editing: true }).components[4].toJSON()), /Save changes/);
});

test('an empty draft previews a placeholder; the field picker replaces the edit menu', () => {
    assert.match(builderView(newState(), 'S', { targetName: 'x' }).embeds[0].description, /Empty embed/);
    const picker = builderView(full(), 'S', { targetName: 'x', picking: true }).components[0].toJSON().components[0];
    assert.strictEqual(picker.custom_id, 'eb:S:field');
    assert.deepStrictEqual(picker.options.map(o => o.value), ['0', '1', 'back']);
    // A menu holds 25 options: at 25 fields every field stays pickable and Back is what drops.
    const fields = Array.from({ length: 25 }, (_, i) => ({ name: `F${i}`, value: 'v', inline: false }));
    const maxed = builderView(draft({ fields }), 'S', { targetName: 'x', picking: true }).components[0].toJSON().components[0];
    assert.deepStrictEqual(maxed.options.map(o => o.value), fields.map((_, i) => String(i)));
});

test('modals open prefilled with the current values, and never with an empty value', () => {
    const s = full();
    const text = builderModal('text', 'S', modalPrefill(s, 'text'), undefined).toJSON();
    assert.strictEqual(text.custom_id, 'eb:S:m:text');
    assert.deepStrictEqual(text.components.map(r => r.components[0].value), ['Title', 'https://razorreaper.app', 'Text\nmore']);
    const field = builderModal('editField', 'S', modalPrefill(s, 'editField', '1'), '1').toJSON();
    assert.strictEqual(field.custom_id, 'eb:S:m:editField:1');
    assert.deepStrictEqual(field.components.map(r => r.components[0].value), ['B', '2', 'no']);
    const empty = builderModal('author', 'S', modalPrefill(newState(), 'author'), undefined).toJSON();
    assert.ok(empty.components.every(r => !('value' in r.components[0])));
    assert.strictEqual(modalPrefill(draft({ color: 0x0000ff }), 'hex').hex, '#0000ff');
});
