// ── /buildembed: the pure part ────────────────────────────────────────────────
// A Discohook-style embed builder that lives in an ephemeral message instead of a website. This
// file is the draft (state), every edit to it, and what the builder and the finished message look
// like; index.js only holds the session Map and talks to Discord.
//
// Free-form ON PURPOSE: rrEmbed's five-word titles and two-line blocks are the rules for the bot's
// own voice. An announcement a staff member writes is theirs, so the only limits here are
// Discord's own, and they are checked BEFORE anything is sent, because "Title is 300 characters,
// the limit is 256" helps and "Invalid Form Body" does not.
//
// discord.js builders are required here, but nothing touches the gateway (same as brand.js), so
// it unit-tests without a login.

const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder,
    TextInputBuilder, TextInputStyle, ComponentType,
} = require('discord.js');
const { BRAND, BRAND_FOOTER } = require('./brand');

// A new draft: RR purple and nothing else. Flat keys, so a modal input's id IS the state key.
const EMPTY = Object.freeze({
    content: '', title: '', url: '', description: '', color: BRAND,
    authorName: '', authorIcon: '', authorUrl: '', footerText: '', footerIcon: '',
    thumbnail: '', image: '', timestamp: false, fields: [], buttons: [],
});
const newState = () => structuredClone(EMPTY);

// value → [name, colour, emoji]. null = no colour (Discord's plain grey stripe).
const COLOURS = {
    purple: ['RR Purple', BRAND, '🟣'],
    green: ['Green', 0x22c55e, '🟢'],
    red: ['Red', 0xef4444, '🔴'],
    gold: ['Lifetime Gold', 0xf0b132, '🟡'],
    blue: ['Blue', 0x3b82f6, '🔵'],
    orange: ['Orange', 0xf97316, '🟠'],
    pink: ['Pink', 0xec4899, '💗'],
    grey: ['Grey', 0x6b7280, '⚪'],
    none: ['No colour', null, '🚫'],
};

/** `#8b5cf6`, `8b5cf6`, `0x8b5cf6` (or a JSON number) → 0x8b5cf6; anything else → null. */
function parseColor(input) {
    if (typeof input === 'number') return Number.isInteger(input) && input >= 0 && input <= 0xffffff ? input : null;
    const m = /^(?:#|0x)?([0-9a-f]{6})$/i.exec(String(input ?? '').trim());
    return m ? parseInt(m[1], 16) : null;
}
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

function isHttpUrl(text) {
    try { return ['http:', 'https:'].includes(new URL(text).protocol); } catch { return false; }
}

// A link button's emoji: `<:name:id>` / `<a:name:id>`, or a unicode emoji. Anything else would
// only come back from Discord as "Invalid emoji", after the staff member pressed Send.
function toEmoji(text) {
    const custom = /^<(a?):(\w{2,32}):(\d{17,20})>$/.exec(text);
    if (custom) return { id: custom[3], name: custom[2], animated: Boolean(custom[1]) };
    return /^[^\sA-Za-z]{1,16}$/u.test(text) && /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(text)
        ? { name: text } : null;
}
const emojiText = (e) => (e?.id ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e?.name || '');

// ── Limits ────────────────────────────────────────────────────────────────────
const LIMITS = [
    ['title', 256, 'Title'], ['description', 4096, 'Text'], ['authorName', 256, 'Author name'],
    ['footerText', 2048, 'Footer text'], ['content', 2000, 'Message text'],
];
const URLS = [
    ['url', 'Title link'], ['authorIcon', 'Author icon'], ['authorUrl', 'Author link'],
    ['footerIcon', 'Footer icon'], ['thumbnail', 'Thumbnail'], ['image', 'Image'],
];

/** Colour and timestamp alone are not something to look at — such an embed is not sent. */
const embedIsEmpty = (s) => !(s.title || s.description || s.authorName || s.footerText
    || s.thumbnail || s.image || s.fields.length);

/**
 * Discord's own limits, as a sentence a staff member can act on. `sending` adds the one rule a
 * half-built draft may break: there has to be something to send.
 * @returns {string|null}
 */
function validate(s, { sending = false } = {}) {
    for (const [key, max, label] of LIMITS) {
        if (s[key].length > max) return `${label} is ${s[key].length} characters — the limit is ${max}.`;
    }
    if (s.fields.length > 25) return 'An embed holds at most 25 fields.';
    for (const [i, f] of s.fields.entries()) {
        if (!f.name || !f.value) return `Field ${i + 1} needs a name and a value.`;
        for (const [key, max] of [['name', 256], ['value', 1024]]) {
            if (f[key].length > max) return `Field ${i + 1}: the ${key} is ${f[key].length} characters — the limit is ${max}.`;
        }
    }
    const total = [s.title, s.description, s.authorName, s.footerText, ...s.fields.flatMap(f => [f.name, f.value])]
        .join('').length;
    if (total > 6000) return `The embed holds ${total} characters of text — the limit is 6000.`;
    for (const [key, label] of URLS) {
        if (s[key] && !isHttpUrl(s[key])) return `${label} must be an http(s) link.`;
    }
    // Discord drops these silently, so the draft would show something the message never does.
    if (s.url && !s.title) return 'A title link needs a title.';
    if ((s.authorIcon || s.authorUrl) && !s.authorName) return 'An author icon or link needs an author name.';
    if (s.footerIcon && !s.footerText) return 'A footer icon needs footer text.';
    if (s.buttons.length > 5) return 'At most 5 link buttons.';
    for (const [i, b] of s.buttons.entries()) {
        if (!b.label || b.label.length > 80) return `Button ${i + 1} needs a label of 1–80 characters.`;
        if (!isHttpUrl(b.url) || b.url.length > 512) return `Button ${i + 1} needs an http(s) link (at most 512 characters).`;
        if (b.emoji && !toEmoji(b.emoji)) return `Button ${i + 1}: "${b.emoji}" is not an emoji — use one emoji or <:name:id>.`;
    }
    if (sending && !s.content && embedIsEmpty(s)) return 'Nothing to send yet — add some text first.';
    return null;
}

// ── Draft → Discord ───────────────────────────────────────────────────────────
/** The embed as Discord's API JSON — also exactly what Export writes and Import reads. */
function toEmbed(s) {
    const e = {};
    if (s.color !== null) e.color = s.color;
    if (s.title) e.title = s.title;
    if (s.url) e.url = s.url;
    if (s.description) e.description = s.description;
    if (s.authorName) e.author = { name: s.authorName, ...(s.authorIcon && { icon_url: s.authorIcon }), ...(s.authorUrl && { url: s.authorUrl }) };
    if (s.footerText) e.footer = { text: s.footerText, ...(s.footerIcon && { icon_url: s.footerIcon }) };
    if (s.thumbnail) e.thumbnail = { url: s.thumbnail };
    if (s.image) e.image = { url: s.image };
    if (s.fields.length) e.fields = s.fields.map(f => ({ name: f.name, value: f.value, inline: f.inline }));
    if (s.timestamp) e.timestamp = new Date().toISOString();
    return e;
}

/** What goes to the channel: content, the embed (unless empty), one row of link buttons. */
function toMessagePayload(s) {
    return {
        content: s.content,
        embeds: embedIsEmpty(s) ? [] : [toEmbed(s)],
        components: s.buttons.length ? [{
            type: ComponentType.ActionRow,
            components: s.buttons.map(b => ({
                type: ComponentType.Button, style: ButtonStyle.Link, label: b.label, url: b.url,
                ...(b.emoji && { emoji: toEmoji(b.emoji) }),
            })),
        }] : [],
    };
}

const toJson = (s) => JSON.stringify(toMessagePayload(s), null, 2);

/**
 * Who the content may ping: exactly the users and roles written into it. @everyone/@here only
 * when the member may do that in the target channel — the bot usually can, and must not become
 * the way around a missing Mention Everyone.
 */
function allowedMentionsFor(content, canEveryone) {
    const ids = (re) => [...new Set([...content.matchAll(re)].map(m => m[1]))].slice(0, 100);
    const wantsEveryone = /@(?:everyone|here)/.test(content);
    return {
        allowedMentions: {
            users: ids(/<@!?(\d{17,20})>/g),
            roles: ids(/<@&(\d{17,20})>/g),
            ...(wantsEveryone && canEveryone && { parse: ['everyone'] }),
        },
        everyoneDropped: wantsEveryone && !canEveryone,
    };
}

// ── Discord → draft ───────────────────────────────────────────────────────────
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * A message in API JSON shape ({content, embeds, components}) → draft. Reads the first rich
 * embed (a link preview is Discord's, not the author's) and the link buttons.
 */
function fromMessage(msg) {
    const s = newState();
    s.content = str(msg?.content);
    const e = (msg?.embeds || []).find(x => x && (!x.type || x.type === 'rich'));
    if (e) {
        Object.assign(s, {
            color: parseColor(e.color), title: str(e.title), url: str(e.url), description: str(e.description),
            authorName: str(e.author?.name), authorIcon: str(e.author?.icon_url), authorUrl: str(e.author?.url),
            footerText: str(e.footer?.text), footerIcon: str(e.footer?.icon_url),
            thumbnail: str(e.thumbnail?.url), image: str(e.image?.url), timestamp: Boolean(e.timestamp),
            fields: (Array.isArray(e.fields) ? e.fields : [])
                .map(f => ({ name: str(f?.name), value: str(f?.value), inline: Boolean(f?.inline) })),
        });
    }
    s.buttons = (Array.isArray(msg?.components) ? msg.components : []).flatMap(r => r?.components || [])
        .filter(c => c?.type === ComponentType.Button && c.style === ButtonStyle.Link)
        .map(c => ({ label: str(c.label), url: str(c.url), emoji: emojiText(c.emoji) }));
    return s;
}

/**
 * Pasted JSON → draft. Takes a raw embed, a Discord/Discohook message `{content, embeds}`, or a
 * Discohook share/backup `{messages: [{data: {…}}]}`; unknown keys are ignored.
 */
function fromJson(text) {
    let obj;
    try { obj = JSON.parse(text); } catch { return { ok: false, error: 'That is not valid JSON.' }; }
    if (Array.isArray(obj?.messages)) obj = obj.messages[0]?.data;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return { ok: false, error: 'No message or embed found in that JSON.' };
    }
    return { ok: true, state: fromMessage('embeds' in obj || 'content' in obj ? obj : { embeds: [obj] }) };
}

/**
 * Why a message cannot be edited here, or null. Saving writes content, ONE embed and link
 * buttons, so a second embed or a select menu (the #support panel) would silently be deleted.
 */
function editRefusal(msg, botId) {
    if (msg.authorId !== botId) return 'I can only edit messages I sent.';
    if ((msg.embeds || []).filter(e => !e.type || e.type === 'rich').length > 1) return 'That message has more than one embed.';
    const onlyLinks = (msg.components || []).every(r => r.type === ComponentType.ActionRow
        && r.components.every(c => c.type === ComponentType.Button && c.style === ButtonStyle.Link));
    return onlyLinks ? null : 'That message has menus or buttons of its own — edit it where it is built.';
}

// ── Edits ─────────────────────────────────────────────────────────────────────
// kind → [modal title, [input id, label, paragraph?, max length, required?]]. For the first five
// kinds the input ids are the state keys, so the modal's values ARE the patch.
const MODALS = {
    text: ['Title & text', [['title', 'Title', false, 256], ['url', 'Title link (https://…)', false, 2000], ['description', 'Text', true, 4000]]],
    author: ['Author', [['authorName', 'Name', false, 256], ['authorIcon', 'Icon URL', false, 2000], ['authorUrl', 'Link', false, 2000]]],
    footer: ['Footer', [['footerText', 'Text', true, 2048], ['footerIcon', 'Icon URL', false, 2000]]],
    images: ['Images', [['thumbnail', 'Thumbnail URL (small, top right)', false, 2000], ['image', 'Big image URL (bottom)', false, 2000]]],
    content: ['Message text', [['content', 'Text above the embed, e.g. a role ping', true, 2000]]],
    addField: ['Add field', [['name', 'Name', false, 256], ['value', 'Value', true, 1024], ['inline', 'Inline? (yes / no)', false, 3]]],
    editField: ['Edit field — empty name + value removes it', [['name', 'Name', false, 256], ['value', 'Value', true, 1024], ['inline', 'Inline? (yes / no)', false, 3]]],
    addButton: ['Add link button', [['label', 'Label', false, 80, true], ['url', 'Link (https://…)', false, 512, true], ['emoji', 'Emoji (optional)', false, 64]]],
    hex: ['Custom colour', [['hex', 'Hex colour, e.g. #8b5cf6', false, 8, true]]],
    import: ['Import JSON', [['json', 'Discohook or Discord message JSON', true, 4000, true]]],
};

// Menu value → [label, what it does to the draft]. ctx: {logoUrl, botAvatar, userAvatar, userName}.
const ICONS = {
    logoThumb: ['RR logo as thumbnail', (s, c) => { s.thumbnail = c.logoUrl || ''; }],
    // An icon without a name/text is dropped by Discord, so these fill one in rather than
    // making the pick look broken.
    logoAuthor: ['RR logo as author icon', (s, c) => { s.authorIcon = c.logoUrl || ''; s.authorName ||= 'RazorReaper'; }],
    logoFooter: ['RR logo in the footer', (s, c) => { s.footerIcon = c.logoUrl || ''; s.footerText ||= BRAND_FOOTER; }],
    botThumb: ['Bot avatar as thumbnail', (s, c) => { s.thumbnail = c.botAvatar || ''; }],
    meAuthor: ['Your avatar as author', (s, c) => { s.authorIcon = c.userAvatar || ''; s.authorName = c.userName || ''; }],
    rmThumb: ['Remove thumbnail', (s) => { s.thumbnail = ''; }],
    rmAuthorIcon: ['Remove author icon', (s) => { s.authorIcon = ''; }],
    rmFooterIcon: ['Remove footer icon', (s) => { s.footerIcon = ''; }],
};

const PLAIN = ['text', 'author', 'footer', 'images', 'content'];   // their modal values ARE the patch
const text = (v) => String(v ?? '').trim();
const field = (v) => ({ name: text(v.name), value: text(v.value), inline: /^(?:y|yes|ja|true|1)$/i.test(text(v.inline)) });

/**
 * One change to the draft. The whole result is validated, so every path hits the same limits;
 * on an error the caller keeps the old state.
 * @returns {{ok: true, state: object}|{ok: false, error: string}}
 */
function applyEdit(state, kind, v = {}) {
    let s = structuredClone(state);
    if (PLAIN.includes(kind)) for (const [id] of MODALS[kind][1]) s[id] = text(v[id]);
    else switch (kind) {
        case 'addField':
            s.fields.push(field(v));
            break;
        case 'editField': {
            const i = Number(v.index);
            if (!s.fields[i]) return { ok: false, error: 'That field no longer exists.' };
            const f = field(v);
            if (!f.name && !f.value) s.fields.splice(i, 1);
            else s.fields[i] = f;
            break;
        }
        case 'addButton':
            s.buttons.push({ label: text(v.label), url: text(v.url), emoji: text(v.emoji) });
            break;
        case 'clearButtons':
            s.buttons = [];
            break;
        case 'colour':
            if (!(v.key in COLOURS)) return { ok: false, error: 'Unknown colour.' };
            s.color = COLOURS[v.key][1];
            break;
        case 'hex': {
            const c = parseColor(v.hex);
            if (c === null) return { ok: false, error: `"${text(v.hex)}" is not a hex colour — try #8b5cf6.` };
            s.color = c;
            break;
        }
        case 'icons':
            if (!ICONS[v.pick]) return { ok: false, error: 'Unknown icon option.' };
            ICONS[v.pick][1](s, v);
            break;
        case 'timestamp':
            s.timestamp = !s.timestamp;
            break;
        case 'rrStyle':   // the house look; the words stay
            Object.assign(s, { color: BRAND, thumbnail: v.logoUrl || s.thumbnail, footerText: BRAND_FOOTER, timestamp: true });
            break;
        case 'reset':
            s = newState();
            break;
        case 'import': {
            const r = fromJson(text(v.json));
            if (!r.ok) return r;
            s = r.state;
            break;
        }
        default:
            return { ok: false, error: `Unknown edit "${kind}".` };
    }
    const error = validate(s);
    return error ? { ok: false, error } : { ok: true, state: s };
}

// ── The builder UI ────────────────────────────────────────────────────────────
const EDIT_MENU = [
    ['text', '📝 Title & text', 'Title, title link, text'],
    ['author', '👤 Author', 'Name, icon, link'],
    ['footer', '🔻 Footer', 'Text and icon'],
    ['images', '🖼️ Images', 'Thumbnail and big image'],
    ['content', '💬 Message text', 'Plain text above the embed, e.g. a role ping'],
    ['addField', '➕ Add field', 'Name, value, inline'],
    ['editField', '✏️ Edit/remove a field', 'Pick a field, then change or empty it'],
    ['addButton', '🔗 Add link button', 'Label, link, emoji (max 5)'],
    ['clearButtons', '🧹 Remove link buttons', 'Removes all link buttons'],
    ['import', '📥 Import JSON', 'Paste Discohook or Discord JSON'],
    ['export', '📤 Export JSON', 'Get this message as JSON'],
];

/** What a modal opens with: the current values, so editing is not retyping. */
function modalPrefill(s, kind, index) {
    if (kind === 'editField') {
        const f = s.fields[Number(index)];
        return f ? { ...f, inline: f.inline ? 'yes' : 'no' } : {};
    }
    if (kind === 'addField') return { inline: 'no' };
    if (kind === 'hex') return { hex: s.color === null ? '' : hex(s.color) };
    return PLAIN.includes(kind) ? s : {};
}

/** customId `eb:<sid>:m:<kind>[:<index>]`. */
function builderModal(kind, sid, values, index) {
    const [title, inputs] = MODALS[kind];
    return new ModalBuilder()
        .setCustomId(`eb:${sid}:m:${kind}${index === undefined ? '' : `:${index}`}`)
        .setTitle(title.slice(0, 45))
        .addComponents(inputs.map(([id, label, paragraph, max, required = false]) => {
            const input = new TextInputBuilder().setCustomId(id).setLabel(label).setRequired(required)
                .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short).setMaxLength(max);
            // Only when non-empty — an empty value is rejected. ponytail: an imported 4001–4096
            // character text is cut to the modal's 4000 here; only matters if it is then saved.
            if (values[id]) input.setValue(String(values[id]).slice(0, max));
            return new ActionRowBuilder().addComponents(input);
        }));
}

/**
 * The ephemeral builder: builder line + the content and the embed as they will be sent, and
 * five rows of controls (Discord's maximum — which is why the link buttons are a text line).
 * @param {{targetName: string, editing?: boolean, picking?: boolean}} opts  picking = row 1 is
 *        the field picker of "Edit/remove a field"
 */
function builderView(s, sid, { targetName, editing = false, picking = false }) {
    const id = (action) => `eb:${sid}:${action}`;
    const select = (action, placeholder, options) => new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(id(action)).setPlaceholder(placeholder.slice(0, 150)).addOptions(options));
    const button = (action, label, style) => new ButtonBuilder().setCustomId(id(action)).setLabel(label.slice(0, 80)).setStyle(style);

    const head = [
        `-# 🛠️ Embed builder → #${targetName}${editing ? ' (editing a message)' : ''} · only you see this`,
        s.buttons.length && `-# 🔗 Link buttons: ${s.buttons.map(b => `${b.emoji ? `${b.emoji} ` : ''}${b.label}`).join(' · ')}`,
        s.content,
    ].filter(Boolean).join('\n');
    const embed = embedIsEmpty(s)
        ? { ...(s.color !== null && { color: s.color }), description: '-# Empty embed — it is not sent. Use ✏️ Edit… to add text.' }
        : toEmbed(s);

    const firstRow = picking
        ? select('field', 'Pick the field to edit or remove…', [
            ...s.fields.map((f, i) => ({
                label: `${i + 1}. ${f.name}`.slice(0, 100), value: String(i),
                description: f.value.replace(/\s+/g, ' ').slice(0, 100),
            })),
            { label: '← Back', value: 'back' },
        ].slice(0, 25))   // at 25 fields Back is what drops, not field 25: any other control leaves the picker too
        : select('edit', '✏️ Edit…', EDIT_MENU.map(([value, label, description]) => ({ value, label, description })));
    const colourName = Object.values(COLOURS).find(([, c]) => c === s.color)?.[0] ?? hex(s.color);

    return {
        content: head.length > 2000 ? `${head.slice(0, 1999)}…` : head,
        embeds: [embed],
        components: [
            firstRow,
            select('colour', `🎨 Colour: ${colourName}`, [
                ...Object.entries(COLOURS).map(([value, [label, c, emoji]]) => ({
                    value, label: `${emoji} ${label}`, description: c === null ? 'Plain grey stripe' : hex(c),
                })),
                { value: 'custom', label: '🎨 Custom hex…', description: '#8b5cf6, 8b5cf6 or 0x8b5cf6' },
            ]),
            select('icons', '🖼️ Icons', Object.entries(ICONS).map(([value, [label]]) => ({ value, label }))),
            new ActionRowBuilder().addComponents(
                button('ts', `⏱️ Timestamp: ${s.timestamp ? 'on' : 'off'}`, s.timestamp ? ButtonStyle.Success : ButtonStyle.Secondary),
                button('style', '✨ RR style', ButtonStyle.Primary),
                button('reset', '🗑️ Reset', ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                button('send', editing ? '💾 Save changes' : `✅ Send to #${targetName}`, ButtonStyle.Success),
                button('cancel', '❌ Cancel', ButtonStyle.Danger),
            ),
        ],
        allowedMentions: { parse: [] },   // the preview of a ping must not ping
    };
}

module.exports = {
    newState, applyEdit, validate, parseColor, toEmbed, toMessagePayload, toJson,
    fromMessage, fromJson, editRefusal, allowedMentionsFor, builderView, builderModal, modalPrefill,
    COLOURS, MODALS,
};
