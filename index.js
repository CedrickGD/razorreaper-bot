// Redirect-shell mode (migration): with REDIRECT_TO set this process only forwards the old public
// URL to the new host and never touches Discord. See redirect.js.
if (process.env.REDIRECT_TO) {
    require('./redirect');
    return;
}

const { Client, GatewayIntentBits, Partials, ActivityType, EmbedBuilder, PermissionsBitField, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, SlashCommandBuilder, REST, Routes, ChannelType, ApplicationCommandOptionType, OverwriteType, MessageFlags, ComponentType } = require('discord.js');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { initNotifier, stopNotifier } = require('./notifier');
const { planRoleChanges } = require('./role-plan');
const {
    buildTopic, parseTopic, rebuildTicketState, countAutoAnswers, nextTicketNumber, ticketChannelName, checkLimits,
    slowmodeSeconds, deletableTickets, makeWaiting, parseBotCommand, TICKET_BUTTONS, TICKET_COMMANDS,
} = require('./ticket-state');
const ai = require('./ai-support');
const {
    rrEmbed, brandThumb, shortLine, ticketLogEntry,
    BRAND, BRAND_BAD, BRAND_GOOD,
} = require('./brand');
const panelApi = require('./panel-client');
const { loadIds, saveIds, looseName } = require('./id-store');

// GuildMessages (non-privileged) lets the notifier receive message events in
// watched channels. NOTE: Discord withholds .content AND .embeds/.attachments of
// messages authored by other users/bots unless the PRIVILEGED MessageContent
// intent is enabled, so reading MESA-style alert embeds effectively requires
// NOTIFIER_MESSAGE_CONTENT=true. Only set that flag AFTER enabling Message
// Content Intent in the Discord Developer Portal (Bot → Privileged Gateway
// Intents), otherwise login fails with a disallowed intent and the whole bot
// goes down — which is why it stays opt-in instead of always-on.
const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
];
if (process.env.NOTIFIER_MESSAGE_CONTENT === 'true') {
    intents.push(GatewayIntentBits.MessageContent);
}

const client = new Client({
    intents,
    partials: [Partials.Channel, Partials.GuildMember],
});

// Notifier backend (HTTP/SSE relay for RazorReaper desktop clients). Started
// before Discord login so Railway's /health check answers even while the
// gateway connection is still coming up (or Discord is having an outage).
try {
    initNotifier(client);
} catch (err) {
    console.error('[RazorReaper] Failed to start notifier backend:', err.message || err);
}

const ACCENT = 0x9b1a1a;
const CYAN   = 0x00e5ff;

// ── Pinned ids ────────────────────────────────────────────────────────────────
// Every channel and role the bot relies on resolves the same way: an env id wins, then the id
// stored in ids.json (if it still exists), then a loose name match, then — only where the bot
// creates things — a fresh one. Whatever was found by name or created is stored, so the owner
// can rename it afterwards and the next start still finds it; that is what stops a restart from
// making a second "Tickets". Env ids are never written: the env stays the source of truth.
// Same persistent dir notifier.js keeps channels.json in.
const IDS_FILE = path.join(process.env.NOTIFIER_DATA_DIR || '/data', 'ids.json');
const storedIds = loadIds(IDS_FILE);
const idLog = {};                    // key -> "key=id (source)", printed once on ready

// Records where `found` came from and stores it when it came from a name or a create. `found` is
// a channel/role, or an array of ids (staffRoles). Returns `found` so callers can return it.
function pinId(key, found, source) {
    const id = Array.isArray(found) ? found : found.id;
    idLog[key] = `${key}=${[].concat(id).join(',') || 'none'} (${source})`;
    if ((source === 'name' || source === 'created') && [].concat(id).length
        && JSON.stringify(storedIds[key]) !== JSON.stringify(id)) {
        storedIds[key] = id;
        saveIds(IDS_FILE, storedIds);
    }
    return found;
}

// env -> stored -> loose name. `matches(looseName, item)` decides the name step.
function findPinned(cache, key, envId, matches) {
    const env = envId && cache.get(envId);
    if (env) return pinId(key, env, 'env');
    const stored = typeof storedIds[key] === 'string' && cache.get(storedIds[key]);
    if (stored) return pinId(key, stored, 'stored');
    const byName = cache.find(x => matches(looseName(x.name), x));
    return byName ? pinId(key, byName, 'name') : null;
}

// Staff roles: STAFF_ROLE_IDS (comma list) wins, then the stored ids, then any role whose loose
// name is one of these — the live roles carry emoji ("🛡️ Admin"), which is why an exact name
// match found none of them. Resolved on ready (resolveStaffRoles) into a Set of ids.
const STAFF_ROLE_IDS_ENV = (process.env.STAFF_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const STAFF_ROLE_NAMES = ['owner', 'admin', 'moderator', 'supportstaff'];
let staffRoleIds = new Set(STAFF_ROLE_IDS_ENV);

function resolveStaffRoles(guild) {
    if (!guild) return;
    const roles = guild.roles.cache;
    const stored = (Array.isArray(storedIds.staffRoles) ? storedIds.staffRoles : []).filter(id => roles.has(id));
    const [ids, source] = STAFF_ROLE_IDS_ENV.length ? [STAFF_ROLE_IDS_ENV, 'env']
        : stored.length ? [stored, 'stored']
        : [roles.filter(r => STAFF_ROLE_NAMES.includes(looseName(r.name))).map(r => r.id), 'name'];
    staffRoleIds = new Set(ids);
    pinId('staffRoles', ids, source);
}

// Staff roles as ticket-channel overwrites; an id that is not a role here would fail the create.
function staffOverwrites(guild, allow) {
    return [...staffRoleIds].filter(id => guild.roles.cache.has(id))
        .map(id => ({ id, type: OverwriteType.Role, allow }));
}

// Warn storage (in-memory, resets on restart - good enough for a small server)
const warns = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
function isStaff(member) {
    return member.id === member.guild.ownerId ||
           member.permissions.has(PermissionsBitField.Flags.Administrator) ||
           member.roles.cache.some(r => staffRoleIds.has(r.id));
}

// Ticket Tool names tickets ticket-0001, ticket-0002 …, this bot pads to the same four digits,
// and every other piece of ticket logic in this file (numbering, limits, the close rename, the
// auto-delete sweep) is keyed on those digits. The prefix alone is NOT enough: #ticket-log is a
// staff channel, not a ticket, and a loose match made /queue count it and the transcript
// listeners snapshot every staff message in it.
const TICKET_NAME_RE = /^ticket-\d+$/i;
const ANY_TICKET_NAME_RE = /^(?:ticket|closed)-\d+$/i;
function isTicketChannel(channel) {
    return TICKET_NAME_RE.test(channel?.name || '');
}

function embed(color, desc, title) {
    const e = new EmbedBuilder().setColor(color);
    if (title) e.setTitle(title);
    if (desc)  e.setDescription(desc);
    return e;
}

function staffEmbed(desc, title) { return embed(ACCENT, desc, title); }
function infoEmbed(desc, title)  { return embed(CYAN,   desc, title); }
function errEmbed(desc)          { return embed(0xff4444, desc); }
function okEmbed(desc)           { return embed(0x00cc66, desc); }

// The verify surface is a support surface: #verify's panel is an rrEmbed, so the replies /verify
// gives right underneath it are too — otherwise a customer gets the rebranded panel and an
// off-brand answer to it in the same breath. These two keep the brand rules (five-word title, two
// short lines a block) without repeating the same rrEmbed options thirteen times; the generic
// helpers above stay where they are for the moderation commands, whose long lists do not fit
// those rules. No footer: these are one-line ephemeral replies, the way the ticket buttons refuse.
const verifyOk = (title, ...blocks) => rrEmbed({ title, blocks, colour: BRAND_GOOD, footer: null });
const verifyBad = (title, ...blocks) => rrEmbed({ title, blocks, colour: BRAND_BAD, footer: null });

// ── License-verified community gate ─────────────────────────────────────────────
// Turns the server into a paid-only community: only members whose Discord is linked to a valid
// RazorReaper license (checked against the admin panel) get the "Verified Customer" role.
// Everything here is inert unless VERIFY_API_BASE + VERIFY_SHARED_SECRET + VERIFIED_ROLE_ID are
// all configured, so the bot keeps running normally on a server that hasn't opted in.
// Non-secret IDs carry hardcoded RazorReaper-server defaults so the bot survives a host whose
// env vars go missing; env vars still win when set.
const VERIFY_API_BASE = (process.env.VERIFY_API_BASE || '').replace(/\/+$/, '');
const VERIFY_SECRET = process.env.VERIFY_SHARED_SECRET || '';
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID || '1529566161900146689'; // ✅ Verified Customer
const VERIFY_GUILD_ID = process.env.VERIFY_GUILD_ID || process.env.GUILD_ID || '1487503515512475792';
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID || '1529936856307863653'; // #verify
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID || '1487508255050567690'; // Member — every human gets this on join
const RECONCILE_MINUTES = Number(process.env.VERIFY_RECONCILE_MINUTES || 30);
// Extra badge on top of the customer role for lifetime licences. No hardcoded default: when the
// env var is empty the bot finds a role named "Lifetime" in the home guild, or creates one.
const LIFETIME_ROLE_ID_ENV = process.env.LIFETIME_ROLE_ID || '';
const verifiedRoleMention = () => `<@&${VERIFIED_ROLE_ID}>`;

function verifyConfigured() {
    return Boolean(VERIFY_API_BASE && VERIFY_SECRET && VERIFIED_ROLE_ID);
}

// The ticket features that talk to the panel (client data, purchase info, the ticket archive)
// need the API and the shared secret, but not the role gate — a server without VERIFIED_ROLE_ID
// still gets them.
function panelConfigured() {
    return Boolean(VERIFY_API_BASE && VERIFY_SECRET);
}

// POST to the admin panel's Discord API with the shared secret. Returns { status, data }.
// Bounded: every caller is an interaction or a sweep that has something waiting behind it, and
// an unreachable NAS otherwise parks a bare fetch for undici's five-minute default. 30 s is long
// even for the 800 KB transcript upload, which is the biggest body that goes through here.
async function verifyApi(pathname, body) {
    const res = await fetch(`${VERIFY_API_BASE}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VERIFY_SECRET}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

// Grant the customer role, plus the Lifetime badge when the panel says the licence is one.
async function grantVerifiedRole(guild, userId, lifetime = false) {
    try {
        if (!guild) return false;
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return false;
        if (lifetime) {
            const role = await ensureLifetimeRole(guild);
            if (role && !member.roles.cache.has(role.id)) {
                await member.roles.add(role.id, 'RazorReaper lifetime license')
                    .catch(e => console.error('[verify] Failed to grant Lifetime role:', e.message || e));
            }
        }
        if (member.roles.cache.has(VERIFIED_ROLE_ID)) return true;
        await member.roles.add(VERIFIED_ROLE_ID, 'RazorReaper license verified');
        return true;
    } catch (e) {
        console.error('[verify] Failed to grant role:', e.message || e);
        return false;
    }
}

// Resolve the guild the gate operates on (explicit VERIFY_GUILD_ID, else the only guild).
function verifyGuild() {
    if (VERIFY_GUILD_ID) return client.guilds.cache.get(VERIFY_GUILD_ID) || null;
    return client.guilds.cache.first() || null;
}

// ── Lifetime role ─────────────────────────────────────────────────────────────
// LIFETIME_ROLE_ID wins; otherwise the stored id, then an existing role named "Lifetime" is
// adopted, and only if there is none does the bot create it. A self-created role lands below the
// bot's own role, so it is manageable straight away. Found-by-name and created ids are pinned.
let lifetimeRoleId = LIFETIME_ROLE_ID_ENV || null;
let warnedLifetimeMissing = false;
// Three call sites reach this function (ready, /verify + guildMemberAdd via grantVerifiedRole,
// reconcile) and any two of them can be inside the create() await together — both would see no
// role and create a second "Lifetime". Sharing the in-flight create, the way fetchGuildMembers
// shares its fetch below, makes the creation happen exactly once.
let lifetimeRoleCreate = null;
async function ensureLifetimeRole(guild) {
    if (!guild) return null;
    if (LIFETIME_ROLE_ID_ENV) {
        const role = guild.roles.cache.get(LIFETIME_ROLE_ID_ENV);
        // A configured id that resolves to nothing would silently disable the badge — say so once.
        if (!role && !warnedLifetimeMissing) {
            warnedLifetimeMissing = true;
            console.error(`[verify] Lifetime role ${LIFETIME_ROLE_ID_ENV} does not exist in this guild — check LIFETIME_ROLE_ID.`);
        }
        return role ? pinId('lifetimeRole', role, 'env') : null;
    }
    const existing = findPinned(guild.roles.cache, 'lifetimeRole', '', name => name === 'lifetime');
    if (existing) { lifetimeRoleId = existing.id; return existing; }
    if (!guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        console.error('[verify] No Manage Roles permission — cannot create the Lifetime role. Set LIFETIME_ROLE_ID instead.');
        return null;
    }
    try {
        if (!lifetimeRoleCreate) {
            lifetimeRoleCreate = guild.roles.create({
                name: 'Lifetime',
                color: 0xf0b132,
                mentionable: false,
                reason: 'RazorReaper: badge for lifetime licence holders',
            }).then(role => { console.log(`[verify] Created the Lifetime role (${role.id}).`); return role; });
            // A failed create must not be cached — the next sweep gets to try again.
            lifetimeRoleCreate.catch(() => { lifetimeRoleCreate = null; });
        }
        const role = await lifetimeRoleCreate;
        lifetimeRoleId = role.id;
        return pinId('lifetimeRole', role, 'created');
    } catch (e) {
        console.error('[verify] Failed to create the Lifetime role:', e.message || e);
        return null;
    }
}

// ── Shared member fetch ───────────────────────────────────────────────────────
// The licence reconcile and the Member backfill both need the whole member list, and Discord
// rate-limits gateway opcode 8 when two of those land together ("Request with opcode 8 was rate
// limited"). One shared, short-lived fetch keeps the two sweeps off each other's toes. The
// members it hands back are live objects, so only guild membership itself can be a few minutes
// stale — and joiners already get their roles from guildMemberAdd.
const MEMBERS_TTL_MS = 5 * 60_000;
let membersFetch = { at: 0, promise: null };
function fetchGuildMembers(guild) {
    if (membersFetch.promise && Date.now() - membersFetch.at < MEMBERS_TTL_MS) return membersFetch.promise;
    const promise = guild.members.fetch();
    membersFetch = { at: Date.now(), promise };
    // A failed fetch must not be cached — but swallow it here, the caller handles the rejection.
    promise.catch(() => { if (membersFetch.promise === promise) membersFetch = { at: 0, promise: null }; });
    return promise;
}

// Periodic sweep: ONE bulk call to the panel, then make Discord match it — customer role ⇔ an
// active link, Lifetime role ⇔ an active lifetime link. It grants as well as strips, so a link
// the owner creates in the admin panel lands without the member running /verify. Every decision
// that could mass-strip lives in planRoleChanges (role-plan.js) and is unit-tested.
async function reconcileVerifiedRoles() {
    if (!verifyConfigured()) return;
    const guild = verifyGuild();
    if (!guild) return;

    let data = null;
    try {
        ({ data } = await verifyApi('/api/discord/links', {}));
    } catch (e) {
        console.error('[verify] Reconcile: /api/discord/links call failed —', e.message || e, '— nothing changed.');
        return;
    }

    let members;
    try {
        members = await fetchGuildMembers(guild);
    } catch (e) {
        console.error('[verify] Reconcile: member fetch failed:', e.message || e);
        return;
    }

    const lifetimeRole = await ensureLifetimeRole(guild);
    // Collection#map returns a plain array — role-plan.js stays free of discord.js types.
    const snapshot = members.map(m => ({ id: m.id, bot: m.user.bot, roles: [...m.roles.cache.keys()] }));
    const plan = planRoleChanges(data, snapshot, {
        verified: VERIFIED_ROLE_ID,
        lifetime: lifetimeRole?.id || null,
    });
    if (!plan.ok) {
        console.error(`[verify] Reconcile aborted — ${plan.reason}. No roles changed.`);
        return;
    }

    // Same editability guard the Member backfill uses: a role above the bot silently fails on
    // every single member otherwise.
    const manageable = (roleId) => Boolean(guild.roles.cache.get(roleId)?.editable);
    for (const roleId of [VERIFIED_ROLE_ID, lifetimeRole?.id]) {
        if (roleId && !manageable(roleId)) {
            console.error(`[verify] Role ${roleId} is above my highest role — skipping it this sweep.`);
        }
    }

    let added = 0;
    let removed = 0;
    for (const change of plan.changes) {
        const m = members.get(change.id);
        if (!m) continue;
        const add = change.add.filter(manageable);
        const remove = change.remove.filter(manageable);
        try {
            if (add.length) { await m.roles.add(add, 'RazorReaper license active (reconcile)'); added += add.length; }
            if (remove.length) { await m.roles.remove(remove, 'RazorReaper license no longer valid (reconcile)'); removed += remove.length; }
        } catch (e) {
            console.error(`[verify] Reconcile: role update failed for ${m.user.tag}:`, e.message || e);
        }
    }
    if (added || removed) console.log(`[verify] Reconcile: ${added} role(s) granted, ${removed} stripped across ${plan.changes.length} member(s).`);
}

// ── Member auto-role ──────────────────────────────────────────────────────────
// Every human in the community holds the base Member role: granted instantly on join
// (see guildMemberAdd below) and backfilled here for anyone who slipped through
// (e.g. joined while the bot was down). Idempotent and best-effort.
async function backfillMemberRole() {
    if (!MEMBER_ROLE_ID) return;
    const guild = verifyGuild();
    if (!guild) return;
    const role = guild.roles.cache.get(MEMBER_ROLE_ID);
    if (!role) { console.error('[member-role] Member role not found — check MEMBER_ROLE_ID.'); return; }
    if (!role.editable) { console.error('[member-role] Member role is above my highest role — cannot assign it.'); return; }
    try {
        const members = await fetchGuildMembers(guild);
        const missing = members.filter(m => !m.user.bot && !m.roles.cache.has(MEMBER_ROLE_ID));
        let added = 0;
        for (const [, m] of missing) {
            try { await m.roles.add(MEMBER_ROLE_ID, 'Member auto-role (backfill)'); added++; }
            catch (e) { console.error(`[member-role] Backfill failed for ${m.user.tag}:`, e.message || e); }
        }
        if (added) console.log(`[member-role] Backfilled Member role for ${added} member(s).`);
    } catch (e) {
        console.error('[member-role] Backfill sweep failed:', e.message || e);
    }
}

// ── Verify-panel sync ─────────────────────────────────────────────────────────
// The #verify channel holds a bot-authored "Unlock the Community" panel. On startup the bot
// re-syncs it: stale hardcoded role names in the description are swapped for a live role
// mention (renders as the current role name, so future renames need no edit here), and if the
// panel vanished entirely a fresh one is posted.
const VERIFY_PANEL_TITLE = 'Unlock the Community';

// A panel is simply the bot's own message carrying a known embed title. Both panels (#verify and
// #support) are found this way, so neither needs an id stored anywhere and a deleted panel just
// gets reposted on the next start.
// #ticket-log is the one channel where a panel is NOT the newest message — it collects one row
// per ticket, so a ticket that stays open while others come and go has its row pushed down. That
// is what `pages` is for; the two real panels stay at one page, which is what they always did.
// ponytail: 100 messages a page, a handful of pages — a row older than that gets a second row in
// the log instead of an edit. Store the message id if that ever becomes the normal case.
async function findOwnPanel(channel, title, pages = 1) {
    let before;
    for (let page = 0; page < pages; page++) {
        const msgs = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        const hit = msgs.find(m => m.author.id === client.user.id && m.embeds[0]?.title === title);
        if (hit) return hit;
        if (msgs.size < 100) return null;
        before = msgs.last().id;
    }
    return null;
}

// One source for the panel's role sentence — used both when posting a fresh panel and when
// re-syncing the live one, so the two can never drift apart.
function verifyRoleLine(guild) {
    const roleName = guild.roles.cache.get(VERIFIED_ROLE_ID)?.name || 'Verified Customer';
    const lifetimeName = lifetimeRoleId ? guild.roles.cache.get(lifetimeRoleId)?.name : null;
    return `You instantly get the **${roleName}** role.`
        + (lifetimeName ? ` Lifetime licences also get **${lifetimeName}**.` : '');
}

function buildVerifyPanelEmbed(guild) {
    // `pinnedId` first (the lounge is the bot's own channel); the rest are the owner's, by name.
    const chanRef = (part, pinnedId) => {
        const c = (pinnedId && guild.channels.cache.get(pinnedId)) || guild.channels.cache.find(ch =>
            (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) && ch.name.includes(part));
        return c ? `<#${c.id}>` : `#${part}`;
    };
    const e = rrEmbed({
        title: VERIFY_PANEL_TITLE,
        blocks: [
            '🔒 This server is for RazorReaper licence holders.',
            'Run `/verify key:XXXX-XXXX-XXXX-XXXX` right here.\nYour reply is private — nobody else sees your key.',
            verifyRoleLine(guild),
        ],
        fields: [
            { name: 'What you unlock', value: `${chanRef('lounge', CUSTOMER_CHAT_ID || storedIds.customerChat)} — the customers-only lounge\n${chanRef('releases')} — new builds first\n${chanRef('changelog')} — full patch notes`, inline: true },
            { name: "Where's my key?", value: 'In your purchase confirmation from [razorreaper.app](https://razorreaper.app).', inline: true },
        ],
        thumb: brandThumb(guild, client.user),
    });
    if (VERIFY_API_BASE) {
        e.addFields({ name: 'Prefer one click?', value: `[Link Discord directly](${VERIFY_API_BASE}/api/discord/oauth-start?key=YOUR-KEY) — replace \`YOUR-KEY\`.` });
    }
    return e;
}

async function syncVerifyPanel() {
    if (!VERIFY_CHANNEL_ID || !VERIFIED_ROLE_ID) return;
    const guild = verifyGuild();
    if (!guild) return;
    const ch = guild.channels.cache.get(VERIFY_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) return;
    try {
        const panel = await findOwnPanel(ch, VERIFY_PANEL_TITLE);
        if (!panel) {
            await ch.send({ embeds: [buildVerifyPanelEmbed(guild)] });
            console.log('[verify] Panel not found — posted a fresh one.');
            return;
        }
        // Rebuild the panel from the current builder and edit only when the TEXT actually
        // differs. This used to be a regex that swapped the stale role line in place, which
        // kept the role names current but left every other word frozen at whatever the panel
        // was posted with — a redesign of the panel would never have reached the live server.
        // Comparing the text we author (and the colour) rather than the whole embed avoids an
        // edit on every boot: a received embed carries proxy urls and sizes we never set.
        const eb = buildVerifyPanelEmbed(guild);
        const textOf = (e) => JSON.stringify({
            title: e?.title || '',
            description: e?.description || '',
            fields: (e?.fields || []).map(f => [f.name, f.value, Boolean(f.inline)]),
            color: e?.color ?? null,
        });
        const edit = { embeds: [eb] };
        // The logo lives as a message attachment shown ONLY as the embed thumbnail. An edit
        // must re-upload it and point the thumbnail at attachment://<name> — otherwise
        // Discord orphans the file (it renders as a huge bare image above the embed) and the
        // copied CDN link rots as its signature expires.
        const logo = panel.attachments.find(a => (a.contentType || '').startsWith('image/'));
        if (logo) eb.setThumbnail(`attachment://${logo.name}`);
        if (textOf(panel.embeds[0]) === textOf(eb.data)) {
            console.log('[verify] Panel already current.');
            return;
        }
        if (logo) {
            const res = await fetch(logo.url);
            if (res.ok) {
                edit.files = [new AttachmentBuilder(Buffer.from(await res.arrayBuffer()), { name: logo.name })];
                edit.attachments = [];
            }
        }
        await panel.edit(edit);
        console.log(`[verify] Panel updated — role line now reads "${verifyRoleLine(guild)}".`);
    } catch (e) {
        console.error('[verify] Panel sync failed:', e.message || e);
    }
}

// ── Community chats ───────────────────────────────────────────────────────────
// Two rooms the server is supposed to have, made to exist at startup and never duplicated:
// #reaper-lounge for paying customers only, and a plain members chat. An explicit id wins,
// then any channel that already looks like it, and only then does the bot create one.
const CUSTOMER_CHAT_ID = process.env.CUSTOMER_CHAT_ID || '';
const GENERAL_CHAT_ID = process.env.GENERAL_CHAT_ID || '';

// Find-or-create, idempotent: an explicit id wins, then the id pinned under storeKey, then
// anything whose loose name (looseName) looks like it, and only then is one created. Shared by
// the community chats and by the support channel + Tickets category below, so there is exactly
// one place that knows how to not duplicate a channel.
let warnedNoChannelPerm = false;
async function ensureChannel(guild, { envId, storeKey, type = ChannelType.GuildText, looksLikeIt, ...spec }) {
    const existing = findPinned(guild.channels.cache, storeKey, envId, (name, c) => c.type === type && looksLikeIt(name));
    if (existing) return existing;
    if (!guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        if (!warnedNoChannelPerm) {
            warnedNoChannelPerm = true;
            console.log('[chats] No Manage Channels permission — not creating channels. Create them by hand and set CUSTOMER_CHAT_ID / GENERAL_CHAT_ID / SUPPORT_CHANNEL_ID / TICKETS_CATEGORY_ID.');
        }
        return null;
    }
    try {
        const ch = await guild.channels.create({ ...spec, type });
        console.log(`[chats] Created ${ch.name} (${ch.id}).`);
        return pinId(storeKey, ch, 'created');
    } catch (e) {
        console.error(`[chats] Failed to create ${spec.name}:`, e.message || e);
        return null;
    }
}

async function ensureCommunityChannels(guild) {
    if (!guild) return;
    const me = guild.members.me;
    const P = PermissionsBitField.Flags;
    // Keep them with the rest of the community rooms — #verify's category is the best anchor.
    const parent = guild.channels.cache.get(VERIFY_CHANNEL_ID)?.parentId || null;
    const ensure = (storeKey, envId, looksLikeIt, spec) => ensureChannel(guild, { storeKey, envId, looksLikeIt, parent, ...spec });

    // Customers only: invisible to @everyone, open to the customer role (and to the bot, so it
    // can post there later without an extra permission pass). Overwrite types are explicit:
    // without them discord.js resolves each id through its caches and the create throws
    // "Supplied parameter is not a cached User or Role" (seen live on the first deploy).
    await ensure('customerChat', CUSTOMER_CHAT_ID, name => name.includes('lounge'), {
        name: 'reaper-lounge',
        topic: 'Customers only — the lounge is open while your RazorReaper licence is active.',
        permissionOverwrites: [
            { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
            { id: VERIFIED_ROLE_ID, type: OverwriteType.Role, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
            ...(me ? [{ id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] }] : []),
        ],
        reason: 'RazorReaper: customers-only lounge',
    });

    // The ordinary room for everyone in the community — skipped entirely if the server already
    // has any general/chat channel, which it almost always does.
    await ensure('generalChat', GENERAL_CHAT_ID, name => name.includes('general') || name.includes('chat'), {
        name: 'general',
        topic: 'Open chat for every member of the community.',
        permissionOverwrites: [
            { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
            { id: MEMBER_ROLE_ID, type: OverwriteType.Role, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
            ...(me ? [{ id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] }] : []),
        ],
        reason: 'RazorReaper: members chat',
    });
}

// ── AI support tickets ────────────────────────────────────────────────────────
// #support holds ONE bot panel with a category select. Picking a category opens a modal with
// required fields, and only a form that survives AI triage becomes a channel — that is the whole
// point: no empty "hi can u help" tickets, and no model tokens spent on them either.
//
// The channels are plain `ticket-NNNN`, so everything that already exists keeps working
// unchanged: /close, /ticket, /queue, /ticketinfo, /adduser and the transcript DM on close.
// The topic holds what cannot change (opener, category, closed); everything else lives in the
// Maps below and is rebuilt from the ticket's own messages after a restart — see ticket-state.js.
const SUPPORT_CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID || '';
const TICKETS_CATEGORY_ID = process.env.TICKETS_CATEGORY_ID || '';
const TICKET_LOG_CHANNEL_ID = process.env.TICKET_LOG_CHANNEL_ID || '';
const SUPPORT_PANEL_TITLE = '🎟️ RazorReaper Support';
const AI_MAX_REPLIES = 8;            // per ticket, then a human takes over
const TICKET_HISTORY = 12;           // turns of context sent with a follow-up
const TICKET_SCAN = 50;              // messages read per follow-up: history is the last 12 of these,
                                     // but the reply cap has to count them ALL or a long ticket
                                     // would slip past 8 simply by pushing them out of the window.
// Discord's own slowmode is the "message cooldown" — server-side, staff bypass it natively, and
// it costs the bot nothing. One number, clamped, applied when the channel is created.
const TICKET_SLOWMODE = slowmodeSeconds(process.env.TICKET_SLOWMODE_SECONDS);
// Closed tickets disappear by themselves this many hours after the close. "0" = never, and so is
// anything unparseable — never deleting is the safe direction for the only irreversible action
// in this file. `|| 24` reads an unset or blank var as the default; "0" is a truthy string and
// survives it.
const TICKET_AUTO_DELETE_HOURS = Number(process.env.TICKET_AUTO_DELETE_HOURS || 24);
// A member may have one open ticket PER CATEGORY, so the daily cap can never be the thing that
// stops them using the categories — it is derived, not a second knob to get wrong.
const TICKET_MAX_PER_DAY = Math.max(3, ai.CATEGORY_KEYS.length);
// Who gets pinged when a ticket asks for a person. Discord already has the mechanism for "these
// people are on duty" — a role — so there is nothing to store: whoever holds HUMAN_PING_ROLE_ID
// is pinged, and with no role (or nobody in it) the owner is, exactly as before. The bot never
// creates it: a role found by NAME is how this server ended up with duplicates.
const HUMAN_PING_ROLE_ID = process.env.HUMAN_PING_ROLE_ID || '';
const HUMAN_PING_MAX = 10;           // a ping list longer than this is noise, not urgency

const aiProviders = ai.buildProviders(process.env);
const aiKb = ai.loadKb();
console.log(`[ai] knowledge base per category (≈tokens): ${ai.CATEGORY_KEYS.filter(c => !ai.HUMAN_ONLY.has(c))
    .map(c => `${c} ${(ai.kbFor(aiKb, c).length / 4000).toFixed(1)}k`).join(', ')}`);
const support = ai.createSupport({
    providers: aiProviders,
    kb: aiKb,
    budget: ai.makeBudget(Number(process.env.AI_DAILY_TOKEN_BUDGET || 400_000)),
});
const aiInFlight = new Set();        // channelIds with a call in the air — one per ticket
// Everything below changes while a ticket is open, and a channel topic is the one place it must
// NOT live: Discord allows two channel edits per 10 minutes, so a topic written on a hot path
// stalls in discord.js's queue and takes whatever awaits it with it. A restart empties these; the
// first thing that happens in a ticket afterwards rebuilds them from its own history
// (hydrateTicket → rebuildTicketState), which costs one message fetch per ticket per process.
const aiOn = new Map();              // channelId -> is the AI answering here; unset = ask the topic
const aiReplyCount = new Map();      // channelId -> answers posted here since the last re-enable
const ticketProvider = new Map();    // channelId -> the provider that last answered, for the archive
const reportAsked = new Set();       // channelIds where the support report was already requested
const humanPinged = new Set();       // channelIds where a real ping went out — written by humanPing() alone
const closedTickets = new Map();     // channelId -> when it was closed, from the moment it closes
const hydrated = new Set();          // channelIds already rebuilt in this process
// "Waiting for the support report" is a third state next to on/off: the AI stays quiet in that
// ticket until the member presses a button, sends a Report ID, or 30 minutes pass.
const reportWaiting = makeWaiting();
let ticketCreateChain = Promise.resolve();  // serialises ticket numbering + creation
let warnedNoMessageContent = false;
let ticketLogChannelId = TICKET_LOG_CHANNEL_ID || null;
// Resolved by ensureSupportChannels on ready: new tickets go under the category, /ticket and the
// welcome embed link the support channel — by id, whatever the owner has renamed them to.
let ticketsCategoryId = TICKETS_CATEGORY_ID || null;
let supportChannelId = SUPPORT_CHANNEL_ID || null;
const supportChannelRef = (guild) =>
    (supportChannelId && guild?.channels.cache.has(supportChannelId) ? `<#${supportChannelId}>` : 'the support channel');
// The welcome embed's channels, found once on ready (env -> stored -> loose name).
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '';
const RULES_CHANNEL_ID = process.env.RULES_CHANNEL_ID || '';
let welcomeChannelId = null;
let rulesChannelId = null;

// ── Support channel + Tickets category ────────────────────────────────────────
async function ensureSupportChannels(guild) {
    if (!guild) return {};
    const me = guild.members.me;
    const P = PermissionsBitField.Flags;

    const category = await ensureChannel(guild, {
        envId: TICKETS_CATEGORY_ID,
        storeKey: 'ticketsCategory',
        type: ChannelType.GuildCategory,
        looksLikeIt: name => name === 'tickets',
        name: 'Tickets',
        reason: 'RazorReaper: home for support ticket channels',
    });

    // Read-only for members: the panel is the only way in, so nobody can bury it under chatter.
    const channel = await ensureChannel(guild, {
        envId: SUPPORT_CHANNEL_ID,
        storeKey: 'supportChannel',
        looksLikeIt: name => name === 'support',
        name: 'support',
        topic: 'Open a support ticket — pick a category in the panel above.',
        parent: category?.id || null,
        permissionOverwrites: [
            { id: guild.id, type: OverwriteType.Role, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.AddReactions, P.CreatePublicThreads] },
            ...(me ? [{ id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages] }] : []),
        ],
        reason: 'RazorReaper: support panel',
    });

    // Staff-only ticket log: one entry per ticket, edited on close and carrying the transcript.
    // Same find-or-create as everything else; the overwrites are the ticket-channel template
    // minus the opener, with explicit OverwriteTypes for the same cached-id reason.
    const log = await ensureChannel(guild, {
        envId: TICKET_LOG_CHANNEL_ID,
        storeKey: 'ticketLog',
        looksLikeIt: name => name === 'ticketlog',
        name: 'ticket-log',
        topic: 'Every ticket, for staff. The transcript is attached when a ticket closes.',
        parent: category?.id || null,
        permissionOverwrites: [
            { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
            { id: OWNER_ID, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
            ...(me ? [{ id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] }] : []),
            ...staffOverwrites(guild, [P.ViewChannel, P.SendMessages, P.ReadMessageHistory]),
        ],
        reason: 'RazorReaper: staff ticket log',
    });
    if (log) ticketLogChannelId = log.id;
    if (category) ticketsCategoryId = category.id;
    if (channel) supportChannelId = channel.id;
    return { category, channel, log };
}

// ── The staff ticket log ──────────────────────────────────────────────────────
// One embed per ticket, posted when it opens and EDITED when it closes, so a ticket is one row
// in the log rather than two posts. The entry is found again by its title (`Ticket 0042`) with
// findOwnPanel — the same trick both panels use — so nothing has to survive a restart in memory.
function ticketLogChannel(guild) {
    if (!guild) return null;
    const byId = ticketLogChannelId && guild.channels.cache.get(ticketLogChannelId);
    return byId?.isTextBased?.() ? byId : null;
}

/**
 * The highest ticket number #ticket-log has ever seen. Auto-delete takes closed channels away, so
 * the channel list is no longer the full history of the numbers handed out; the log keeps one row
 * per ticket and the rows are posted in order, so the newest page carries the highest number.
 * Best-effort like the rest of the log: no log channel, no floor, and numbering is what it was.
 * ponytail: one page. It would take 100 tickets logged between two opens to read a stale floor,
 * and the cost of that is a repeated number, never a lost ticket.
 */
async function highestLoggedTicket(guild) {
    const channel = ticketLogChannel(guild);
    if (!channel) return 0;
    const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    let highest = 0;
    for (const m of msgs?.values() || []) {
        const n = Number(/^Ticket (\d+)$/.exec(m.embeds[0]?.title || '')?.[1]);
        if (Number.isFinite(n) && n > highest) highest = n;
    }
    return highest;
}

/**
 * Post this ticket's entry — or, when it is already there, edit it. The entry itself comes from
 * ticketLogEntry() in brand.js, which is where the wording and the block limits are tested.
 * Best-effort throughout: the log is a convenience for staff and must never be the reason a
 * ticket fails to open or close.
 * @param {object} entry  ticketLogEntry() input
 * @param {{colour?: number, files?: any[], edit?: boolean}} [opts]
 */
async function writeTicketLog(guild, entry, { colour = BRAND, files, edit = false } = {}) {
    const channel = ticketLogChannel(guild);
    if (!channel) return null;
    const { title, blocks } = ticketLogEntry(entry);
    try {
        const payload = {
            embeds: [rrEmbed({ title, blocks, colour, thumb: brandThumb(guild, client.user), timestamp: true })],
            ...(files ? { files } : {}),
        };
        // Three pages back: a ticket may have been open while 300 others were logged.
        const existing = edit ? await findOwnPanel(channel, title, 3).catch(() => null) : null;
        if (existing) return await existing.edit(payload);
        return await channel.send(payload);
    } catch (e) {
        console.error(`[ticket-log] Could not write "${title}":`, e.message || e);
        return null;
    }
}

const CATEGORY_FIELDS = [{
    name: 'Categories',
    value: ai.CATEGORIES.map(c => `${c.emoji} **${c.label}** — ${c.hint}`).join('\n'),
}];

function buildSupportPanel(guild) {
    const e = rrEmbed({
        title: SUPPORT_PANEL_TITLE,
        blocks: [
            'Pick the category that fits, then fill the short form.\nA good form is answered in seconds.',
            'Have ready: what goes wrong, what you already tried, and your version (**My account**).',
            '_One open ticket per category. Never post your full licence key._',
        ],
        fields: CATEGORY_FIELDS,
        thumb: brandThumb(guild, client.user),
    });

    const menu = new StringSelectMenuBuilder()
        .setCustomId('support:new')
        .setPlaceholder('Choose a category…')
        .addOptions(ai.CATEGORIES.map(c => ({ label: c.label, value: c.key, description: c.hint, emoji: c.emoji })));
    return { embeds: [e], components: [new ActionRowBuilder().addComponents(menu)] };
}

// Same mechanism as the #verify panel: find the bot's own panel message, post one if it is gone,
// otherwise refresh it so a restart always leaves a working select menu behind (the old
// per-command component collectors in this file die with the process — a panel must not).
async function syncSupportPanel(guild, channel) {
    if (!guild || !channel?.isTextBased()) return;
    try {
        const payload = buildSupportPanel(guild);
        const panel = await findOwnPanel(channel, SUPPORT_PANEL_TITLE);
        if (panel) await panel.edit(payload);
        else await channel.send(payload);
        console.log(`[support] Panel ${panel ? 'refreshed' : 'posted'} in #${channel.name}.`);
    } catch (e) {
        console.error('[support] Panel sync failed:', e.message || e);
    }
}

// ── The form ──────────────────────────────────────────────────────────────────
// Discord allows 5 inputs. Three are required — those three are what turns a useless ticket into
// an answerable one — and the minimum lengths are enforced by Discord itself, before anything
// reaches us or a model.
function buildTicketModal(categoryKey) {
    const label = ai.categoryLabel(categoryKey);
    const input = (id, text, style, required, opts = {}) => new ActionRowBuilder().addComponents(
        new TextInputBuilder()
            .setCustomId(id).setLabel(text).setStyle(style).setRequired(required)
            .setMaxLength(opts.max || 1000)
            .setPlaceholder(opts.placeholder || '')
            .setMinLength(opts.min || 0),
    );
    return new ModalBuilder()
        .setCustomId(`support:form:${categoryKey}`)
        .setTitle(`New ticket — ${label}`.slice(0, 45))
        .addComponents(
            input('problem', 'What is the problem?', TextInputStyle.Paragraph, true, {
                min: 40, max: 1000,
                placeholder: 'What happens, where in the app, and what did you expect instead?',
            }),
            input('tried', 'What have you already tried?', TextInputStyle.Paragraph, true, {
                min: 10, max: 600, placeholder: 'Restarted, reinstalled, recalibrated, changed a setting…',
            }),
            input('version', 'App version', TextInputStyle.Short, true, {
                min: 3, max: 20, placeholder: 'My account → your installation, e.g. 1.5.2',
            }),
            input('errcode', 'Error code / message (optional)', TextInputStyle.Short, false, {
                max: 200, placeholder: 'e.g. RR-E1003, or the exact text shown',
            }),
            input('extra', 'Anything else? (optional)', TextInputStyle.Paragraph, false, {
                max: 600, placeholder: 'Windows version, resolution, ARK platform, mods…',
            }),
        );
}

const FIELD_LABELS = {
    problem: 'Problem', tried: 'Already tried', version: 'App version',
    errcode: 'Error code / message', extra: 'Additional info',
};

/** Best-effort DM — plenty of members have DMs closed, and that must never fail a ticket. */
async function dmMember(user, embedPayload) {
    try { await user.send({ embeds: [embedPayload] }); } catch { /* DMs closed */ }
}

/**
 * The "Re-enable AI" button, on every message that says the AI has stopped — and, while it is
 * still live, the record that says so: see rebuildTicketState.
 */
const aiBackRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TICKET_BUTTONS.aiOn).setLabel('Re-enable AI').setStyle(ButtonStyle.Secondary),
);

/**
 * The "a human is needed here" ping, in the four places that need one. Individual member mentions
 * rather than `<@&role>`: a ROLE mention only notifies when the role is mentionable or the bot
 * holds Mention Everyone, and a ping that silently notifies nobody is worse than no feature at
 * all. `role.members` is a view on the member cache, so a cold cache is warmed through the SAME
 * fetchGuildMembers the licence sweeps use: its TTL keeps this off their toes, and because it
 * does not cache a failed fetch, one rate-limited attempt cannot strand this on "owner only" for
 * the life of the process. allowedMentions is explicit so nothing ELSE in the message can ping.
 *
 * Every ping in this file goes through here, and here ALONE is `humanPinged` written: it means
 * exactly "a real ping went out for this ticket", never "a human is around somewhere". Staff
 * typing in the ticket or switching the AI off does not write it — a staff member who then walks
 * away must not leave the member with no way left to call anyone.
 * @param {string|null} channelId  the ticket this ping is for, when it is for one
 * @returns {Promise<{content: string, allowedMentions: object}>} spread into the message payload
 */
async function humanPing(guild, channelId = null) {
    if (channelId) humanPinged.add(channelId);
    const role = HUMAN_PING_ROLE_ID ? guild?.roles?.cache?.get(HUMAN_PING_ROLE_ID) : null;
    if (role) {
        if (!role.members.size) {
            await fetchGuildMembers(guild).catch(e => console.error('[support] Could not read the member list:', e.message || e));
        }
        const ids = [...role.members.keys()].slice(0, HUMAN_PING_MAX);
        if (ids.length) return { content: ids.map(id => `<@${id}>`).join(' '), allowedMentions: { users: ids } };
    }
    return { content: `<@${OWNER_ID}>`, allowedMentions: { users: [OWNER_ID] } };
}

// ── Opening a ticket ──────────────────────────────────────────────────────────
/**
 * The member's limits, straight off the channel list — no counter to keep, no counter to lose,
 * and no await, which is what lets the select menu ask before it opens the form (a modal cannot
 * be deferred). One open ticket PER CATEGORY: a License question and a bug report are two
 * conversations, and making the member close one to ask the other is what the owner asked us to
 * stop doing.
 */
const ticketLimits = (guild, userId, categoryKey) => checkLimits(
    guild.channels.cache.map(c => ({
        name: c.name,
        topic: c.topic,
        createdTimestamp: c.createdTimestamp,
        // Not the name: the close rename is no longer awaited, so a ticket this process closed
        // a minute ago can still be called ticket-NNNN while Discord works through its queue.
        closed: closedTickets.has(c.id) || transcribedTickets.has(c.id),
    })),
    userId,
    Date.now(),
    { cat: categoryKey, maxPerDay: TICKET_MAX_PER_DAY },
);

/** The one refusal, whichever door asked: the select menu before the form, the submit after it. */
const ticketLimitEmbed = (categoryKey, limit) => rrEmbed({
    title: 'Ticket not opened',
    blocks: [limit.reason === 'open'
        ? `You already have an open **${ai.categoryLabel(categoryKey)}** ticket: **${limit.open}**.\nContinue there, or close it first.`
        : `You opened ${limit.count} tickets in the last 24 hours.\nContinue in one of those, or wait a little.`],
    colour: BRAND_BAD,
});

async function openTicket(interaction, categoryKey, fields) {
    const guild = interaction.guild;
    const user = interaction.user;

    // 1. Checked twice here as well as before the form: cheaply now, so a member over the limit
    // never costs a triage call, and again inside the creation chain below, where the cache can
    // actually see a ticket another submission from the same member is in the middle of creating.
    const checkTicketLimits = () => ticketLimits(guild, user.id, categoryKey);
    const limitEmbed = (limit) => ticketLimitEmbed(categoryKey, limit);
    let limit = checkTicketLimits();
    // "You already have an open ticket" is answered out of Maps a restart emptied, and the close
    // rename that would have renamed the channel may never have landed — so the ticket named here
    // can be one that is visibly closed. Ask that ONE channel's own history before refusing.
    if (!limit.ok && limit.reason === 'open') {
        const blocker = guild.channels.cache.find(c => c.name === limit.open);
        if (blocker) {
            await hydrateTicket(blocker);
            limit = checkTicketLimits();
        }
    }
    if (!limit.ok) return interaction.editReply({ embeds: [limitEmbed(limit)] });

    // 2. Triage BEFORE a channel exists. Billing never goes to a model: refunds and payments are
    // the owner's call, so those tickets are created straight away and he is pinged.
    if (!ai.HUMAN_ONLY.has(categoryKey)) {
        const verdict = await support.triage({ category: categoryKey, fields });
        if (verdict && verdict.verdict !== 'ok') {
            const reason = shortLine(verdict.reason, 300) || (verdict.verdict === 'wrong_category'
                ? 'This does not belong in the category you picked.'
                : 'This is not a RazorReaper support question.');
            const rejection = rrEmbed({
                title: '⚠️ False Topic',
                blocks: [
                    reason,
                    verdict.verdict === 'wrong_category'
                        && `It belongs in **${ai.categoryLabel(verdict.category)}** — open a new ticket there.`,
                ],
                colour: BRAND_BAD,
                thumb: brandThumb(guild, client.user),
            });
            await interaction.editReply({ embeds: [rejection] });
            await dmMember(user, rejection);
            console.log(`[support] Rejected a ${categoryKey} form from ${user.tag} (${verdict.verdict}).`);
            // Staff see the rejection too, and the panel counts it — the owner asked for all
            // tickets, and a form that never became a channel is still a support contact.
            archiveFalseTopic(guild, user, categoryKey, reason, fields, interaction.id).catch(e =>
                console.error('[support] False-topic archive failed:', e.message || e));
            return;
        }
        // verdict === null: no AI, budget spent or every provider down. Support must not go dark
        // because an API is having a day — the ticket goes through and a human sees it.
    }

    // 3. Create the channel: opener + staff + the bot, nobody else.
    // Numbering reads the channel list and then creates, so two members submitting at the same
    // moment would both claim the same number — the creations are chained instead, the same way
    // ensureLifetimeRole shares its in-flight create to avoid making the role twice.
    const P = PermissionsBitField.Flags;
    // Auto-delete frees the numbers of channels it removes; #ticket-log remembers them.
    const numberFloor = await highestLoggedTicket(guild);
    let channel;
    try {
        const link = ticketCreateChain.then(() => {
            // The limit check above ran before triage — seconds ago, against a cache that could not
            // yet show a ticket a second submission from this member was still creating. Here it can.
            const again = checkTicketLimits();
            if (!again.ok) throw Object.assign(new Error('ticket limit'), { ticketLimit: again });
            return guild.channels.create({
                name: ticketChannelName(nextTicketNumber(guild.channels.cache.map(c => c.name), numberFloor)),
                type: ChannelType.GuildText,
                parent: (ticketsCategoryId && guild.channels.cache.get(ticketsCategoryId)?.id) || null,
                // The ONLY topic write before the close: the facts that cannot change. Billing is
                // decided here too, because it is decided here — nothing flips it later, and this
                // way it survives a restart without a second channel edit.
                topic: buildTopic({ opener: user.id, cat: categoryKey, ai: !ai.HUMAN_ONLY.has(categoryKey), replies: 0 }),
                // The cooldown the owner asked for: Discord enforces it, staff bypass it natively,
                // and it is set once here so there is no second channel edit to spend.
                rateLimitPerUser: TICKET_SLOWMODE,
                // Explicit OverwriteTypes for the same reason ensureCommunityChannels needs them:
                // without them discord.js resolves ids through its caches and the create throws.
                permissionOverwrites: [
                    { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
                    { id: user.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
                    ...(guild.members.me ? [{ id: guild.members.me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels, P.EmbedLinks] }] : []),
                    ...staffOverwrites(guild, [P.ViewChannel, P.SendMessages, P.ReadMessageHistory]),
                ],
                reason: `RazorReaper support ticket for ${user.tag}`,
            });
        });
        // What the NEXT member in the queue waits for is this one's TURN, never its result: chaining
        // the raw promise hands a transient Discord error to everybody already queued behind it, who
        // then never even call create(). Same reason ensureLifetimeRole clears its shared promise on
        // failure instead of leaving a rejected one where a sibling awaiter can find it.
        ticketCreateChain = link.catch(() => {});
        channel = await link;
    } catch (e) {
        if (e?.ticketLimit) return interaction.editReply({ embeds: [limitEmbed(e.ticketLimit)] });
        console.error('[support] Could not create the ticket channel:', e.message || e);
        return interaction.editReply({
            embeds: [rrEmbed({ title: 'Ticket not opened', blocks: ['I could not create your ticket channel.\nPlease ping a staff member.'], colour: BRAND_BAD })],
        });
    }

    // The transcript-on-close path learns the opener from this map; setting it here means it
    // never has to guess from permission overwrites or an intro message.
    ticketOwners.set(channel.id, user.id);
    await interaction.editReply({
        embeds: [rrEmbed({ title: 'Ticket open', blocks: [`Your ticket is ${channel}.`], colour: BRAND_GOOD })],
    });

    // 4. The form as the first message, with the buttons the member needs.
    const opening = rrEmbed({
        title: `${ai.CATEGORIES.find(c => c.key === categoryKey)?.emoji || '🎟️'} ${ai.categoryLabel(categoryKey)}`,
        blocks: [
            `Ticket by ${user} • ${channel.name}`,
            TICKET_SLOWMODE ? `One message every ${TICKET_SLOWMODE}s — it is worth writing the whole problem at once.` : null,
        ],
        fields: Object.entries(fields)
            .filter(([, v]) => v && v.trim())
            .map(([label, v]) => ({ name: label, value: v.slice(0, 1024) })),
        thumb: brandThumb(guild, client.user),
        footer: 'Answered automatically • razorreaper.app',
        timestamp: true,
    });
    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket:close').setLabel('Solved — close').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ticket:human').setLabel('I need a human').setStyle(ButtonStyle.Secondary),
        ...(panelConfigured()
            ? [new ButtonBuilder().setCustomId('ticket:purchase').setLabel('My purchase').setStyle(ButtonStyle.Secondary)]
            : []),
    );
    // Staff get their own row in #ticket-log the moment the ticket exists — the close edits it.
    // BEFORE the opening post, and not awaited: it needs nothing from it, and a post that fails is
    // exactly when staff most need the row.
    writeTicketLog(guild, {
        ticketName: channel.name,
        opener: `${user}`,
        category: ai.categoryLabel(categoryKey),
        status: 'open',
        problem: fields[FIELD_LABELS.problem],
    }).catch(() => {});
    // Swallowed like every other post in this file: the member has already been told the ticket is
    // open, so a failed opening message must not take the ping or the first answer down with it.
    await channel.send({ content: `${user}`, embeds: [opening], components: [buttons] })
        .catch(e => console.error('[support] Opening message failed:', e.message || e));

    // 5. Answer — unless this category is the owner's alone, or there is no AI configured.
    if (ai.HUMAN_ONLY.has(categoryKey)) {
        await channel.send({
            ...(await humanPing(guild, channel.id)),
            embeds: [rrEmbed({
                title: '💳 A human answers this',
                blocks: ['Purchases, payments and refunds are answered personally.\nThe team has been notified.'],
            })],
        });
        return;
    }
    hydrated.add(channel.id);   // nothing to rebuild: this process watched the ticket open
    await runAiReply(channel, { category: categoryKey, fields, history: [], opener: user.id });
}

// ── Answering ─────────────────────────────────────────────────────────────────
/**
 * Is the AI answering in this ticket? Memory decides, and the topic only supplies the starting
 * value — `ai=off` for a billing ticket, and for every ticket opened before this stopped being a
 * channel edit. Flipping it costs nothing now, which is the whole point: the old topic write sat
 * in Discord's 2-edits-per-10-minutes queue and made the close that followed it look half-done.
 */
const ticketAi = (channelId, state) => aiOn.get(channelId) ?? (state?.ai !== false);
const setTicketAi = (channelId, on) => aiOn.set(channelId, on);

/**
 * What staff and the panel are told about a ticket: its TOTAL automatic answers, counted off the
 * transcript that is already in hand. aiReplyCount is the CAP counter — a "Re-enable AI" resets it
 * by design — and reporting that made an answered ticket close with "0 AI replies". Both counters
 * stay as the floor, for the record whose history could not be read at all. One rule, one place:
 * the close and the delete-without-a-close both report through here.
 */
const totalAiReplies = (channelId, snaps, state) =>
    Math.max(countAutoAnswers(snaps), aiReplyCount.get(channelId) || 0, state?.replies || 0);

/**
 * Rebuild this process's memory of a ticket from the ticket's own history — once per ticket, on
 * the first thing that happens in it after a restart (a deploy landed in the middle of the
 * owner's first real ticket, so this is not theoretical). Returns the messages it read, so the
 * caller that needs them anyway does not fetch them twice.
 * @returns {Promise<any[]|null>} oldest-first messages, or null when there was nothing to do
 */
async function hydrateTicket(channel) {
    if (hydrated.has(channel.id)) return null;
    hydrated.add(channel.id);   // one attempt: the defaults are all the safe direction
    let ordered;
    try {
        const recent = await channel.messages.fetch({ limit: TICKET_SCAN });
        ordered = [...recent.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    } catch (e) {
        console.error(`[support] ${channel.name}: could not read the ticket back (${e.message || e}).`);
        return null;
    }
    const live = rebuildTicketState(ordered.map(m => ({
        bot: m.author.id === client.user.id,
        text: Boolean(m.content) && !m.embeds.length,
        buttons: m.components.flatMap(row => row.components.map(c => ({ id: c.customId, disabled: c.disabled }))),
        ts: m.createdTimestamp,
    })));
    // Only a hand-off actually seen in the history moves this: "no evidence" is not "on", or a
    // billing ticket — created ai=off, with no Re-enable button anywhere — would start answering.
    // A FULL window is not evidence either: the hand-off may have scrolled out of the scan, and an
    // AI that resumes talking over the human who took the ticket is the worse way to be wrong.
    // Unless the scan SAW one: it returns the newest messages, so a hand-off inside it is the
    // newest in the channel and settles the question on its own, full window or not — otherwise a
    // ticket that was explicitly brought back goes quiet again after every deploy.
    const wholeTicket = ordered.length < TICKET_SCAN;
    if (!live.ai || !(wholeTicket || live.sawHandoff)) setTicketAi(channel.id, false);
    if (live.ai && !wholeTicket && !live.sawHandoff) {
        console.log(`[support] ${channel.name}: over ${TICKET_SCAN} messages and no hand-off inside the scan — leaving the AI off.`);
    }
    // A hand-off in the history is NOT read back as "somebody was pinged": it may have been staff
    // switching the AI off, and after a restart nobody can tell. The cost of being wrong the other
    // way is at most one extra ping-only message per ticket per process; the cost of this direction
    // is a member with no way left to call anyone. The two-buttons state is held by the disableai
    // branch instead — while the AI is off it never posts a second Re-enable button.
    aiReplyCount.set(channel.id, Math.max(aiReplyCount.get(channel.id) || 0, live.replies));
    if (live.reportAsked) reportAsked.add(channel.id);
    if (live.waitingSince) reportWaiting.start(channel.id, live.waitingSince);
    if (live.closedAt) closedTickets.set(channel.id, live.closedAt);
    return ordered;
}

/**
 * Grey out a control message's buttons once the member has answered it. Discord keeps the custom
 * ids on a disabled button, and that is exactly what rebuildTicketState reads: a live "Re-enable
 * AI" means the AI is still off, a greyed one means it was brought back. A message edit is not a
 * channel edit — it has its own, far roomier, rate limit.
 */
async function consumeButtons(message) {
    if (!message?.components?.length) return;
    const rows = message.components
        .map(row => new ActionRowBuilder().addComponents(
            row.components.filter(c => c.type === ComponentType.Button)
                .map(c => ButtonBuilder.from(c).setDisabled(true)),
        ))
        .filter(row => row.components.length);
    await message.edit({ components: rows })
        .catch(e => console.error('[support] Could not retire the ticket buttons:', e.message || e));
}

/**
 * Grey out the hand-off message that is still offering "Re-enable AI". The button door already
 * holds that message; /enableai and "@bot enableai" have to go and find it, because a live
 * Re-enable button is exactly what rebuildTicketState() reads back as "the AI is still off".
 */
async function retireHandoffButtons(channel, message = null) {
    if (message) return consumeButtons(message);
    const recent = await channel.messages.fetch({ limit: TICKET_SCAN }).catch(() => null);
    const live = [...(recent?.values() || [])]
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .find(m => m.components.some(row => row.components.some(c => c.customId === TICKET_BUTTONS.aiOn && !c.disabled)));
    if (live) await consumeButtons(live);
}

/**
 * One AI answer into the ticket. Every stop condition the owner asked for lands here, so there is
 * one place to read when the bot goes quiet: budget spent, reply cap, provider outage.
 */
async function runAiReply(channel, { category, fields, history, data = '', opener = null }) {
    if (aiInFlight.has(channel.id)) return;
    aiInFlight.add(channel.id);
    try {
        if (!support.enabled) throw new Error('no AI provider configured');
        await channel.sendTyping().catch(() => {});
        const out = await support.answer({ category, fields, history, data, ticket: channel.name });
        // null means every provider has been disabled (bad credentials) — the member must not be
        // left staring at silence, so it takes the same hand-off path as an outright failure.
        if (!out) throw new Error('every provider is disabled');
        if (out.provider) ticketProvider.set(channel.id, out.provider);
        if (out.text) {
            // Discord takes 2000 characters, so a long answer is cut here whatever the provider
            // says about it. The marker tests the SLICE, not the provider: a model that simply
            // wrote too much left the member mid-sentence just as surely as a token limit did.
            const text = out.text.slice(0, 1900);
            await channel.send({
                content: text + (out.truncated || text.length < out.text.length ? '\n\n_(cut short — ask me to continue)_' : ''),
                // Model output is member-influenced text. Without this, a member who talks the model into
                // echoing a `<@&…>` it saw really does ping that staff role.
                allowedMentions: { parse: [] },
                // The knowledge base is full of bare links the model is told to quote, and Discord
                // unfurls one into an embed a moment after posting — which would make this answer look
                // like a bot notice to the history filter below and to rebuildTicketState.
                flags: MessageFlags.SuppressEmbeds,
            });
            aiReplyCount.set(channel.id, (aiReplyCount.get(channel.id) || 0) + 1);
        }
        let posted = Boolean(out.text);
        // The model pressed "My purchase": the bot posts the shop's own record, the same embed
        // the button posts. The model never sees it — it only knows the ticket has one.
        if (out.showPurchase && opener) {
            const purchase = await purchaseEmbed(channel.guild, opener);
            if (purchase) { await channel.send({ embeds: [purchase] }); posted = true; }
        }
        // The model says it needs this member's own setup. Ask once, then wait — and never on the
        // last answer this ticket has: a report the bot has no reply left to read would be asked
        // for, sent, and then answered past the cap.
        if (out.needsReport && panelConfigured() && !reportAsked.has(channel.id)
            && (aiReplyCount.get(channel.id) || 0) < AI_MAX_REPLIES) {
            await askForSupportReport(channel);
            posted = true;
        }
        // An answer that was nothing but sentinels, and neither of them had anything left to post:
        // the member's message cost budget and got silence. One line instead — an embed, so it is
        // a notice and not one of the ticket's automatic answers.
        if (!posted) {
            await channel.send({
                embeds: [rrEmbed({ title: 'Still with you', blocks: ['Tell me a bit more about the problem, or press **I need a human**.'] })],
            }).catch(e => console.error('[support] Could not post the empty-answer line:', e.message || e));
        }
    } catch (e) {
        console.error(`[support] ${channel.name}: no AI answer (${e.message || e}).`);
        setTicketAi(channel.id, false);
        reportWaiting.stop(channel.id);
        const text = e instanceof ai.BudgetExhausted
            ? 'Today\'s automatic-answer budget is spent.\nA human will take a look at this.'
            : support.enabled
                ? 'I can\'t answer this automatically right now.\nA human will take a look.'
                : 'A human will take a look at this shortly.';
        await channel.send({
            ...(await humanPing(channel.guild, channel.id)),
            embeds: [rrEmbed({ title: 'Handed to a human', blocks: [text] })],
            components: [aiBackRow()],
        }).catch(() => {});
    } finally {
        aiInFlight.delete(channel.id);
    }
}

// ── The support-report step ───────────────────────────────────────────────────
// The AI ends an answer with the NEED_REPORT sentinel when the problem depends on the member's
// own machine. The bot then points at the app, waits, pulls the data from the panel and asks the
// model again — the only path in this file where a ticket gets facts the member did not type.
async function askForSupportReport(channel) {
    reportAsked.add(channel.id);
    reportWaiting.start(channel.id);
    await channel.send({
        embeds: [rrEmbed({
            title: '📋 Send your report',
            blocks: [
                'In RazorReaper: **Feedback & Support → Support → Send Report**.',
                'The app shows a **Report ID** afterwards — press the button when it is sent.',
            ],
            thumb: brandThumb(channel.guild, client.user),
        })],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(TICKET_BUTTONS.reportSent).setLabel("I've sent it").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('ticket:report-skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
        )],
    }).catch(e => console.error('[support] Could not ask for the report:', e.message || e));
}

/**
 * The member's own purchase record as an embed — what the "My purchase" button posts, and what
 * the AI's ${SHOW_PURCHASE} sentinel posts, because the answer to "what do you have on me" is the
 * record itself and not the AI claiming it has no access to one. The data comes from the panel
 * (the SellHub webhook wrote it onto the licence row) and goes to the member, never to a model.
 * @returns {Promise<object|null>} an embed payload, or null when there is no panel to ask
 */
async function purchaseEmbed(guild, discordId) {
    if (!panelConfigured()) return null;
    const failed = () => rrEmbed({ title: 'Lookup failed', blocks: ['I could not reach the shop records — try again in a minute.'], colour: BRAND_BAD });
    let data;
    try {
        ({ data } = await verifyApi('/api/discord/purchase', { discord_id: discordId }));
    } catch (e) {
        console.error('[support] purchase call failed:', e.message || e);
        return failed();
    }
    if (!data?.ok) return failed();
    if (!data.linked) {
        return rrEmbed({ title: 'Not linked yet', blocks: ['Run `/verify` with your licence key first, then press the button again.'], colour: BRAND_BAD });
    }
    return rrEmbed({
        title: '💳 Your purchase',
        blocks: panelApi.purchaseBlocks(data.purchases),
        thumb: brandThumb(guild, client.user),
    });
}

/**
 * The member's client data as the block the model reads, or null when the panel has nothing for
 * that anchor (yet) — the caller then asks for the Report ID instead of leaving them guessing.
 * Split from the answering below so the button can tell the member what happened BEFORE the
 * answer lands, rather than after it.
 * @param {object} body  `{ discord_id, since? }` or `{ report_id }` — the contract's two anchors
 */
async function fetchClientContext(body) {
    let data;
    try {
        ({ data } = await verifyApi('/api/discord/support-context', body));
    } catch (e) {
        console.error('[support] support-context call failed:', e.message || e);
        return null;
    }
    if (!data?.ok || !data.found || !data.context) return null;
    return ai.formatClientContext(data.context) || null;
}

/**
 * Everything the model needs about a ticket, off ONE history read: the form and the last turns.
 * The form is read back out of the opening embed rather than stored anywhere — the last 12 turns
 * alone would eventually drop the original problem statement, and the embed's field names are
 * already the labels the model expects. Both callers (a follow-up, and the second pass after a
 * support report) need exactly this, so it is written once.
 * @param {any[]} [known]  messages already fetched by hydrateTicket, so a ticket is not read twice
 * @returns {Promise<{fields: Record<string,string>, history: {role: string, content: string}[]}>}
 */
async function readTicketContext(channel, state, known = null) {
    let ordered = known;
    if (!ordered) {
        const recent = await channel.messages.fetch({ limit: TICKET_SCAN });
        ordered = [...recent.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    }
    const opening = ordered.find(msg => msg.author.id === client.user.id && msg.embeds[0]?.fields?.length);
    return {
        fields: Object.fromEntries((opening?.embeds[0].fields || []).map(f => [f.name, f.value])),
        history: ordered
            .filter(msg => (msg.author.id === client.user.id && msg.content && !msg.embeds.length) || msg.author.id === state.opener)
            .map(msg => ({ role: msg.author.id === client.user.id ? 'assistant' : 'user', content: msg.content }))
            .filter(h => h.content)
            .slice(-TICKET_HISTORY),
    };
}

/** Answer again, this time with the client data as the freshest turn. */
async function answerWithClientContext(channel, state, block) {
    reportWaiting.stop(channel.id);
    // The client data is the point of this pass, so an unreadable history does not cancel it.
    const { fields, history } = await readTicketContext(channel, state)
        .catch(() => ({ fields: {}, history: [] }));
    await runAiReply(channel, { category: state.cat, fields, history, data: block, opener: state.opener });
}

// Follow-ups from the opener. A separate listener from the transcript capture above: that one
// only snapshots messages, this one decides whether to answer, and mixing the two would put the
// AI's stop conditions inside the transcript path.
client.on('messageCreate', async (m) => {
    try {
        if (!m.guild || m.author.bot) return;
        if (VERIFY_GUILD_ID && m.guild.id !== VERIFY_GUILD_ID) return;
        if (!ANY_TICKET_NAME_RE.test(m.channel?.name || '')) return;

        // ── "@bot close" ──────────────────────────────────────────────────────
        // The third door, and it comes FIRST: a command must never be fed to a model, counted as
        // a member message, or read as "a human took over". It works in a closed ticket too —
        // deleting one is the thing you do there.
        // The bot's managed role counts as the bot: that is what staff's autocomplete offers them.
        const cmd = parseBotCommand(m.content, client.user?.id, m.guild.members.me?.roles.botRole?.id);
        if (cmd) {
            if (!cmd.action) {
                await m.reply({
                    embeds: [rrEmbed({ title: 'Ticket commands', blocks: [TICKET_COMMANDS.map(c => `\`${c}\``).join(' · ')], footer: null })],
                }).catch(() => {});
                return;
            }
            let said = false;
            const ran = await runTicketAction(cmd.action, m.channel, m.member, async ({ embeds, files }) => {
                said = true;
                // His message is public, so the file must not be: it goes to his DMs, and the
                // channel only gets the one line saying so.
                if (!files?.length) return m.reply({ embeds, allowedMentions: { parse: [] } });
                const sent = await m.author.send({ embeds, files }).catch(() => null);
                return m.reply({
                    embeds: [rrEmbed({
                        title: sent ? '📑 Sent to your DMs' : 'DMs closed',
                        blocks: [sent ? 'The transcript is in your DMs.' : 'I could not DM you — open your DMs and ask again.'],
                        colour: sent ? BRAND_GOOD : BRAND_BAD,
                        footer: null,
                    })],
                });
            }, { reason: cmd.reason });
            // A tick is the whole confirmation when the action already spoke for itself.
            if (ran && !said) await m.react('✅').catch(() => {});
            return;
        }

        // Only OPEN tickets: a closed-NNNN channel keeps its topic, and a member still typing in
        // one must not get more answers out of it.
        if (!isTicketChannel(m.channel)) return;
        const state = parseTopic(m.channel.topic);
        if (!state) return;
        // First thing in this ticket since the process started: read back what a restart lost.
        // It hands over the messages it read, so nothing below fetches them a second time.
        const known = await hydrateTicket(m.channel);
        // Closed, whatever the channel is still called: the rename is not awaited any more, so a
        // ticket can be closed for a minute before Discord gets round to renaming it.
        if (closedTickets.has(m.channelId)) return;

        // A staff member writing in the ticket means a human took over — the AI steps aside.
        if (m.author.id !== state.opener) {
            if (ticketAi(m.channelId, state) && m.member && isStaff(m.member)) {
                setTicketAi(m.channelId, false);
                reportWaiting.stop(m.channelId);
                // Nobody was pinged here — a human is typing, which is not the same fact and is not
                // written down as one: this staff member may say one word and leave, and "I need a
                // human" has to still reach the team. It stays a hand-off message with the one live
                // Re-enable button; the disableai branch is what keeps it the only one.
                await m.channel.send({
                    embeds: [rrEmbed({ title: 'A human took over', blocks: ['I\'ll stay out of the way.'] })],
                    components: [aiBackRow()],
                });
            }
            return;
        }
        if (!ticketAi(m.channelId, state)) return;
        // An answer is still being written. One call per ticket stays the rule — the message is in
        // the history the next turn reads anyway — but it gets the same receipt the @bot door uses,
        // so the member knows this one is not getting its own answer.
        if (aiInFlight.has(m.channelId)) return void m.react('⏳').catch(() => {});

        // Without the privileged MessageContent intent, m.content is empty for everyone but the
        // bot itself — there would be nothing to answer. Say so once instead of failing silently.
        if (!m.content) {
            // A screenshot with no caption looks exactly the same from here, and is a normal thing
            // to do in a ticket — the model reads text only, so ask for words instead of going mute.
            if (m.attachments?.size) {
                await m.reply({
                    embeds: [rrEmbed({ title: 'I can\'t read images', blocks: ['Write what it says in a line and I\'ll answer.'] })],
                }).catch(() => {});
                return;
            }
            if (!warnedNoMessageContent) {
                warnedNoMessageContent = true;
                console.error('[support] Follow-ups are unreadable: enable Message Content Intent in the Developer Portal and set NOTIFIER_MESSAGE_CONTENT=true.');
            }
            return;
        }

        // The cap first, whatever this message says. The counter is this process's — seeded from
        // the ticket's own history on the first pass through hydrateTicket, and reset to zero by a
        // "Re-enable AI" — and every road from here to an answer goes past it, a pasted Report ID
        // included: an answer the ticket no longer has is one it no longer has.
        if ((aiReplyCount.get(m.channelId) || 0) >= AI_MAX_REPLIES) {
            setTicketAi(m.channelId, false);
            await m.channel.send({
                ...(await humanPing(m.guild, m.channelId)),
                embeds: [rrEmbed({ title: 'Handed to a human', blocks: ['We\'ve gone back and forth a few times.\nA human will take it from here.'] })],
                components: [aiBackRow()],
            });
            return;
        }

        // Waiting for the support report: the AI answers nothing else in this ticket — but a
        // Report ID pasted into the channel is precisely what it is waiting for, and it counts
        // whenever the bot ASKED for one, not only inside the 30-minute window:
        // sending a report from inside the app takes as long as it takes, and the bot asking for
        // an ID and then reading it as ordinary chat is the one thing it must not do.
        const reportId = (reportWaiting.active(m.channelId) || reportAsked.has(m.channelId))
            ? panelApi.findReportId(m.content)
            : null;
        if (reportId) {
            const block = await fetchClientContext({ report_id: reportId, discord_id: state.opener });
            if (!block) {
                await m.channel.send({
                    embeds: [rrEmbed({
                        title: 'Report not found',
                        blocks: [`Nothing under **${reportId}** yet — give it a minute and send the ID again.`],
                        colour: BRAND_BAD,
                    })],
                }).catch(() => {});
                return;
            }
            return answerWithClientContext(m.channel, state, block);
        }
        // The window keeps its one real job: while it runs, the AI answers nothing else here.
        if (reportWaiting.active(m.channelId)) return;

        const { fields, history } = await readTicketContext(m.channel, state, known);
        await runAiReply(m.channel, { category: state.cat, fields, history, opener: state.opener });
    } catch (e) {
        console.error('[support] Follow-up handler failed:', e.message || e);
    }
});

// ── Closing ───────────────────────────────────────────────────────────────────
// ONE close path, and it builds the transcript itself. The rename used to be the close — the
// transcript was a side-effect of channelUpdate seeing ticket-NNNN → closed-NNNN — which meant a
// rename that got rate-limited silently cost the member their transcript. Now the html is
// rendered here, once, and the same string goes to all three consumers: the opener's DM,
// #ticket-log and the panel archive — and none of them waits for the rename any more. The
// channelUpdate path stays for channels somebody renames by hand, guarded so a ticket is never
// processed twice.

/**
 * The staff-only delete button. It rides on the ONE "Ticket closed" message and nowhere else, so
 * the message carrying it is the close record — the rename may still be queued behind Discord's
 * two-edits-per-10-minutes, and that is not the member's problem.
 */
const closedRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TICKET_BUTTONS.del).setLabel('Delete ticket').setStyle(ButtonStyle.Danger),
);

/**
 * Upload a finished ticket to the panel. Never throws, and nothing the member sees waits for it:
 * one retry on a transport failure, one shorter retry on a 413 (handled inside
 * panelApi.uploadTicket), then it gives up with a log line — a ticket that closes is worth more
 * than a ticket that is archived. The close does await it at the very end, after everything the
 * member sees is posted, so that /delete cannot destroy the channel mid-upload.
 */
async function archiveTicket(opts, { guildName, snaps } = {}) {
    if (!panelConfigured()) return null;
    const payload = panelApi.ticketUploadPayload(opts);
    // The html is the only field that can be too big; half the messages is half the html.
    const shrink = () => (snaps && snaps.length > 4)
        ? renderTranscriptHtml(guildName, payload.channel_name, snaps.slice(Math.ceil(snaps.length / 2)))
        : null;
    const send = () => panelApi.uploadTicket(verifyApi, payload, shrink);
    let res = null;
    try {
        res = await send();
    } catch (e) {
        console.error(`[support] Panel archive for ${payload.channel_name} failed (${e.message || e}) — one retry.`);
        await new Promise(r => setTimeout(r, 2000));
        try { res = await send(); } catch (e2) {
            console.error(`[support] Panel archive for ${payload.channel_name} gave up:`, e2.message || e2);
            return null;
        }
    }
    if (res?.data?.ok) {
        console.log(`[support] Archived ${payload.channel_name} (${payload.status}) in the panel.`);
        return res.data;
    }
    console.error(`[support] Panel refused the ${payload.channel_name} archive — HTTP ${res?.status}${res?.data?.error ? `: ${res.data.error}` : ''}.`);
    return null;
}

const closingTickets = new Map();   // channelId -> the close still running, for whoever has to wait
/**
 * The close, shared. `transcribedTickets` already stops a second close doing the work twice, but
 * the loser got its promise back in one microtask and /delete then destroyed the channel while the
 * real close was still fetching the history — an empty transcript and an empty archive. Everyone
 * who asks for a close now awaits the SAME one, and /delete can await one it did not start.
 * @param {import('discord.js').TextChannel} channel
 * @param {{tag: string, id: string, reason?: string}|null} closedBy
 */
function closeTicketChannel(channel, closedBy = null) {
    const running = closingTickets.get(channel.id);
    if (running) return running;
    const p = runClose(channel, closedBy).finally(() => closingTickets.delete(channel.id));
    closingTickets.set(channel.id, p);
    return p;
}

/**
 * The close rename, fired and never awaited — the close below explains why. Its own function
 * because the sweep fires it a second time for a close whose edit never landed.
 */
function fireCloseRename(channel, state, replies, closedAt) {
    const ticketName = channel.name;
    channel.edit({
        name: `closed-${ticketName.replace(/[^0-9]/g, '') || '0000'}`,
        ...(state ? { topic: buildTopic({ ...state, ai: false, replies, closed: Math.floor(closedAt / 1000) }) } : {}),
        reason: 'RazorReaper: ticket closed',
    })
        .then(() => channel.permissionOverwrites.edit(channel.guild.id, { ViewChannel: false }).catch(() => {}))
        .then(() => console.log(`[support] ${ticketName} renamed and hidden.`))
        .catch(e => console.error(`[support] ${ticketName}: close rename failed (${e.message || e}) — the ticket is closed regardless.`));
}

/**
 * The whole close, in the order the member experiences it. Nothing here waits for the RENAME:
 * a channel takes two edits per 10 minutes, the ticket had already spent them, and awaiting the
 * rename put the transcript, the staff log, the panel archive and the Delete button behind a
 * queue that took minutes to drain — which is what made a closed ticket refuse to be deleted.
 * The rename is now the last thing, fired and logged, and every record of the close is written
 * before it: the in-memory close time, and the one "Ticket closed" message carrying Delete.
 * Reached through closeTicketChannel() above, never directly: that is what makes it shared.
 */
async function runClose(channel, closedBy = null) {
    const ticketName = channel.name;
    const num = ticketName.replace(/[^0-9]/g, '');
    const state = parseTopic(channel.topic);
    const guild = channel.guild;

    // Stand the legacy rename handler down BEFORE the rename fires — and stand a second close
    // down as well. Two clicks, or a click and /close, both land while the rename is still in
    // flight and both still see an open ticket: without this the transcript is built twice and
    // the opener is DM'd twice.
    if (transcribedTickets.has(channel.id)) return;
    transcribedTickets.add(channel.id);
    const closedAt = Date.now();
    // Synchronously, before the first await: this is what the AI, the buttons and the sweep read
    // as "closed" from here on, and it is true the moment the close starts.
    closedTickets.set(channel.id, closedAt);
    reportWaiting.stop(channel.id);

    const ownerId = await resolveTicketOwner(channel).catch(() => null);
    let snaps = [];
    try { snaps = await fetchTicketSnapshots(channel); }
    catch (e) { console.error(`[support] ${ticketName}: history unreadable (${e.message || e}).`); }
    if (!snaps.length) snaps = ticketMessageCache.get(channel.id) || [];
    const html = snaps.length ? renderTranscriptHtml(guild.name, ticketName, snaps) : '';

    const replies = totalAiReplies(channel.id, snaps, state);
    const provider = ticketProvider.get(channel.id) || null;
    // Cache only: the opener wrote in this channel minutes ago, and a tag is not worth a fetch.
    const openerTag = (ownerId && client.users.cache.get(ownerId)?.tag) || null;

    if (html) {
        await dmTicketTranscript(guild, ticketName, ownerId, snaps, html);
        await writeTicketLog(guild, {
            ticketName,
            opener: `<@${ownerId || state?.opener || '0'}>`,
            category: ai.categoryLabel(state?.cat || 'other'),
            status: 'closed',
            closedBy: closedBy?.tag,
            openMs: closedAt - channel.createdTimestamp,
            messages: snaps.length,
            aiReplies: replies,
            provider,
        }, {
            edit: true,
            colour: BRAND_BAD,
            files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `${ticketName}-transcript.html` })],
        });
    }

    // Started here so it runs alongside the close message and the rename, but AWAITED before this
    // function resolves: /delete closes and then deletes the channel, and "never delete without
    // the archive having run" is only true if the caller's await really covers it. archiveTicket
    // logs its own failures; this catch is for the unexpected throw it does not, which used to
    // disappear into an empty handler.
    const archived = archiveTicket({
        channelId: channel.id,
        ticketNo: Number(num) || 0,
        channelName: ticketName,
        discordId: ownerId || state?.opener || null,
        discordTag: openerTag,
        category: state?.cat || 'other',
        status: 'closed',
        openedAt: channel.createdTimestamp,
        closedAt,
        closedBy: closedBy?.tag || null,
        aiReplies: replies,
        messageCount: snaps.length,
        provider,
        transcriptHtml: html,
    }, { guildName: guild.name, snaps })
        .catch(e => console.error(`[support] Panel archive for ${ticketName} threw:`, e.message || e));

    // The one close message, and the only place the Delete button ever appears.
    await channel.send({
        embeds: [rrEmbed({
            title: '🔒 Ticket closed',
            blocks: [
                `Closed by ${closedBy ? `<@${closedBy.id}>` : 'staff'}.`,
                closedBy?.reason && `Reason: ${shortLine(closedBy.reason, 200)}`,
                'The transcript is on its way to your DMs.',
            ],
            colour: BRAND_BAD,
            timestamp: true,
        })],
        // Always there, whoever closed: the handler refuses non-staff, and after a restart this
        // button is the record rebuildTicketState() reads the close from.
        components: [closedRow()],
    }).catch(e => console.error('[support] Could not post the close message:', e.message || e));

    // Last, and deliberately NOT awaited: rename + hide share the channel's two edits per 10
    // minutes with anything the ticket already spent, so this can sit in the queue for minutes.
    // Everything that matters is already done; this is cosmetics and the sweep's stamp — and the
    // sweep fires it again for the ticket whose edit died with the process.
    fireCloseRename(channel, state, replies, closedAt);

    aiOn.delete(channel.id);
    aiReplyCount.delete(channel.id);
    ticketProvider.delete(channel.id);
    reportAsked.delete(channel.id);
    humanPinged.delete(channel.id);
    ticketMessageCache.delete(channel.id);

    // Last: the member's close is over either way, and whoever awaited us (the delete door) has
    // now waited for the archive as well. Bounded by verifyApi's timeout.
    await archived;
}

// ── Auto-delete ───────────────────────────────────────────────────────────────
// Closed tickets disappear by themselves. The `closed=` stamp written in the close edit is what
// makes this survive a restart — there is no database here, and a Map would forget every deadline
// the moment the container is rebuilt. deletableTickets() holds the three guards (a closed-NNNN
// name, one of OUR topics, a stamp) and is unit-tested; this end only does the deleting.
async function sweepClosedTickets() {
    if (!(TICKET_AUTO_DELETE_HOURS > 0)) return;
    const guild = verifyGuild();
    if (!guild) return;
    // First, the closes whose rename never landed — a failed edit, or a restart while it was still
    // in the queue. Such a ticket is still called ticket-NNNN, so this sweep can never see it and
    // its opener is still told they have one open. hydrateTicket reads the close off the "Ticket
    // closed" message (once per ticket per process) and the rename is simply fired again.
    for (const ch of guild.channels.cache.filter(c => TICKET_NAME_RE.test(c.name || '')).values()) {
        await hydrateTicket(ch).catch(() => null);
        if (!closedTickets.has(ch.id)) continue;   // provably closed, or left alone
        const state = parseTopic(ch.topic);
        fireCloseRename(ch, state, Math.max(aiReplyCount.get(ch.id) || 0, state?.replies || 0), closedTickets.get(ch.id));
    }
    const due = deletableTickets(
        guild.channels.cache.map(c => ({ id: c.id, name: c.name, topic: c.topic })),
        // The stamp is written by the close edit, which is no longer awaited — until it lands,
        // this process's own bookkeeping is what knows when the ticket closed.
        { hours: TICKET_AUTO_DELETE_HOURS, closedAt: (id) => closedTickets.get(id) },
    );
    for (const { id, name } of due) {
        const channel = guild.channels.cache.get(id);
        if (!channel) continue;
        try {
            await channel.delete(`RazorReaper: auto-delete ${TICKET_AUTO_DELETE_HOURS}h after close`);
            console.log(`[support] Auto-deleted ${name}.`);
        } catch (e) {
            console.error(`[support] Auto-delete of ${name} failed:`, e.message || e);
        }
    }
}

/**
 * A form that never became a channel is still a support contact: staff see it in #ticket-log and
 * the panel counts it. Reuses the ordinary transcript renderer over one synthetic message, so
 * there is no second HTML template to keep in step.
 * @param {string} anchorId  the id of the form submission this rejects. The panel keys the archive
 *        on `channel_id` and takes Discord snowflakes only (17-20 digits), so a made-up id would
 *        be refused with a 400 and the rejection would never be counted — which is the one thing
 *        the owner asked for here. An interaction id is a real snowflake, it is unique per
 *        rejection, and a retry repeats it, so the upsert still lands on one row.
 */
async function archiveFalseTopic(guild, user, categoryKey, reason, fields, anchorId) {
    const now = Date.now();
    const form = Object.entries(fields).filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}: ${v}`).join('\n');
    const snaps = [{
        author: user.username,
        avatar: user.displayAvatarURL({ extension: 'png', size: 64 }),
        bot: false,
        ts: now,
        content: form,
        embeds: [{ title: 'False Topic', desc: reason }],
        attachments: [],
    }];

    await writeTicketLog(guild, {
        status: 'false_topic',
        opener: `${user}`,
        category: ai.categoryLabel(categoryKey),
        problem: reason,
    }, { colour: BRAND_BAD });

    await archiveTicket({
        channelId: anchorId,
        ticketNo: 0,
        channelName: 'false-topic',
        discordId: user.id,
        discordTag: user.tag,
        category: categoryKey,
        status: 'false_topic',
        openedAt: now,
        closedAt: now,
        closedBy: 'triage',
        aiReplies: 0,
        messageCount: 1,
        provider: null,
        transcriptHtml: renderTranscriptHtml(guild.name, 'false-topic', snaps),
    }, { guildName: guild.name, snaps });
}

// ── The five ticket actions, once ─────────────────────────────────────────────
/**
 * Close, transcript, delete, enableai, disableai — written once and reached through three doors:
 * the ticket's buttons, a slash command, and "@bot close" typed into the channel. The door only
 * supplies `respond`: it gets ONE payload and decides where it lands (ephemeral for a slash
 * command, a DM for a file when the door is a public message), which is the only thing the three
 * really differ in.
 * @param {string} action  one of TICKET_COMMANDS
 * @param {import('discord.js').TextChannel} channel
 * @param {import('discord.js').GuildMember} member  whoever asked
 * @param {(payload: object) => Promise<any>} respond
 * @param {{reason?: string, message?: import('discord.js').Message}} opts
 *        `message` is the door's own control message, when it has one (the button door): a
 *        Re-enable that has been used must be greyed out, and that is the message carrying it.
 * @returns {Promise<boolean>} false when it refused, and the refusal has already been sent
 */
async function runTicketAction(action, channel, member, respond, { reason = '', message = null } = {}) {
    const refuse = (text) => respond({
        embeds: [rrEmbed({ title: 'Not allowed', blocks: [text], colour: BRAND_BAD, footer: null })],
        ephemeral: true,
    }).then(() => false);
    if (!ANY_TICKET_NAME_RE.test(channel?.name || '')) return refuse('Use this inside a ticket channel.');
    const state = parseTopic(channel.topic);
    const staff = Boolean(member && isStaff(member));
    // A Ticket Tool leftover has no topic of ours: the permission overwrite is then the only
    // record of who it belongs to, which is what /close has always fallen back on.
    const opener = state ? member?.id === state.opener : Boolean(channel.permissionOverwrites?.cache?.has(member?.id));
    if (!opener && !staff) return refuse('Only the person who opened this ticket can do that.');
    // The buttons stay on screen after a restart, and so does this channel: read back what the
    // restart lost before anything decides the ticket is still open, or still has the AI on.
    await hydrateTicket(channel);
    const closed = closedTickets.has(channel.id) || transcribedTickets.has(channel.id) || /^closed-/i.test(channel.name);

    if (action === 'transcript') {
        let snaps = await fetchTicketSnapshots(channel).catch(() => []);
        if (!snaps.length) snaps = ticketMessageCache.get(channel.id) || [];
        if (!snaps.length) return refuse('There is nothing in this ticket to write down yet.');
        await respond({
            embeds: [rrEmbed({ title: '📑 Ticket transcript', blocks: [`**${channel.name}** — the whole conversation is attached.`] })],
            files: [new AttachmentBuilder(
                Buffer.from(renderTranscriptHtml(channel.guild.name, channel.name, snaps), 'utf8'),
                { name: `${channel.name}-transcript.html` },
            )],
        });
        return true;
    }

    if (action === 'delete') {
        if (!staff) return refuse('Only staff can delete a ticket channel.');
        // An OPEN ticket is closed first, and awaited: the transcript, the opener's DM, #ticket-log
        // and the panel archive all happen in there, and none of them can be done afterwards.
        // A ticket that is ALREADY closed may still be closing — the Close button gives no visible
        // receipt while it works, which is exactly what makes staff reach for /delete — so this
        // waits for that close too. `await undefined` when none is running.
        await (closed ? closingTickets.get(channel.id) : closeTicketChannel(channel, { tag: member.user.tag, id: member.id, reason }));
        await respond({ embeds: [rrEmbed({ title: 'Deleting this channel', blocks: ['The transcript is already saved.'], colour: BRAND_BAD })] });
        await channel.delete(`RazorReaper: ticket deleted by ${member.user.tag}`)
            .catch(e => console.error('[support] Ticket delete failed:', e.message || e));
        return true;
    }

    if (closed) return refuse('This ticket is already closed.');

    if (action === 'close') {
        // closeTicketChannel posts the one public close message itself, once the transcript is
        // safe — this reply is only the door's receipt.
        await closeTicketChannel(channel, { tag: member.user.tag, id: member.id, reason });
        return respond({ embeds: [okEmbed('✅ Ticket closed.')], ephemeral: true }).then(() => true);
    }

    if (action === 'enableai') {
        if (!state || ai.HUMAN_ONLY.has(state.cat)) return refuse('This category is answered by a person, never automatically.');
        if (ticketAi(channel.id, state)) return refuse('The AI is already answering in this ticket.');
        // The cap is the member's, not the ticket's: STAFF lifting it is what the Re-enable button
        // on the cap hand-off is for, and the line below already starts the round over
        // (ticket-state.js: "a re-enable resets the cap"). The opener may not lift their own.
        if (!staff && (aiReplyCount.get(channel.id) || 0) >= AI_MAX_REPLIES) {
            return refuse(`This ticket used its ${AI_MAX_REPLIES} automatic answers.\nStaff can switch the AI back on.`);
        }
        if (support.budget.exhausted()) return refuse('Today\'s automatic-answer budget is spent — a human takes it from here.');
        if (!support.enabled) return refuse('No automatic answering is configured on this server.');
        aiReplyCount.set(channel.id, 0);
        setTicketAi(channel.id, true);
        await retireHandoffButtons(channel, message);
        return respond({ embeds: [rrEmbed({ title: 'AI is back on', blocks: ['Ask your next question and I\'ll answer.'], colour: BRAND_GOOD })] }).then(() => true);
    }

    if (action === 'disableai') {
        // The one hand-off producer: /disableai, "@bot disableai" and the "I need a human" button
        // are the same thing said three ways — the AI steps aside and a person is called. Two
        // things have to hold at once here, and one of them used to be bought with the other:
        //   • never a second LIVE Re-enable button, because rebuildTicketState reads the newest one
        //     as the AI's state and it would overrule a re-enable staff had already clicked;
        //   • "I need a human" is never a dead end, because the staff member who took this ticket
        //     may be gone and the member has nobody else to ask.
        // So the AI being off does not refuse the call — it only takes the BUTTON off the message.
        if (!ticketAi(channel.id, state)) {
            // Staff asking for the AI to stop when it already has: nothing to do, nobody to call.
            if (staff) return refuse('The AI is already off in this ticket.');
            if (humanPinged.has(channel.id)) return refuse('A human has been called already.');
            // Ping only, no components: the live Re-enable button already standing in this ticket
            // stays the only one, and the team gets the call the member asked for.
            await channel.send({
                ...(await humanPing(channel.guild, channel.id)),
                embeds: [rrEmbed({ title: 'A human is called', blocks: [`${member} asked for a person.`] })],
            });
            return true;
        }
        setTicketAi(channel.id, false);
        reportWaiting.stop(channel.id);
        // A staff member who switches the AI off IS the human — pinging the team about themselves
        // is noise. Every other door (the opener's /disableai, "@bot disableai", "I need a human")
        // calls somebody, and that ping is the only thing that writes `humanPinged`.
        // Into the CHANNEL, not through `respond`: this message and its live Re-enable button are
        // what a restarted bot reads the AI's state back from (rebuildTicketState).
        await channel.send({
            ...(staff ? {} : await humanPing(channel.guild, channel.id)),
            embeds: [rrEmbed({ title: 'AI is off', blocks: ['A human takes it from here.'] })],
            components: [aiBackRow()],
        });
        return true;
    }
    return refuse(`I only know ${TICKET_COMMANDS.map(c => `\`/${c}\``).join(', ')}.`);
}

// ── Panel, modal and ticket buttons ───────────────────────────────────────────
// Its own listener, keyed on customId: the /help, /steal and /roles menus in this file use
// in-memory collectors that die with the process, which is fine for a menu that lives 30 seconds
// and fatal for a panel that has to still work after a redeploy.
client.on('interactionCreate', async (interaction) => {
    try {
        if (VERIFY_GUILD_ID && interaction.guildId && interaction.guildId !== VERIFY_GUILD_ID) return;

        if (interaction.isStringSelectMenu() && interaction.customId === 'support:new') {
            const category = interaction.values[0];
            if (!ai.CATEGORY_KEYS.includes(category)) return;
            // The limit BEFORE the form: being refused after typing out the whole problem is the
            // rudest order to do this in. Synchronous off the channel cache — a modal cannot be
            // deferred and has three seconds. The checks after the submit stay, and stay the
            // authoritative ones: this one cannot ask a stale-looking blocker for its history.
            const limit = ticketLimits(interaction.guild, interaction.user.id, category);
            if (limit.ok) await interaction.showModal(buildTicketModal(category));
            else {
                await interaction.reply({ embeds: [ticketLimitEmbed(category, limit)], ephemeral: true });
                // …so it asks now, after the refusal: the Maps a restart emptied can name a ticket
                // that is visibly closed, and the member's next pick then gets the truth.
                const blocker = limit.reason === 'open' && interaction.guild.channels.cache.find(c => c.name === limit.open);
                if (blocker) hydrateTicket(blocker).catch(() => {});
            }
            // Discord's client keeps the picked option selected, and picking the SAME one again
            // fires nothing — a member who was refused could never retry that category. Re-sending
            // the unchanged components resets every client's menu. A MESSAGE edit, not a channel
            // edit, fire-and-forget, and only ever after the modal is on its way.
            interaction.message?.edit({ components: buildSupportPanel(interaction.guild).components })
                .catch(e => console.error('[support] Could not reset the panel menu:', e.message || e));
            return;
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith('support:form:')) {
            const category = interaction.customId.slice('support:form:'.length);
            if (!ai.CATEGORY_KEYS.includes(category)) return;
            await interaction.deferReply({ ephemeral: true });
            // Keyed by the human label straight away: the same object becomes the embed's fields
            // AND the text the model reads, so the model sees "Problem:" rather than "problem:".
            const fields = {};
            for (const [id, label] of Object.entries(FIELD_LABELS)) {
                fields[label] = (interaction.fields.getTextInputValue(id) || '').trim();
            }
            return openTicket(interaction, category, fields);
        }

        if (!interaction.isButton() || !interaction.customId.startsWith('ticket:')) return;
        const channel = interaction.channel;
        const state = parseTopic(channel?.topic);
        const refuse = (text) => {
            const payload = {
                embeds: [rrEmbed({ title: 'Not allowed', blocks: [text], colour: BRAND_BAD, footer: null })],
                ephemeral: true,
            };
            // Acknowledged already (see below) means reply() is no longer a valid answer.
            return (interaction.deferred || interaction.replied)
                ? interaction.followUp(payload)
                : interaction.reply(payload);
        };
        if (!state) return refuse('This is not a RazorReaper ticket.');
        const staff = Boolean(interaction.member && isStaff(interaction.member));
        const opener = interaction.user.id === state.opener;
        if (!opener && !staff) return refuse('Only the person who opened this ticket can use these buttons.');

        // ── Close, Delete, Re-enable AI, I need a human ───────────────────────
        // Four of the five ticket actions, and the buttons are only a door into the same
        // runTicketAction the slash commands and "@bot close" go through — guards, order and
        // wording included. "I need a human" IS /disableai: the AI steps aside and a person is
        // called, so it is a door and not a second producer of hand-off messages.
        const buttonAction = {
            'ticket:close': 'close',
            [TICKET_BUTTONS.del]: 'delete',
            [TICKET_BUTTONS.aiOn]: 'enableai',
            'ticket:human': 'disableai',
        }[interaction.customId];
        // Acknowledge BEFORE anything slow. All three of these outlive Discord's three-second
        // window — the transcript, the DM, the panel archive, the member fetch inside humanPing()
        // — and so does the hydrate below, which is a cold 50-message read on the first press in
        // each ticket after a restart. Their receipts arrive as ephemeral follow-ups. Re-enable
        // is the exception: it is fast, and its "AI is back on" is meant for the channel.
        if (buttonAction && buttonAction !== 'enableai') await interaction.deferUpdate();
        // The buttons stay on screen after a restart, so the memory behind them is read back here
        // too — one message fetch, once per ticket per process.
        await hydrateTicket(channel);
        // A closed channel keeps its buttons on screen. Delete is the only one that still means
        // anything there — the rest would re-open an argument that is already settled. This is
        // also the second-click guard: it refuses quietly instead of posting a second close.
        const isClosed = closedTickets.has(channel.id) || /^closed-/i.test(channel.name);
        if (isClosed && interaction.customId !== TICKET_BUTTONS.del) {
            return refuse('This ticket is already closed.');
        }

        if (buttonAction) {
            return runTicketAction(buttonAction, channel, interaction.member, (payload) =>
                (interaction.deferred || interaction.replied)
                    ? interaction.followUp({ ...payload, ephemeral: true })
                    : interaction.reply(payload),
            { message: interaction.message });
        }

        // ── My purchase ───────────────────────────────────────────────────────
        // Opener only, and it never touches a model: the panel already holds the order data the
        // SellHub webhook wrote onto the licence row.
        if (interaction.customId === 'ticket:purchase') {
            if (!opener) return refuse('Only the person who opened this ticket can look up their purchase.');
            if (!panelConfigured()) return refuse('Purchase lookup is not configured on this server.');
            await interaction.deferReply();
            return interaction.editReply({ embeds: [await purchaseEmbed(interaction.guild, interaction.user.id)] });
        }

        // ── The support-report step ───────────────────────────────────────────
        if (interaction.customId === 'ticket:report-skip') {
            reportWaiting.stop(channel.id);
            await consumeButtons(interaction.message);
            return interaction.reply({ embeds: [rrEmbed({ title: 'No problem', blocks: ['Carry on describing it here and I\'ll do my best.'] })] });
        }

        if (interaction.customId === TICKET_BUTTONS.reportSent) {
            if (!ticketAi(channel.id, state)) return refuse('The AI is off in this ticket — a human will read your report.');
            await interaction.deferReply();
            const since = reportWaiting.active(channel.id)?.since;
            const block = await fetchClientContext({
                discord_id: state.opener,
                ...(since ? { since: new Date(since).toISOString() } : {}),
            });
            // Say what happened BEFORE the answer lands, so the two messages read in order.
            await interaction.editReply({
                embeds: [block
                    ? rrEmbed({ title: 'Got your report', blocks: ['Reading it now.'], colour: BRAND_GOOD })
                    : rrEmbed({ title: 'Report not found', blocks: ['I can\'t see a new report for your account yet.', 'Paste the **Report ID** the app showed you — it starts with `FB-`.'], colour: BRAND_BAD })],
            });
            // Only once the data is actually here: an unanswered prompt keeps its live buttons,
            // which is also what says "still waiting" after a restart.
            if (block) {
                await consumeButtons(interaction.message);
                await answerWithClientContext(channel, state, block);
            }
            return;
        }

    } catch (e) {
        console.error('[support] Interaction failed:', e.message || e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            interaction.reply({ embeds: [errEmbed('❌ Something went wrong — please try again.')], ephemeral: true }).catch(() => {});
        }
    }
});

// ── Ticket transcripts → opener's DMs ─────────────────────────────────────────
// Ticket Tool's free tier never DMs transcripts, so this bot does it instead: when a
// ticket closes (Ticket Tool's Close button — and our /close — rename ticket-XXXX to
// closed-XXXX), the full channel history is rendered into a self-contained HTML file
// and DM'd to whoever opened the ticket. Disable with TICKET_TRANSCRIPT_DM=false.
const TICKET_TRANSCRIPT_DM = process.env.TICKET_TRANSCRIPT_DM !== 'false';
const ticketOwners = new Map();        // channelId -> userId, learned while the ticket is open
const transcribedTickets = new Set();  // channels already transcribed this session
const ticketMessageCache = new Map();  // channelId -> snapshot[], live capture for delete races
const TICKET_CACHE_CAP = 500;
const USER_MENTION_RE = /<@!?(\d+)>/;

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal message snapshot — transcripts are built from these so they can outlive the
// channel (Ticket Tool deletes ticket channels seconds after staff hit Delete).
function snapshotMessage(m) {
    return {
        author: m.author?.username || 'unknown',
        avatar: m.author?.displayAvatarURL({ extension: 'png', size: 64 }) || '',
        bot: Boolean(m.author?.bot),
        ts: m.createdTimestamp,
        content: m.content || '',
        embeds: (m.embeds || []).map(e => ({ title: e.title || '', desc: e.description || '' })),
        attachments: [...(m.attachments?.values() || [])].map(a => ({ name: a.name, url: a.url })),
    };
}

// Who opened this ticket? Most reliable first: what we recorded while the ticket was
// open; Ticket Tool's intro message (it pings the opener — in content or embed); the
// member-type permission overwrite. The overwrite scan is last because a claimer or an
// /adduser guest also holds one, and Ticket Tool strips the opener's on close.
async function resolveTicketOwner(channel) {
    if (ticketOwners.has(channel.id)) return ticketOwners.get(channel.id);
    try {
        const firstMsgs = await channel.messages.fetch({ after: channel.id, limit: 25 });
        const sorted = [...firstMsgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const m of sorted) {
            if (!m.author.bot) continue;
            let id = m.mentions.users.find(u => !u.bot)?.id;
            if (!id) {
                const src = [m.content, ...m.embeds.map(e => e.description || '')].join('\n');
                id = src.match(USER_MENTION_RE)?.[1];
            }
            if (!id) continue;
            const user = await client.users.fetch(id).catch(() => null);
            if (user && !user.bot) { ticketOwners.set(channel.id, user.id); return user.id; }
        }
    } catch { /* channel gone or history unreadable — fall through */ }
    for (const [, ow] of channel.permissionOverwrites?.cache || []) {
        if (ow.type !== 1 || !ow.allow.has(PermissionsBitField.Flags.ViewChannel)) continue;
        const user = await client.users.fetch(ow.id).catch(() => null);
        if (user && !user.bot) { ticketOwners.set(channel.id, user.id); return user.id; }
    }
    return null;
}

async function fetchTicketSnapshots(channel, cap = TICKET_CACHE_CAP) {
    const all = [];
    let before;
    while (all.length < cap) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;
        all.push(...batch.values());
        before = batch.last().id;
        if (batch.size < 100) break;
    }
    return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(snapshotMessage);
}

function renderTranscriptHtml(guildName, ticketName, snaps) {
    const fmt = ts => new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const rows = snaps.map(m => {
        const content = m.content ? `<div class="text">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>` : '';
        const embeds = m.embeds.map(e => {
            const t = e.title ? `<div class="et">${escapeHtml(e.title)}</div>` : '';
            const d = e.desc ? `<div>${escapeHtml(e.desc).slice(0, 1500).replace(/\n/g, '<br>')}</div>` : '';
            return (t || d) ? `<div class="embed">${t}${d}</div>` : '';
        }).join('');
        const atts = m.attachments.map(a =>
            `<div class="att">📎 <a href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a></div>`).join('');
        return `<div class="msg"><img class="av" src="${escapeHtml(m.avatar)}" alt=""><div class="body">` +
            `<div class="meta"><span class="name">${escapeHtml(m.author)}</span>` +
            `${m.bot ? '<span class="bot">BOT</span>' : ''}<span class="time">${fmt(m.ts)}</span></div>` +
            `${content}${embeds}${atts}</div></div>`;
    }).join('\n');
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(ticketName)} — RazorReaper transcript</title><style>
body{background:#1a1a1e;color:#dcddde;font:15px/1.5 'Segoe UI',system-ui,sans-serif;margin:0;padding:24px}
.head{border-bottom:2px solid #9b1a1a;padding-bottom:14px;margin-bottom:20px}
.head h1{margin:0;font-size:20px;color:#fff}.head .sub{color:#8e9297;font-size:13px;margin-top:4px}
.msg{display:flex;gap:12px;padding:8px 0}
.av{width:40px;height:40px;border-radius:50%;flex:none}
.meta{display:flex;gap:8px;align-items:baseline}
.name{font-weight:600;color:#fff}
.bot{background:#9b1a1a;color:#fff;font-size:10px;font-weight:700;border-radius:3px;padding:1px 4px}
.time{color:#72767d;font-size:12px}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
.embed{border-left:4px solid #9b1a1a;background:#232327;border-radius:4px;padding:8px 12px;margin-top:4px;max-width:520px}
.et{font-weight:600;color:#fff;margin-bottom:2px}
.att a{color:#00b0f4}
.foot{color:#72767d;font-size:12px;border-top:1px solid #2f3136;margin-top:20px;padding-top:10px}
</style></head><body>
<div class="head"><h1>🎟️ ${escapeHtml(ticketName)}</h1>
<div class="sub">${escapeHtml(guildName)} • ${snaps.length} message(s) • generated ${fmt(Date.now())} • RazorReaper Support</div></div>
${rows}
<div class="foot">Attachment links are Discord CDN URLs and may expire after a while — save anything important. • razorreaper.app</div>
</body></html>`;
}

/** @param {string} [html] already rendered by the close path — rendering it twice is wasted work. */
async function dmTicketTranscript(guild, ticketName, ownerId, snaps, html) {
    if (!ownerId) {
        console.log(`[transcript] No opener found for ${ticketName} — no DM sent.`);
        return;
    }
    if (!snaps || !snaps.length) {
        console.log(`[transcript] No messages captured for ${ticketName} — no DM sent.`);
        return;
    }
    const user = await client.users.fetch(ownerId).catch(() => null);
    if (!user || user.bot) return;
    const file = new AttachmentBuilder(
        Buffer.from(html || renderTranscriptHtml(guild.name, ticketName, snaps), 'utf8'),
        { name: `${ticketName}-transcript.html` },
    );
    try {
        await user.send({
            embeds: [rrEmbed({
                title: '📑 Your ticket transcript',
                blocks: [
                    `**${ticketName}** in **${guild.name}** was closed.`,
                    'The whole conversation is attached — open it in your browser.',
                ],
                thumb: brandThumb(guild, client.user),
            })],
            files: [file],
        });
        console.log(`[transcript] DM'd ${ticketName} (${snaps.length} messages) to ${user.tag}.`);
    } catch (e) {
        console.log(`[transcript] Could not DM ${user.tag} for ${ticketName} (${e.message || e}) — DMs closed?`);
    }
}

// Learn the opener the moment Ticket Tool creates the channel — by close time the
// opener's overwrite may already be stripped, so early beats late here.
client.on('channelCreate', (ch) => {
    if (!TICKET_TRANSCRIPT_DM || !ch.guild) return;
    if (VERIFY_GUILD_ID && ch.guild.id !== VERIFY_GUILD_ID) return;
    if (!TICKET_NAME_RE.test(ch.name || '')) return;
    setTimeout(() => { resolveTicketOwner(ch).catch(() => {}); }, 3000);
});

// Live capture: every message in a ticket goes into a bounded snapshot cache, so a
// transcript survives even when the channel is deleted without (or right after) a
// close. Also resolves the opener early after bot restarts mid-ticket.
client.on('messageCreate', (m) => {
    if (!TICKET_TRANSCRIPT_DM || !m.guild) return;
    if (VERIFY_GUILD_ID && m.guild.id !== VERIFY_GUILD_ID) return;
    if (!ANY_TICKET_NAME_RE.test(m.channel?.name || '')) return;
    let arr = ticketMessageCache.get(m.channelId);
    if (!arr) { arr = []; ticketMessageCache.set(m.channelId, arr); }
    arr.push(snapshotMessage(m));
    if (arr.length > TICKET_CACHE_CAP) arr.shift();
    if (arr.length === 1 && !ticketOwners.has(m.channelId)) {
        resolveTicketOwner(m.channel).catch(() => {});
    }
});

// A close (from Ticket Tool's button or /close) renames ticket-XXXX → closed-XXXX.
// Owner and history are captured IMMEDIATELY — the settle delay only tops up trailing
// messages (Ticket Tool's own "closed by …" post) and must never cost us the capture.
client.on('channelUpdate', async (oldCh, newCh) => {
    try {
        if (!TICKET_TRANSCRIPT_DM || !newCh.guild) return;
        if (VERIFY_GUILD_ID && newCh.guild.id !== VERIFY_GUILD_ID) return;
        const oldName = oldCh?.name || '';
        const newName = newCh.name || '';
        // Reopened ticket → allow a fresh transcript on its next close, and let the AI back in:
        // "closed" is this process's own bookkeeping now, so re-opening has to clear it.
        if (/^closed-\d+$/i.test(oldName) && TICKET_NAME_RE.test(newName)) {
            transcribedTickets.delete(newCh.id);
            closedTickets.delete(newCh.id);
            return;
        }
        if (!TICKET_NAME_RE.test(oldName) || !/^closed-\d+$/i.test(newName)) return;
        if (transcribedTickets.has(newCh.id)) return;
        transcribedTickets.add(newCh.id);
        const ownerId = await resolveTicketOwner(newCh);
        let snaps = null;
        try { snaps = await fetchTicketSnapshots(newCh); } catch { /* keep null, try again below */ }
        await new Promise(r => setTimeout(r, 4000));
        try {
            const settled = await fetchTicketSnapshots(newCh);
            if (settled.length >= (snaps?.length || 0)) snaps = settled;
        } catch { /* channel deleted during the wait — the first capture stands */ }
        if (!snaps || !snaps.length) snaps = ticketMessageCache.get(newCh.id) || null;
        await dmTicketTranscript(newCh.guild, oldName, ownerId, snaps);
        ticketMessageCache.delete(newCh.id);
    } catch (e) {
        console.error('[transcript] channelUpdate handler failed:', e.message || e);
    }
});

// Deleted without a close (Ticket Tool's Close & Delete, or a straight delete): the
// channel is gone, so the transcript comes from the live capture cache.
client.on('channelDelete', async (ch) => {
    try {
        if (!TICKET_TRANSCRIPT_DM || !ch.guild) return;
        if (VERIFY_GUILD_ID && ch.guild.id !== VERIFY_GUILD_ID) return;
        const name = ch.name || '';
        if (!ANY_TICKET_NAME_RE.test(name)) return;
        const snaps = ticketMessageCache.get(ch.id) || null;
        ticketMessageCache.delete(ch.id);
        // The channel is gone: so is anything this process still remembered about it. Up here
        // rather than in the block below, which two early returns skip — a ticket closed from
        // outside would otherwise keep its "a human was called" flag for the life of the process.
        closedTickets.delete(ch.id);
        hydrated.delete(ch.id);
        humanPinged.delete(ch.id);
        // Already transcribed = the close path ran; this is the auto-delete or the Delete button
        // finishing the job, and the panel already holds that ticket as "closed".
        if (transcribedTickets.has(ch.id)) { ticketOwners.delete(ch.id); return; }
        transcribedTickets.add(ch.id);
        let ownerId = ticketOwners.get(ch.id) || null;
        if (!ownerId) ownerId = await resolveTicketOwner(ch); // overwrites are still cached
        if (!snaps || !snaps.length) {
            console.log(`[transcript] ${name} was deleted with no capturable history — no DM.`);
            ticketOwners.delete(ch.id);
            return;
        }
        const html = renderTranscriptHtml(ch.guild.name, name, snaps);
        await dmTicketTranscript(ch.guild, name, ownerId, snaps, html);
        // A ticket deleted without ever being closed still belongs in the archive.
        const state = parseTopic(ch.topic);
        archiveTicket({
            channelId: ch.id,
            ticketNo: Number(name.replace(/[^0-9]/g, '')) || 0,
            channelName: name,
            discordId: ownerId || state?.opener || null,
            discordTag: (ownerId && client.users.cache.get(ownerId)?.tag) || null,
            category: state?.cat || 'other',
            status: 'deleted',
            openedAt: ch.createdTimestamp,
            closedAt: Date.now(),
            closedBy: null,
            aiReplies: totalAiReplies(ch.id, snaps, state),
            messageCount: snaps.length,
            provider: ticketProvider.get(ch.id) || null,
            transcriptHtml: html,
        }, { guildName: ch.guild.name, snaps }).catch(() => {});
        aiOn.delete(ch.id);
        aiReplyCount.delete(ch.id);
        ticketProvider.delete(ch.id);
        reportAsked.delete(ch.id);
        reportWaiting.stop(ch.id);
        ticketOwners.delete(ch.id);
    } catch (e) {
        console.error('[transcript] channelDelete handler failed:', e.message || e);
    }
});

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const follow = (u) => {
            https.get(u, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return follow(res.headers.location);
                if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
                file.on('error', reject);
            }).on('error', reject);
        };
        follow(url);
    });
}

const OWNER_ID = '947783551938592828';

function getAssignableRoles(guild) {
    const botMember = guild.members.me;
    if (!botMember) return [];
    const botTop = botMember.roles.highest.position;
    return Array.from(
        guild.roles.cache
            .filter(r => r.id !== guild.id && !r.managed && r.position < botTop)
            .sort((a, b) => b.position - a.position)
            .values()
    );
}

function buildRolesPayload(guild, targetMember) {
    const rolesArr = getAssignableRoles(guild);
    const MAX_OPTS = 25;
    const MAX_MENUS = 5;
    const MAX_TOTAL = MAX_OPTS * MAX_MENUS;
    const shown = rolesArr.slice(0, MAX_TOTAL);
    const overflow = Math.max(0, rolesArr.length - MAX_TOTAL);

    const components = [];
    for (let i = 0; i < shown.length; i += MAX_OPTS) {
        const chunk = shown.slice(i, i + MAX_OPTS);
        const chunkIdx = components.length;
        const options = chunk.map(r => ({
            label: r.name.slice(0, 100),
            value: r.id,
            default: targetMember.roles.cache.has(r.id),
        }));
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`roles:${chunkIdx}:${targetMember.id}`)
            .setPlaceholder(`Roles ${i + 1}–${i + chunk.length}`)
            .setMinValues(0)
            .setMaxValues(chunk.length)
            .addOptions(options);
        components.push(new ActionRowBuilder().addComponents(menu));
    }

    const heldCount = targetMember.roles.cache.filter(r => r.id !== guild.id).size;
    const desc =
        `🎭 **Target:** ${targetMember}\n` +
        `**Assignable roles:** ${rolesArr.length}\n` +
        `**Currently held (excl. @everyone):** ${heldCount}\n\n` +
        'Each dropdown chunk syncs independently on submit: selected = kept/added, deselected = removed.' +
        (overflow ? `\n\n⚠️ Showing the first ${MAX_TOTAL} of ${rolesArr.length} — ${overflow} role(s) not displayed (Discord cap).` : '');

    const e = infoEmbed(desc, '🎭 Role Selector');
    e.setFooter({ text: 'Menus expire after 5 minutes.' });
    return { embed: e, components, roleCount: rolesArr.length };
}

async function applyRoleSync(interaction) {
    const parts = interaction.customId.split(':');
    const targetId = parts[2];
    const guild = interaction.guild;
    let targetMember;
    try {
        targetMember = await guild.members.fetch(targetId);
    } catch {
        return interaction.reply({ embeds: [errEmbed('❌ Target user is no longer in this guild.')], ephemeral: true });
    }

    const chunkRoleIds = interaction.component.options.map(o => o.value);
    const selected = new Set(interaction.values);

    const toAdd = [];
    const toRemove = [];
    for (const roleId of chunkRoleIds) {
        const role = guild.roles.cache.get(roleId);
        if (!role || !role.editable) continue;
        const has = targetMember.roles.cache.has(roleId);
        const want = selected.has(roleId);
        if (want && !has) toAdd.push(roleId);
        else if (!want && has) toRemove.push(roleId);
    }

    if (!toAdd.length && !toRemove.length) {
        return interaction.reply({ embeds: [infoEmbed('ℹ️ No changes — your selection already matches current state.')], ephemeral: true });
    }

    try {
        if (toAdd.length) await targetMember.roles.add(toAdd, `Role selector (${interaction.user.tag})`);
        if (toRemove.length) await targetMember.roles.remove(toRemove, `Role selector (${interaction.user.tag})`);
    } catch (e) {
        return interaction.reply({ embeds: [errEmbed(`❌ Failed to update roles: ${e.message}`)], ephemeral: true });
    }

    const fmt = ids => ids.length ? ids.map(id => `<@&${id}>`).join(' ') : '_none_';
    return interaction.reply({
        embeds: [okEmbed(`✅ Synced.\n**Added:** ${fmt(toAdd)}\n**Removed:** ${fmt(toRemove)}`)],
        ephemeral: true,
    });
}

// ── Slash Command Definitions ─────────────────────────────────────────────────
const slashCommands = [
    new SlashCommandBuilder().setName('ping').setDescription('Check bot latency and WebSocket ping'),
    new SlashCommandBuilder().setName('help').setDescription('View all bot commands with an interactive menu'),
    new SlashCommandBuilder().setName('info').setDescription('View server statistics'),
    new SlashCommandBuilder().setName('userinfo').setDescription('View detailed user profile')
        .addUserOption(o => o.setName('user').setDescription('The user to look up (leave empty for yourself)').setRequired(false)),
    new SlashCommandBuilder().setName('status').setDescription('View bot & server status — uptime, ping, tickets'),
    new SlashCommandBuilder().setName('rules').setDescription('Display the server rules'),
    new SlashCommandBuilder().setName('ticket').setDescription('View your open tickets'),
    new SlashCommandBuilder().setName('queue').setDescription('See how many tickets are open'),
    new SlashCommandBuilder().setName('ticketinfo').setDescription('View info about the current ticket (use inside a ticket channel)'),
    new SlashCommandBuilder().setName('adduser').setDescription('Add a user to the current ticket')
        .addUserOption(o => o.setName('user').setDescription('The user to add to this ticket').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close the current ticket')
        .addStringOption(o => o.setName('reason').setDescription('Reason for closing the ticket').setRequired(false)),
    new SlashCommandBuilder().setName('transcript').setDescription('Get this ticket\'s transcript (use inside a ticket channel)'),
    new SlashCommandBuilder().setName('delete').setDescription('Staff — close if needed, then delete this ticket channel'),
    new SlashCommandBuilder().setName('enableai').setDescription('Let the AI answer in this ticket again'),
    new SlashCommandBuilder().setName('disableai').setDescription('Stop the AI answering in this ticket'),
    new SlashCommandBuilder().setName('ticketping').setDescription('Owner — choose who is pinged when a ticket asks for a human')
        .addUserOption(o => o.setName('user').setDescription('Toggle the support-ping role for this member').setRequired(true)),
    new SlashCommandBuilder().setName('say').setDescription('Send a message as the bot')
        .addStringOption(o => o.setName('message').setDescription('The message to send').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to send in (default: current)').addChannelTypes(ChannelType.GuildText).setRequired(false)),
    new SlashCommandBuilder().setName('clear').setDescription('Delete messages in this channel')
        .addIntegerOption(o => o.setName('amount').setDescription('Number of messages to delete').setRequired(true)
            .addChoices({ name: '10 messages', value: 10 }, { name: '25 messages', value: 25 }, { name: '50 messages', value: 50 }, { name: '100 messages', value: 100 }))
        .addStringOption(o => o.setName('filter').setDescription('Filter messages by type').setRequired(true)
            .addChoices({ name: 'All messages', value: 'all' }, { name: 'Specific user', value: 'user' }, { name: 'Bots only', value: 'bots' }))
        .addUserOption(o => o.setName('user').setDescription('User to filter by (only when filter = Specific user)').setRequired(false)),
    new SlashCommandBuilder().setName('purge').setDescription('Quick bulk-delete messages')
        .addIntegerOption(o => o.setName('amount').setDescription('Number of messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('kick').setDescription('Kick a member from the server')
        .addUserOption(o => o.setName('user').setDescription('The member to kick').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the kick').setRequired(false)),
    new SlashCommandBuilder().setName('ban').setDescription('Ban a member from the server')
        .addUserOption(o => o.setName('user').setDescription('The member to ban').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setRequired(false)),
    new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
        .addUserOption(o => o.setName('user').setDescription('The member to warn').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(false)),
    new SlashCommandBuilder().setName('warns').setDescription('View warnings for a member')
        .addUserOption(o => o.setName('user').setDescription('The member to check (leave empty for yourself)').setRequired(false)),
    new SlashCommandBuilder().setName('clearwarns').setDescription('Clear all warnings for a member')
        .addUserOption(o => o.setName('user').setDescription('The member to clear warnings for').setRequired(true)),
    new SlashCommandBuilder().setName('steal').setDescription('Steal emojis to this server or download them')
        .addStringOption(o => o.setName('emojis').setDescription('Paste emojis here (up to 5, separated by spaces)').setRequired(true)),
    new SlashCommandBuilder().setName('stealsticker').setDescription('Steal a sticker — reply to a sticker message first, then use this command')
        .addStringOption(o => o.setName('name').setDescription('Custom name for the sticker').setRequired(false)),
    new SlashCommandBuilder().setName('changeformat').setDescription('Convert an image or video file to a different format')
        .addAttachmentOption(o => o.setName('file').setDescription('The image or video file to convert').setRequired(true)),
    new SlashCommandBuilder().setName('roles').setDescription('Interactive role selector')
        .addUserOption(o => o.setName('user').setDescription('Target user (default: yourself)').setRequired(false)),
    new SlashCommandBuilder().setName('verify').setDescription('Verify your RazorReaper license to unlock the community')
        .addStringOption(o => o.setName('key').setDescription('Your license key (XXXX-XXXX-XXXX-XXXX)').setRequired(false))
        .addUserOption(o => o.setName('user').setDescription('Staff only — permanently grant this member the Verified Customer role').setRequired(false)),
];

// ── Home guild only ───────────────────────────────────────────────────────────
// This bot exists for the RazorReaper server. Anywhere else it registers no commands, so it
// would just sit there as dead weight — it leaves instead, on startup and on every new invite.
// Owner's call (2026-09-19): no exception for servers the notifier reads ARK alerts from — the
// alert relay moves to a second, public bot later.
async function leaveForeignGuild(guild) {
    if (!VERIFY_GUILD_ID || guild.id === VERIFY_GUILD_ID) return;
    console.log(`[RazorReaper] Leaving "${guild.name}" (${guild.id}) — not the home guild.`);
    await guild.leave().catch(e => console.error(`[RazorReaper] Failed to leave ${guild.id}:`, e.message || e));
}

client.on('guildCreate', (guild) => {
    leaveForeignGuild(guild).catch(e => console.error('[RazorReaper] guildCreate leave failed:', e.message || e));
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`[RazorReaper] Online as ${client.user.tag}`);
    console.log(`[RazorReaper] Connected to ${client.guilds.cache.size} server(s):`);
    client.guilds.cache.forEach(g => console.log(`  - ${g.name} (${g.id})`));
    client.user.setPresence({
          activities: [{ name: 'razorreaper.app | /help', type: ActivityType.Watching }],
          status: 'online',
    });

    // Leave anything that isn't the home guild.
    for (const [, g] of client.guilds.cache) {
        await leaveForeignGuild(g);
    }

    // Register slash commands. The bot is a RazorReaper-server bot: commands are registered ONLY
    // in the home guild (and stale global ones are wiped), so anywhere else — e.g. a server it
    // only listens in as the notifier — no commands exist at all.
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
        console.log('[RazorReaper] Registering slash commands (home guild only)...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
        await rest.put(Routes.applicationGuildCommands(client.user.id, VERIFY_GUILD_ID), {
            body: slashCommands.map(c => c.toJSON()),
        });
        console.log(`[RazorReaper] Slash commands registered for guild ${VERIFY_GUILD_ID}!`);
    } catch (err) {
        console.error('[RazorReaper] Failed to register slash commands:', err);
    }

    // The bot does not create this role — it is made once by hand and pinned in bot.env, because
    // finding roles by name is what left this server with duplicates.
    console.log(HUMAN_PING_ROLE_ID
        ? `[support] "I need a human" pings the holders of role ${HUMAN_PING_ROLE_ID}.`
        : '[support] HUMAN_PING_ROLE_ID is not set — "I need a human" pings the owner.');

    // Set bot bio + banner
    try {
        const path = require('path');
        const bannerPath = path.join(__dirname, 'banner.png');
        const bannerData = fs.readFileSync(bannerPath);
        const bannerBase64 = `data:image/png;base64,${bannerData.toString('base64')}`;
        await client.rest.patch('/users/@me', {
            body: {
                bio: '⚡ Official RazorReaper bot — ticket management, server info & moderation. Visit razorreaper.app',
                banner: bannerBase64,
            },
        });
        console.log('[RazorReaper] Banner & bio set!');
    } catch (err) {
        console.error('[RazorReaper] Failed to set banner/bio:', err.message || err);
    }

    // License-verification reconcile: periodically strip the Verified Customer role from members
    // whose license has since lapsed (revoked/expired/suspended in the admin panel).
    if (verifyConfigured() && RECONCILE_MINUTES > 0) {
        const runReconcile = () => reconcileVerifiedRoles().catch(e => console.error('[verify] Reconcile error:', e.message || e));
        setTimeout(runReconcile, 60_000);
        setInterval(runReconcile, RECONCILE_MINUTES * 60_000);
        console.log(`[verify] License gate ACTIVE — reconcile every ${RECONCILE_MINUTES} min.`);
    } else if (!verifyConfigured()) {
        console.log('[verify] License gate inactive (set VERIFY_API_BASE, VERIFY_SHARED_SECRET, VERIFIED_ROLE_ID to enable).');
    }

    // Resolve (or create) the Lifetime role and the two community chats before the panel sync,
    // so the panel can already name them. All three are idempotent — safe on every restart.
    const homeGuild = verifyGuild();
    // Staff first: the ticket-log overwrites below are built from these ids.
    resolveStaffRoles(homeGuild);
    await ensureLifetimeRole(homeGuild);
    await ensureCommunityChannels(homeGuild).catch(e => console.error('[chats] Setup error:', e.message || e));

    // Support: the Tickets category, the read-only #support channel and the panel that lives in
    // it. All three are find-or-create, so this is safe on every restart and repairs a deleted
    // panel by itself — the select menu has to work after a redeploy, unlike the in-memory
    // collectors the older commands use.
    try {
        const { channel, log } = await ensureSupportChannels(homeGuild);
        if (channel) await syncSupportPanel(homeGuild, channel);
        console.log(`[support] Ticket log: ${log ? `#${log.name}` : 'not available'}`
            + `, slowmode ${TICKET_SLOWMODE}s`
            + `, auto-delete ${TICKET_AUTO_DELETE_HOURS > 0 ? `${TICKET_AUTO_DELETE_HOURS}h after close` : 'off'}`
            + `, panel ${panelConfigured() ? 'connected' : 'not configured'}.`);
        console.log(support.enabled
            ? `[support] AI answering ACTIVE — providers: ${aiProviders.map(p => `${p.name}(${p.model})`).join(', ')}, budget ${support.budget.limit} tokens/day, KB ~${Math.ceil(aiKb.length / 4)} tokens.`
            : '[support] No AI key configured — tickets still work, they just say a human will answer.');
    } catch (e) {
        console.error('[support] Setup error:', e.message || e);
    }

    // The welcome embed's two channels — never created, only found (and then pinned).
    if (homeGuild) {
        const text = c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement;
        welcomeChannelId = findPinned(homeGuild.channels.cache, 'welcomeChannel', WELCOME_CHANNEL_ID, (n, c) => text(c) && n.includes('welcome'))?.id || null;
        rulesChannelId = findPinned(homeGuild.channels.cache, 'rulesChannel', RULES_CHANNEL_ID, (n, c) => text(c) && n.includes('rules'))?.id || null;
    }
    // One line with every id and where it came from (env|stored|name|created) for the deploy check.
    console.log(`[ids] resolved: ${Object.values(idLog).join(' ') || 'none'}`);

    // Keep the #verify panel current, and make sure every human holds the Member base role
    // (instant grant on join + startup/periodic backfill for anyone missed while offline).
    syncVerifyPanel().catch(e => console.error('[verify] Panel sync error:', e.message || e));
    // The closed-ticket sweep rides along on the member-role timer instead of adding a second
    // one. ponytail: that makes the granularity 6 h, so a ticket can outlive its deadline by
    // that much — give it its own interval only if an exact hour ever matters.
    const runSweeps = () => {
        backfillMemberRole().catch(e => console.error('[member-role] Backfill error:', e.message || e));
        sweepClosedTickets().catch(e => console.error('[support] Auto-delete sweep error:', e.message || e));
    };
    setTimeout(runSweeps, 30_000);
    setInterval(runSweeps, 6 * 60 * 60_000);
});

// ── Member auto-role on join ──────────────────────────────────────────────────
// Every human joiner is a Member from the moment they arrive — verification only adds on top.
client.on('guildMemberAdd', async (member) => {
    if (!MEMBER_ROLE_ID || member.user.bot) return;
    if (VERIFY_GUILD_ID && member.guild.id !== VERIFY_GUILD_ID) return;
    try {
        await member.roles.add(MEMBER_ROLE_ID, 'Member auto-role (join)');
    } catch (e) {
        console.error(`[member-role] Failed to grant Member to ${member.user.tag} on join:`, e.message || e);
    }
});

// ── Welcome new members ────────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
    // Home-guild only: never post welcomes into other servers the bot merely listens in.
    if (VERIFY_GUILD_ID && member.guild.id !== VERIFY_GUILD_ID) return;
    const ch = welcomeChannelId && member.guild.channels.cache.get(welcomeChannelId);
    if (!ch) return;
    const rules = rulesChannelId && member.guild.channels.cache.has(rulesChannelId) ? `<#${rulesChannelId}>` : '#rules';
    const e = new EmbedBuilder()
      .setColor(ACCENT)
      .setTitle('⚡ Welcome to RazorReaper!')
      .setDescription(
              `Hey ${member}, welcome to the community!\n\n` +
              `📋 Read the rules in ${rules}\n` +
              `🎟️ Need help? Open a ticket in ${supportChannelRef(member.guild)}\n` +
              `🌐 Visit us at **razorreaper.app**`
            )
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
      .setFooter({ text: `Member #${member.guild.memberCount}`, iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    ch.send({ embeds: [e] }).catch(() => {});
});

// ── Gate new members behind license verification ────────────────────────────────
// Independent listener so it runs whether or not a welcome channel exists. Verified joiners
// (e.g. they linked earlier, or re-joined) get their role back automatically; everyone else is
// DM'd how to verify. Inert unless the gate is configured.
client.on('guildMemberAdd', async (member) => {
    if (!verifyConfigured() || member.user.bot) return;
    if (VERIFY_GUILD_ID && member.guild.id !== VERIFY_GUILD_ID) return;

    try {
        const { data } = await verifyApi('/api/discord/status', { discord_id: member.id });
        if (data && data.ok && data.linked && data.active) {
            await grantVerifiedRole(member.guild, member.id, data.lifetime === true);
            return;
        }
    } catch (e) {
        console.error('[verify] Join status check failed:', e.message || e);
    }

    // Not verified yet — DM instructions (best-effort; many users have DMs closed).
    member.send({
        embeds: [rrEmbed({
            title: '🔒 One step to join',
            blocks: [
                'This community is for **RazorReaper licence holders**.',
                'Run `/verify key:XXXX-XXXX-XXXX-XXXX` in the server.',
                VERIFY_API_BASE && `Prefer one click? Open:\n${VERIFY_API_BASE}/api/discord/oauth-start?key=YOUR-KEY`,
            ],
            thumb: brandThumb(member.guild, client.user),
        })],
    }).catch(() => {});
});

// ── Message Commands ──────────────────────────────────────────────────────────
// ── Slash Command Handler ─────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member, channel } = interaction;

    // ── /verify ─────────────────────────────────────────────────────────────────
    if (commandName === 'verify') {
        if (!verifyConfigured()) {
            return interaction.reply({ embeds: [verifyBad('Verification not set up', 'Nobody has configured licence checks on this server yet.')], ephemeral: true });
        }

        // ── Staff manual grant: /verify user:@member — permanently mark someone Verified,
        // no license required, and immune to the reconcile sweep. Allowed from any channel.
        const targetUser = interaction.options.getUser('user');
        if (targetUser) {
            if (!member || !isStaff(member)) {
                return interaction.reply({ embeds: [verifyBad('Staff only', 'Only staff can grant Verified to another member.')], ephemeral: true });
            }
            if (targetUser.bot) {
                return interaction.reply({ embeds: [verifyBad('Not a member', 'A bot cannot hold a licence.')], ephemeral: true });
            }
            await interaction.deferReply({ ephemeral: true });
            try {
                const { data } = await verifyApi('/api/discord/verify', {
                    discord_id: targetUser.id,
                    discord_tag: targetUser.tag,
                    manual: true,
                });
                if (!data || !data.ok) {
                    return interaction.editReply({ embeds: [verifyBad('Grant not recorded', 'The panel did not take it.\nTry again in a minute.')] });
                }
                const granted = await grantVerifiedRole(guild || verifyGuild(), targetUser.id, data.lifetime === true);
                console.log(`[verify] Manual grant: ${interaction.user.tag} -> ${targetUser.tag} (${targetUser.id}), role=${granted}`);
                return interaction.editReply({
                    embeds: [granted
                        ? verifyOk('✅ Granted', `**${targetUser.tag}** now holds ${verifiedRoleMention()} permanently.\nThe licence sweep will not revoke it.`)
                        : verifyOk('✅ Grant recorded', `I could not assign the role to **${targetUser.tag}** — check my role position.\nIt applies on the next sweep.`)],
                });
            } catch (e) {
                console.error('[verify] Manual grant failed:', e.message || e);
                return interaction.editReply({ embeds: [verifyBad('Grant not recorded', 'The panel did not take it.\nTry again in a minute.')] });
            }
        }

        // Keep /verify to its dedicated channel — running it in #general etc. just points there.
        if (VERIFY_CHANNEL_ID && interaction.channelId !== VERIFY_CHANNEL_ID) {
            return interaction.reply({ embeds: [verifyBad('Wrong channel', `Please run \`/verify\` in <#${VERIFY_CHANNEL_ID}>.`)], ephemeral: true });
        }
        const key = (interaction.options.getString('key') || '').trim();
        if (!key) {
            return interaction.reply({ embeds: [verifyBad('Key missing', 'Run `/verify key:XXXX-XXXX-XXXX-XXXX`.')], ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        try {
            const { data } = await verifyApi('/api/discord/verify', {
                discord_id: interaction.user.id,
                discord_tag: interaction.user.tag,
                license_key: key,
            });

            if (!data || !data.ok) {
                return interaction.editReply({ embeds: [verifyBad('Verification unavailable', 'I could not reach the licence server.\nPlease try again shortly.')] });
            }
            if (!data.verified) {
                return interaction.editReply({ embeds: [verifyBad('Licence not verified', shortLine(data.message, 220) || 'That licence could not be verified.')] });
            }

            // License is valid + link recorded — grant the Verified role (in this guild, or the
            // configured community guild if the command was used in a DM).
            const targetGuild = guild || verifyGuild();
            const granted = await grantVerifiedRole(targetGuild, interaction.user.id, data.lifetime === true);
            return interaction.editReply({
                embeds: [granted
                    ? verifyOk('✅ Verified', 'Your licence is linked and your access is unlocked.\nWelcome to the community.')
                    : verifyOk('✅ Licence linked', 'I could not assign your role automatically.\nPlease ping a staff member.')],
            });
        } catch (e) {
            console.error('[verify] Command failed:', e.message || e);
            return interaction.editReply({ embeds: [verifyBad('Verification unavailable', 'I could not reach the licence server.\nPlease try again shortly.')] });
        }
    }

    // ── /ping ─────────────────────────────────────────────────────────────────
    if (commandName === 'ping') {
        const sent = await interaction.reply({ embeds: [infoEmbed('⏱️ Pinging...')], fetchReply: true });
        const ms = sent.createdTimestamp - interaction.createdTimestamp;
        return sent.edit({ embeds: [infoEmbed(`⚡ Pong! \`${ms}ms\` | WS: \`${client.ws.ping}ms\``)] });
    }

    // ── /help ─────────────────────────────────────────────────────────────────
    if (commandName === 'help') {
        const isS = isStaff(member);
        const helpCategories = {
            home: () => new EmbedBuilder()
                .setColor(ACCENT)
                .setTitle('⚡ RazorReaper Bot')
                .setDescription(
                    'Welcome to the **RazorReaper** help menu!\n\n' +
                    'Use the dropdown below to browse command categories.\n\n' +
                    '**Slash Commands:** `/command`\n' +
                    '**Website:** [razorreaper.app](https://razorreaper.app)'
                )
                .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 256 }))
                .addFields({ name: '📂 Categories', value:
                    '🎟️ **Tickets** — Manage support tickets\n' +
                    '📊 **Server** — Server info & utilities\n' +
                    '😎 **Emoji** — Steal emojis & stickers\n' +
                    (isS ? '🛡️ **Admin** — Channel management & tools\n🔨 **Staff** — Moderation & member management\n' : '')
                })
                .setFooter({ text: 'RazorReaper Bot | razorreaper.app', iconURL: client.user.displayAvatarURL() })
                .setTimestamp(),
            tickets: () => new EmbedBuilder()
                .setColor(ACCENT).setTitle('🎟️ Ticket Commands')
                .setDescription('Manage and interact with the ticket system.')
                .addFields(
                    { name: '`/ticket`', value: 'View your open ticket(s)' },
                    { name: '`/queue`', value: 'See how many tickets are open' },
                    { name: '`/ticketinfo`', value: 'Info about current ticket *(use inside a ticket channel)*' },
                    { name: '`/adduser` `user`', value: 'Add someone to current ticket *(use inside a ticket channel)*' },
                    { name: '`/close` `[reason]` · `/transcript`', value: 'Close this ticket, or get the conversation as a file' },
                    { name: '`/enableai` · `/disableai`', value: 'Turn automatic answers in this ticket back on, or off' },
                    { name: '`/delete`', value: 'Staff — close (if it is still open) and delete this ticket channel' },
                    { name: `@${client.user.username} <command>`, value: 'The same five inside a ticket: mention me and add `close`, `transcript`, `delete`, `enableai` or `disableai`' },
                ).setFooter({ text: 'RazorReaper Bot | razorreaper.app', iconURL: client.user.displayAvatarURL() }),
            server: () => new EmbedBuilder()
                .setColor(CYAN).setTitle('📊 Server Commands')
                .setDescription('View server info and utilities.')
                .addFields(
                    { name: '`/info`', value: 'Server statistics — members, boosts, creation date and more' },
                    { name: '`/userinfo` `[user]`', value: 'Detailed user profile — roles, join date, account age' },
                    { name: '`/status`', value: 'Bot & server status — uptime, ping, open tickets' },
                    { name: '`/rules`', value: 'Display the server rules' },
                    { name: '`/verify` `key`', value: 'Verify your RazorReaper license to unlock the community' },
                    { name: '`/ping`', value: 'Check bot latency and WebSocket ping' },
                ).setFooter({ text: 'RazorReaper Bot | razorreaper.app', iconURL: client.user.displayAvatarURL() }),
            emoji: () => new EmbedBuilder()
                .setColor(0xffcc00).setTitle('😎 Emoji & Sticker Commands')
                .setDescription('Steal emojis and stickers from other servers!')
                .addFields(
                    { name: '`/steal` `emojis`', value: 'Paste emojis into the input field — shows **Steal / Download / Both** buttons' },
                    { name: '`/stealsticker` `[name]`', value: 'Reply to a sticker message first, then run this command' },
                ).setFooter({ text: 'Requires Manage Expressions permission', iconURL: client.user.displayAvatarURL() }),
            admin: () => new EmbedBuilder()
                .setColor(0x9b59b6).setTitle('🛡️ Admin Commands')
                .setDescription('Channel management and administrative tools. Staff only.')
                .addFields(
                    { name: '`/clear` `amount` `filter` `[user]`', value: 'Delete messages — pick amount, filter type, and optionally a specific user' },
                    { name: '`/purge` `amount`', value: 'Quick bulk-delete messages' },
                    { name: '`/say` `message` `[channel]`', value: 'Send an announcement as the bot' },
                    { name: '`/close` `[reason]`', value: 'Close a ticket channel *(use inside a ticket channel)*' },
                ).setFooter({ text: 'RazorReaper Bot | razorreaper.app', iconURL: client.user.displayAvatarURL() }),
            staff: () => new EmbedBuilder()
                .setColor(0xff4444).setTitle('🔨 Staff Commands')
                .setDescription('Member moderation and management. Staff only.')
                .addFields(
                    { name: '`/kick` `user` `[reason]`', value: 'Kick a member from the server' },
                    { name: '`/ban` `user` `[reason]`', value: 'Ban a member from the server' },
                    { name: '`/warn` `user` `[reason]`', value: 'Issue a warning — member gets a DM' },
                    { name: '`/warns` `[user]`', value: 'View all warnings for a member' },
                    { name: '`/clearwarns` `user`', value: 'Clear all warnings for a member' },
                ).setFooter({ text: 'RazorReaper Bot | razorreaper.app', iconURL: client.user.displayAvatarURL() }),
        };

        const options = [
            { label: 'Home', description: 'Main help overview', value: 'home', emoji: '⚡' },
            { label: 'Tickets', description: 'Ticket system commands', value: 'tickets', emoji: '🎟️' },
            { label: 'Server', description: 'Server info & utilities', value: 'server', emoji: '📊' },
            { label: 'Emoji & Stickers', description: 'Steal emojis & stickers', value: 'emoji', emoji: '😎' },
        ];
        if (isS) {
            options.push({ label: 'Admin', description: 'Channel management & tools', value: 'admin', emoji: '🛡️' });
            options.push({ label: 'Staff', description: 'Member moderation', value: 'staff', emoji: '🔨' });
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`help_slash_${interaction.id}`)
            .setPlaceholder('Select a category...')
            .addOptions(options);

        const reply = await interaction.reply({
            embeds: [helpCategories.home()],
            components: [new ActionRowBuilder().addComponents(selectMenu)],
            fetchReply: true,
        });

        const collector = reply.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, time: 120_000 });
        collector.on('collect', async (i) => { const b = helpCategories[i.values[0]]; if (b) await i.update({ embeds: [b()] }); });
        collector.on('end', () => { reply.edit({ components: [] }).catch(() => {}); });
        return;
    }

    // ── /info ─────────────────────────────────────────────────────────────────
    if (commandName === 'info') {
        await guild.fetch();
        const onlineCount = guild.members.cache.filter(m => m.presence?.status === 'online').size;
        const boostTier = guild.premiumTier === 0 ? 'No boost' : `Tier ${guild.premiumTier}`;
        const e = new EmbedBuilder().setColor(ACCENT).setTitle(`⚙️ ${guild.name}`)
            .setThumbnail(guild.iconURL({ dynamic: true }))
            .addFields(
                { name: '👥 Members', value: `${guild.memberCount}`, inline: true },
                { name: '🟢 Online', value: `${onlineCount}`, inline: true },
                { name: '🚀 Boost', value: boostTier, inline: true },
                { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
                { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
                { name: '🌐 Website', value: '[razorreaper.app](https://razorreaper.app)', inline: true },
            ).setFooter({ text: 'RazorReaper', iconURL: client.user.displayAvatarURL() }).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /userinfo ─────────────────────────────────────────────────────────────
    if (commandName === 'userinfo') {
        const target = interaction.options.getMember('user') || member;
        const roles = target.roles.cache.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position);
        const topRoles = roles.first(5).map(r => r.toString()).join(' ') || 'None';
        const e = new EmbedBuilder().setColor(CYAN).setTitle(`👤 ${target.user.username}`)
            .setThumbnail(target.user.displayAvatarURL({ dynamic: true, size: 256 }))
            .addFields(
                { name: '🆔 User ID', value: target.id, inline: true },
                { name: '📅 Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
                { name: '🗓️ Account Age', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: '🏆 Top Role', value: `${target.roles.highest}`, inline: true },
                { name: '🤖 Bot?', value: target.user.bot ? 'Yes' : 'No', inline: true },
                { name: `📋 Roles (${roles.size})`, value: topRoles },
            ).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /status ───────────────────────────────────────────────────────────────
    if (commandName === 'status') {
        const uptime = process.uptime();
        const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = Math.floor(uptime % 60);
        const openTickets = guild.channels.cache.filter(c => isTicketChannel(c)).size;
        const e = infoEmbed(null, '📊 RazorReaper Status');
        e.addFields(
            { name: '🤖 Bot', value: 'Online ✅', inline: true },
            { name: '⏱️ Uptime', value: `${h}h ${m}m ${s}s`, inline: true },
            { name: '📡 Ping', value: `${client.ws.ping}ms`, inline: true },
            { name: '🎟️ Open Tickets', value: `${openTickets}`, inline: true },
            { name: '👥 Members', value: `${guild.memberCount}`, inline: true },
            { name: '🌐 Website', value: '[razorreaper.app](https://razorreaper.app)', inline: true },
        ).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /rules ────────────────────────────────────────────────────────────────
    if (commandName === 'rules') {
        const e = new EmbedBuilder().setColor(ACCENT).setTitle('📋 RazorReaper — Server Rules')
            .setDescription(
                '**1.** Be respectful to all members.\n**2.** No spam, advertising or self-promotion.\n' +
                '**3.** No NSFW content.\n**4.** No doxxing or sharing personal info.\n' +
                '**5.** Follow Discord\'s Terms of Service.\n**6.** Use channels for their intended purpose.\n' +
                '**7.** All disputes go through the ticket system — do not DM staff.\n\n*Violations may result in a warn, kick or ban.*'
            ).setFooter({ text: 'RazorReaper | razorreaper.app' });
        return interaction.reply({ embeds: [e] });
    }

    // ── /ticket ───────────────────────────────────────────────────────────────
    if (commandName === 'ticket') {
        const userTickets = guild.channels.cache.filter(c => isTicketChannel(c) && c.permissionOverwrites.cache.has(interaction.user.id));
        if (userTickets.size === 0) {
            return interaction.reply({ embeds: [infoEmbed(`❌ You have no open tickets.\n\nOpen one in ${supportChannelRef(guild)}!`)], ephemeral: true });
        }
        const list = userTickets.map(c => `• ${c} — \`${c.name}\``).join('\n');
        return interaction.reply({ embeds: [infoEmbed(`🎟️ Your open ticket${userTickets.size > 1 ? 's' : ''}:\n${list}`)], ephemeral: true });
    }

    // ── /queue ────────────────────────────────────────────────────────────────
    if (commandName === 'queue') {
        const openTickets = guild.channels.cache.filter(c => isTicketChannel(c));
        // Not the closedTickets Map above — this one counts channels, that one remembers closes.
        const closedChannels = guild.channels.cache.filter(c => c.name.toLowerCase().startsWith('closed-'));
        const e = infoEmbed(null, '🎟️ Ticket Queue');
        e.addFields(
            { name: '🟢 Open Tickets', value: `${openTickets.size}`, inline: true },
            { name: '🔴 Closed Tickets', value: `${closedChannels.size}`, inline: true },
            { name: '📊 Total', value: `${openTickets.size + closedChannels.size}`, inline: true },
        );
        if (isStaff(member) && openTickets.size > 0) {
            e.addFields({ name: '📋 Open Channels', value: openTickets.map(c => `• ${c}`).join('\n').substring(0, 1024) });
        }
        return interaction.reply({ embeds: [e] });
    }

    // ── /ticketinfo ───────────────────────────────────────────────────────────
    if (commandName === 'ticketinfo') {
        if (!isTicketChannel(channel)) return interaction.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')], ephemeral: true });
        const perms = channel.permissionOverwrites.cache;
        const ticketOwner = perms.filter(p => p.type === 1 && p.id !== guild.id).find(p => p.allow.has(PermissionsBitField.Flags.ViewChannel));
        const ownerUser = ticketOwner ? await client.users.fetch(ticketOwner.id).catch(() => null) : null;
        const e = infoEmbed(null, `🎟️ Ticket Info — #${channel.name}`);
        e.addFields(
            { name: '📛 Channel', value: `${channel}`, inline: true },
            { name: '👤 Owner', value: ownerUser ? `<@${ownerUser.id}>` : 'Unknown', inline: true },
            { name: '📅 Created', value: `<t:${Math.floor(channel.createdTimestamp / 1000)}:R>`, inline: true },
        ).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /adduser ──────────────────────────────────────────────────────────────
    if (commandName === 'adduser') {
        if (!isTicketChannel(channel)) return interaction.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        await channel.permissionOverwrites.edit(target, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        return interaction.reply({ embeds: [okEmbed(`✅ Added ${target} to this ticket.`)] });
    }

    // ── /close /transcript /delete /enableai /disableai ───────────────────────
    // The second door into runTicketAction — same guards, same wording as the buttons and as
    // "@bot close". The reply is ephemeral throughout: a transcript posted into the channel
    // would be a leak, and the actions that have something to SAY say it in the channel already.
    if (TICKET_COMMANDS.includes(commandName)) {
        if (!ANY_TICKET_NAME_RE.test(channel?.name || '')) {
            return interaction.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')], ephemeral: true });
        }
        // Closing, deleting and building a transcript all outlive the three-second reply window.
        await interaction.deferReply({ ephemeral: true });
        let said = false;
        try {
            await runTicketAction(commandName, channel, member, (payload) => {
                said = true;
                return interaction.editReply(payload);
            }, { reason: interaction.options.getString('reason') || '' });
        } catch (e) {
            console.error(`[support] /${commandName} failed:`, e.message || e);
            if (!said) return interaction.editReply({ embeds: [errEmbed('❌ Something went wrong — please try again.')] }).catch(() => {});
        }
        // disableai only posts into the channel — the deferred reply still has to be answered.
        if (!said) await interaction.editReply({ embeds: [okEmbed('✅ Done.')] }).catch(() => {});
        return;
    }

    // ── /ticketping ───────────────────────────────────────────────────────────
    // Who gets pinged by "I need a human", without leaving Discord's own member menu behind:
    // the role IS the setting, this command just toggles it for the owner.
    if (commandName === 'ticketping') {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({ embeds: [errEmbed('❌ You are not authorized to use this command.')], ephemeral: true });
        }
        const role = HUMAN_PING_ROLE_ID && guild?.roles.cache.get(HUMAN_PING_ROLE_ID);
        if (!role) {
            return interaction.reply({ embeds: [errEmbed('❌ No support-ping role is configured (`HUMAN_PING_ROLE_ID`) — tickets ping you.')], ephemeral: true });
        }
        const target = interaction.options.getMember('user');
        if (!target) return interaction.reply({ embeds: [errEmbed('❌ That member is not in this server.')], ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const had = target.roles.cache.has(role.id);
        try {
            await (had ? target.roles.remove(role) : target.roles.add(role));
        } catch (e) {
            return interaction.editReply({ embeds: [errEmbed(`❌ Could not change the role: ${e.message || e}`)] });
        }
        const now = [...role.members.keys()].slice(0, HUMAN_PING_MAX).map(id => `<@${id}>`);
        return interaction.editReply({
            embeds: [rrEmbed({
                title: had ? 'Removed' : 'Added',
                blocks: [
                    `${target} ${had ? 'is no longer' : 'is now'} pinged when a ticket asks for a human.`,
                    `Pinged now: ${now.length ? now.join(' ') : 'nobody — so you are'}`,
                ],
                colour: had ? BRAND_BAD : BRAND_GOOD,
                footer: null,
            })],
            allowedMentions: { parse: [] },
        });
    }

    // ── /say ──────────────────────────────────────────────────────────────────
    if (commandName === 'say') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const text = interaction.options.getString('message');
        const targetChannel = interaction.options.getChannel('channel') || channel;
        await targetChannel.send(text);
        return interaction.reply({ embeds: [okEmbed(`✅ Message sent to ${targetChannel}`)], ephemeral: true });
    }

    // ── /clear ────────────────────────────────────────────────────────────────
    if (commandName === 'clear') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const amount = interaction.options.getInteger('amount');
        const filter = interaction.options.getString('filter');
        const targetUser = interaction.options.getUser('user');

        if (filter === 'user' && !targetUser) {
            return interaction.reply({ embeds: [errEmbed('❌ You selected "Specific user" but didn\'t provide a user.\nUse the `user` option.')], ephemeral: true });
        }

        await interaction.reply({ embeds: [infoEmbed('🗑️ Clearing messages...')] });

        let totalDeleted = 0;
        let remaining = amount;

        while (remaining > 0) {
            const fetchAmount = Math.min(remaining, 100);
            const fetched = await channel.messages.fetch({ limit: fetchAmount }).catch(() => null);
            if (!fetched || fetched.size === 0) break;

            let toDelete = fetched;
            if (filter === 'user' && targetUser) toDelete = toDelete.filter(m => m.author.id === targetUser.id);
            else if (filter === 'bots') toDelete = toDelete.filter(m => m.author.bot);

            const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
            toDelete = toDelete.filter(m => m.createdTimestamp > twoWeeksAgo);

            if (toDelete.size === 0) break;
            const deleted = await channel.bulkDelete(toDelete, true).catch(() => null);
            if (!deleted || deleted.size === 0) break;

            totalDeleted += deleted.size;
            remaining -= fetchAmount;
            if (remaining > 0) await new Promise(r => setTimeout(r, 1000));
        }

        let desc = `🗑️ Deleted **${totalDeleted}** messages`;
        if (filter === 'user' && targetUser) desc += ` from ${targetUser}`;
        else if (filter === 'bots') desc += ' from bots';
        desc += ' in this channel.';

        const m = await channel.send({ embeds: [okEmbed(desc)] });
        setTimeout(() => m.delete().catch(() => {}), 5000);
        return;
    }

    // ── /purge ────────────────────────────────────────────────────────────────
    if (commandName === 'purge') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const n = interaction.options.getInteger('amount');
        await interaction.reply({ embeds: [infoEmbed('🗑️ Purging...')], ephemeral: true });
        const deleted = await channel.bulkDelete(n, true).catch(() => null);
        if (!deleted) return interaction.editReply({ embeds: [errEmbed('❌ Cannot delete messages older than 14 days.')] });
        const m = await channel.send({ embeds: [okEmbed(`🗑️ Deleted **${deleted.size}** messages.`)] });
        setTimeout(() => m.delete().catch(() => {}), 3000);
        return;
    }

    // ── /kick ─────────────────────────────────────────────────────────────────
    if (commandName === 'kick') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        if (!target.kickable) return interaction.reply({ embeds: [errEmbed('❌ Cannot kick this user.')], ephemeral: true });
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await target.kick(reason);
        return interaction.reply({ embeds: [staffEmbed(`✅ **${target.user.tag}** was kicked.\n**Reason:** ${reason}`, '👢 Member Kicked')] });
    }

    // ── /ban ──────────────────────────────────────────────────────────────────
    if (commandName === 'ban') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        if (!target.bannable) return interaction.reply({ embeds: [errEmbed('❌ Cannot ban this user.')], ephemeral: true });
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await target.ban({ reason, deleteMessageSeconds: 86400 });
        return interaction.reply({ embeds: [staffEmbed(`✅ **${target.user.tag}** was banned.\n**Reason:** ${reason}`, '🔨 Member Banned')] });
    }

    // ── /warn ─────────────────────────────────────────────────────────────────
    if (commandName === 'warn') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const warnKey = `${guild.id}:${target.id}`;
        if (!warns[warnKey]) warns[warnKey] = [];
        warns[warnKey].push({ reason, mod: interaction.user.tag, time: Date.now() });
        const count = warns[warnKey].length;
        target.send({ embeds: [infoEmbed(`⚠️ You received a warning in **${guild.name}**\n**Reason:** ${reason}\n**Total Warnings:** ${count}`)] }).catch(() => {});
        return interaction.reply({ embeds: [staffEmbed(`⚠️ **${target.user.tag}** has been warned.\n**Reason:** ${reason}\n**Total Warnings:** ${count}`, '⚠️ Member Warned')] });
    }

    // ── /warns ────────────────────────────────────────────────────────────────
    if (commandName === 'warns') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user') || member;
        const userWarns = warns[`${guild.id}:${target.id}`] || [];
        if (userWarns.length === 0) return interaction.reply({ embeds: [infoEmbed(`✅ **${target.user.tag}** has no warnings.`)] });
        const list = userWarns.map((w, i) => `**${i + 1}.** ${w.reason} — *${w.mod}* — <t:${Math.floor(w.time / 1000)}:R>`).join('\n');
        return interaction.reply({ embeds: [staffEmbed(list, `⚠️ Warnings for ${target.user.tag} (${userWarns.length})`)] });
    }

    // ── /clearwarns ───────────────────────────────────────────────────────────
    if (commandName === 'clearwarns') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        warns[`${guild.id}:${target.id}`] = [];
        return interaction.reply({ embeds: [okEmbed(`✅ Cleared all warnings for **${target.user.tag}**.`)] });
    }

    // ── /steal ────────────────────────────────────────────────────────────────
    if (commandName === 'steal') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageGuildExpressions)) {
            return interaction.reply({ embeds: [errEmbed('❌ You need the **Manage Expressions** permission.')], ephemeral: true });
        }

        const input = interaction.options.getString('emojis');
        const emojiRegex = /<(a?):(\w+):(\d+)>/g;
        const found = [];

        for (const match of input.matchAll(emojiRegex)) {
            found.push({ animated: match[1] === 'a', name: match[2], id: match[3] });
        }

        // Check if it's a raw ID
        if (found.length === 0 && /^\d+$/.test(input.trim())) {
            found.push({ animated: false, name: 'stolen_emoji', id: input.trim(), tryGif: true });
        }

        if (found.length === 0) {
            return interaction.reply({ embeds: [errEmbed('❌ No custom emojis found in your input.\nPaste Discord custom emojis like `:emoji:` into the field.')], ephemeral: true });
        }

        const emojiList = found.map((e, i) => `**${i + 1}.** \`:${e.name}:\` ${e.animated ? '*(animated)*' : ''}`).join('\n');

        const previewEmbed = new EmbedBuilder()
            .setColor(CYAN).setTitle('😎 Emoji Stealer — Select & Choose')
            .setDescription(`Found **${found.length}** emoji(s):\n\n${emojiList}`)
            .setFooter({ text: 'Select emojis below, then choose to steal or download. Expires in 60s.' }).setTimestamp();

        const components = [];
        if (found.length > 1) {
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`steal_slash_select_${interaction.id}`)
                .setPlaceholder('Select emojis to steal/download...')
                .setMinValues(1).setMaxValues(found.length)
                .addOptions(found.map((e, i) => ({
                    label: `:${e.name}:`, description: e.animated ? 'Animated emoji' : 'Static emoji',
                    value: String(i), emoji: { id: e.id, animated: e.animated },
                })));
            components.push(new ActionRowBuilder().addComponents(selectMenu));
        }

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`steal_slash_add_${interaction.id}`).setLabel('Steal to Server').setStyle(ButtonStyle.Success).setEmoji('😎'),
            new ButtonBuilder().setCustomId(`steal_slash_dl_${interaction.id}`).setLabel('Download').setStyle(ButtonStyle.Primary).setEmoji('📥'),
            new ButtonBuilder().setCustomId(`steal_slash_both_${interaction.id}`).setLabel('Steal + Download').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
            new ButtonBuilder().setCustomId(`steal_slash_cancel_${interaction.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
        );
        components.push(buttons);

        const reply = await interaction.reply({ embeds: [previewEmbed], components, fetchReply: true });

        let selectedIndices = found.map((_, i) => i);
        const collector = reply.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, time: 60_000 });

        collector.on('collect', async (btnInt) => {
            if (btnInt.customId === `steal_slash_select_${interaction.id}`) {
                selectedIndices = btnInt.values.map(Number);
                const updatedList = found.map((e, i) =>
                    `${selectedIndices.includes(i) ? '✅' : '⬜'} **${i + 1}.** \`:${e.name}:\` ${e.animated ? '*(animated)*' : ''}`
                ).join('\n');
                previewEmbed.setDescription(`Found **${found.length}** emoji(s) — **${selectedIndices.length}** selected:\n\n${updatedList}`);
                return btnInt.update({ embeds: [previewEmbed] });
            }
            if (btnInt.customId === `steal_slash_cancel_${interaction.id}`) {
                collector.stop('cancelled');
                return btnInt.update({ embeds: [errEmbed('❌ Cancelled.')], components: [] });
            }

            const doSteal = btnInt.customId.includes('_add_') || btnInt.customId.includes('_both_');
            const doDownload = btnInt.customId.includes('_dl_') || btnInt.customId.includes('_both_');
            await btnInt.deferUpdate();
            collector.stop('acted');

            const selected = selectedIndices.map(i => found[i]);
            const results = [];
            const attachments = [];

            for (const emoji of selected) {
                const ext = emoji.animated ? 'gif' : 'png';
                let url = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
                if (doSteal) {
                    try {
                        const created = await guild.emojis.create({ attachment: url, name: emoji.name });
                        results.push(`✅ ${created} \`:${emoji.name}:\` — added to server`);
                    } catch (e) {
                        if (emoji.tryGif) { url = `https://cdn.discordapp.com/emojis/${emoji.id}.gif`; try { const c = await guild.emojis.create({ attachment: url, name: emoji.name }); results.push(`✅ ${c} \`:${emoji.name}:\` — added`); continue; } catch {} }
                        results.push(`❌ \`:${emoji.name}:\` — ${e.message}`);
                    }
                }
                if (doDownload) {
                    attachments.push(new AttachmentBuilder(url, { name: `${emoji.name}.${ext}` }));
                    results.push(`📥 \`:${emoji.name}:\` — file attached`);
                }
            }

            await reply.edit({
                embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('😎 Emoji Steal — Results').setDescription(results.join('\n')).setFooter({ text: `Requested by ${interaction.user.tag}` }).setTimestamp()],
                components: [], files: attachments,
            });
        });

        collector.on('end', (_, reason) => { if (reason === 'time') reply.edit({ embeds: [errEmbed('⏰ Timed out.')], components: [] }).catch(() => {}); });
        return;
    }

    // ── /stealsticker ─────────────────────────────────────────────────────────
    if (commandName === 'stealsticker') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageGuildExpressions)) {
            return interaction.reply({ embeds: [errEmbed('❌ You need the **Manage Expressions** permission.')], ephemeral: true });
        }

        // Fetch recent messages to find the latest sticker
        const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        const stickerMsg = messages?.find(m => m.stickers.size > 0);
        if (!stickerMsg) {
            return interaction.reply({ embeds: [errEmbed('❌ No sticker found in the last 10 messages.\nSend or find a sticker message first, then use this command.')], ephemeral: true });
        }

        const sticker = stickerMsg.stickers.first();
        const stickerName = interaction.options.getString('name') || sticker.name;

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`sticker_slash_add_${interaction.id}`).setLabel('Steal to Server').setStyle(ButtonStyle.Success).setEmoji('😎'),
            new ButtonBuilder().setCustomId(`sticker_slash_dl_${interaction.id}`).setLabel('Download').setStyle(ButtonStyle.Primary).setEmoji('📥'),
            new ButtonBuilder().setCustomId(`sticker_slash_both_${interaction.id}`).setLabel('Steal + Download').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
            new ButtonBuilder().setCustomId(`sticker_slash_cancel_${interaction.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
        );

        const previewEmbed = new EmbedBuilder().setColor(CYAN).setTitle('🎨 Sticker Stealer')
            .setDescription(`**Sticker:** ${stickerName}\n**Format:** ${sticker.format}`)
            .setThumbnail(sticker.url)
            .setFooter({ text: 'Choose an action below. Expires in 60s.' }).setTimestamp();

        const reply = await interaction.reply({ embeds: [previewEmbed], components: [buttons], fetchReply: true });

        const collector = reply.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, time: 60_000 });
        collector.on('collect', async (btnInt) => {
            if (btnInt.customId.includes('_cancel_')) { collector.stop('cancelled'); return btnInt.update({ embeds: [errEmbed('❌ Cancelled.')], components: [] }); }
            const doSteal = btnInt.customId.includes('_add_') || btnInt.customId.includes('_both_');
            const doDownload = btnInt.customId.includes('_dl_') || btnInt.customId.includes('_both_');
            await btnInt.deferUpdate(); collector.stop('acted');
            const results = []; const files = [];
            if (doSteal) { try { const c = await guild.stickers.create({ file: sticker.url, name: stickerName, tags: '😀' }); results.push(`✅ Added sticker **${c.name}**!`); } catch (e) { results.push(`❌ ${e.message}`); } }
            if (doDownload) { const ext = sticker.format === 'LOTTIE' ? 'json' : 'png'; files.push(new AttachmentBuilder(sticker.url, { name: `${stickerName}.${ext}` })); results.push('📥 File attached!'); }
            await reply.edit({ embeds: [okEmbed(results.join('\n'))], components: [], files });
        });
        collector.on('end', (_, reason) => { if (reason === 'time') reply.edit({ embeds: [errEmbed('⏰ Timed out.')], components: [] }).catch(() => {}); });
        return;
    }

    // ── /changeformat ────────────────────────────────────────────────────────
    if (commandName === 'changeformat') {
        const attachment = interaction.options.getAttachment('file');
        const ext = path.extname(attachment.name).toLowerCase().replace('.', '');
        const imageExts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'tif'];
        const videoExts = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'mpeg', 'mpg', 'm4v'];

        let fileType;
        if (imageExts.includes(ext)) fileType = 'image';
        else if (videoExts.includes(ext)) fileType = 'video';
        else if (attachment.contentType?.startsWith('image/')) fileType = 'image';
        else if (attachment.contentType?.startsWith('video/')) fileType = 'video';
        else return interaction.reply({ embeds: [errEmbed('❌ Unsupported file type. Please upload an image or video.')], ephemeral: true });

        const normalExt = ext === 'jpeg' ? 'jpg' : ext;
        const imageFormats = ['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff'].filter(f => f !== normalExt);
        const videoFormats = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'gif'].filter(f => f !== normalExt);
        const formats = fileType === 'image' ? imageFormats : videoFormats;

        const menu = new StringSelectMenuBuilder()
            .setCustomId('fmt_select')
            .setPlaceholder(`Choose ${fileType} output format…`)
            .addOptions(formats.map(f => ({
                label: f.toUpperCase(),
                value: f,
                description: fileType === 'video' && f === 'gif' ? 'Convert video to animated GIF' : `Convert to .${f}`,
            })));

        const row = new ActionRowBuilder().addComponents(menu);
        const icon = fileType === 'image' ? '🖼️' : '🎬';
        const sizeMB = (attachment.size / 1024 / 1024).toFixed(2);

        const reply = await interaction.reply({
            embeds: [infoEmbed(`${icon} **${fileType.charAt(0).toUpperCase() + fileType.slice(1)} detected:** \`${attachment.name}\` (${sizeMB} MB)\n\nSelect the format you want to convert to:`, '🔄 Format Converter')],
            components: [row],
            fetchReply: true,
        });

        const collector = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 30_000 });

        collector.on('collect', async (menuInt) => {
            const target = menuInt.values[0];
            collector.stop('selected');
            await menuInt.update({ embeds: [infoEmbed(`⏳ Converting \`${attachment.name}\` → \`.${target}\`… please wait.`, '🔄 Converting')], components: [] });

            const tmpDir = os.tmpdir();
            const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const inputPath = path.join(tmpDir, `rr_in_${stamp}.${ext}`);
            const outputPath = path.join(tmpDir, `rr_out_${stamp}.${target}`);
            const outputName = `${path.basename(attachment.name, path.extname(attachment.name))}.${target}`;

            try {
                await downloadFile(attachment.url, inputPath);

                const args = ['-i', inputPath, '-y'];
                if (fileType === 'video' && target === 'gif') args.push('-vf', 'fps=15,scale=480:-1:flags=lanczos', '-loop', '0');
                if (fileType === 'image' && (target === 'jpg' || target === 'jpeg')) args.push('-q:v', '2');
                args.push(outputPath);

                await new Promise((resolve, reject) => {
                    execFile(ffmpegPath, args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, _, stderr) => {
                        if (err) reject(new Error(stderr?.split('\n').pop() || err.message));
                        else resolve();
                    });
                });

                const stats = fs.statSync(outputPath);
                const boostTier = interaction.guild?.premiumTier ?? 0;
                const uploadLimit = boostTier >= 3 ? 100 : boostTier >= 2 ? 50 : 25;
                if (stats.size > uploadLimit * 1024 * 1024) return reply.edit({ embeds: [errEmbed(`❌ Output file is ${(stats.size / 1024 / 1024).toFixed(1)} MB — exceeds this server's ${uploadLimit} MB upload limit.`)] });

                const outMB = (stats.size / 1024 / 1024).toFixed(2);
                const file = new AttachmentBuilder(outputPath, { name: outputName });
                await reply.edit({ embeds: [okEmbed(`✅ **Converted!**\n\`${attachment.name}\` → \`${outputName}\`\nSize: ${sizeMB} MB → ${outMB} MB`)], files: [file] });
            } catch (err) {
                const msg = err.message.includes('ENOENT')
                    ? '❌ **ffmpeg binary not found.** Try reinstalling with `npm install ffmpeg-static`.'
                    : `❌ Conversion failed:\n\`\`\`${err.message.slice(0, 200)}\`\`\``;
                await reply.edit({ embeds: [errEmbed(msg)] }).catch(() => {});
            } finally {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            }
        });

        collector.on('end', (_, reason) => {
            if (reason === 'time') reply.edit({ embeds: [errEmbed('⏰ Timed out — no format selected.')], components: [] }).catch(() => {});
        });
        return;
    }

    // ── /roles (bot owner only — hardcoded ID) ────────────────────────────────
    if (commandName === 'roles') {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({ embeds: [errEmbed('❌ You are not authorized to use this command.')], ephemeral: true });
        }
        if (!guild) return interaction.reply({ embeds: [errEmbed('❌ This command must be used in a server.')], ephemeral: true });

        const targetUser = interaction.options.getUser('user') || interaction.user;
        let targetMember;
        try {
            targetMember = await guild.members.fetch(targetUser.id);
        } catch {
            return interaction.reply({ embeds: [errEmbed('❌ That user is not in this guild.')], ephemeral: true });
        }
        const { embed: rolesEmbed, components, roleCount } = buildRolesPayload(guild, targetMember);
        if (roleCount === 0) return interaction.reply({ embeds: [errEmbed('❌ No assignable roles — check the bot\'s role hierarchy.')], ephemeral: true });

        const reply = await interaction.reply({ embeds: [rolesEmbed], components, ephemeral: true, fetchReply: true });
        const collector = reply.createMessageComponentCollector({
            filter: (i) => i.user.id === OWNER_ID && i.customId.startsWith('roles:'),
            time: 300_000,
        });
        collector.on('collect', applyRoleSync);
        collector.on('end', () => { interaction.editReply({ components: [] }).catch(() => {}); });
        return;
    }
});

// ── Graceful shutdown (Railway sends SIGTERM on redeploys/scale-downs) ────────
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[RazorReaper] ${signal} received — closing notifier and Discord connection.`);
    try { stopNotifier(); } catch { /* best effort */ }
    setTimeout(() => process.exit(0), 5000).unref(); // hard exit fallback
    Promise.resolve(client.destroy()).catch(() => {}).then(() => process.exit(0));
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
    console.error('[RazorReaper] Unhandled rejection:', err?.message || err);
});

client.login(process.env.TOKEN);
