// ── Licence reconcile: the pure part ──────────────────────────────────────────
// Turns (what the admin panel says about every linked Discord account, what roles the guild's
// members actually hold) into the list of role add/remove operations. No discord.js, no I/O —
// so the safety rules below can be unit-tested without logging the bot in (see test/).

/**
 * The two tier roles are exclusive (owner, 2026-09-24): RR-Customer ⇔ an active link that is NOT
 * lifetime, Lifetime ⇔ an active lifetime link — never both. On Discord the Lifetime role opens
 * everything RR-Customer does, so a lifetime buyer loses nothing by not holding it. While the
 * Lifetime role cannot be resolved, lifetime links keep RR-Customer instead, so nobody who paid
 * is left without access.
 *
 * @param {any} data     parsed JSON of POST /api/discord/links:
 *                       { ok: true, links: [{ discord_id, active, lifetime }] }
 *                       ({} when the call failed or the panel answered non-ok)
 * @param {{id: string, bot: boolean, roles: string[]}[]} members  snapshot of the guild
 * @param {{verified: string, lifetime: string|null}} roles        role ids (lifetime may be null)
 * @returns {{ok: true, changes: {id: string, add: string[], remove: string[]}[]}
 *          |{ok: false, reason: string}}
 */
function planRoleChanges(data, members, roles) {
    // Safety 1+2: anything other than a well-formed answer means we know nothing — and knowing
    // nothing must never turn into stripping everyone's role.
    if (!data || data.ok !== true) return { ok: false, reason: 'panel did not answer ok:true' };
    if (!Array.isArray(data.links)) return { ok: false, reason: 'panel answer carried no links array' };

    const humans = members.filter(m => !m.bot);

    // Safety 3: an empty list while members still hold a tier role is far more likely a broken
    // query than every licence in the server lapsing inside the same sweep interval. Either role
    // counts: with exclusive tiers a server of lifetime buyers holds no RR-Customer at all.
    if (data.links.length === 0) {
        const tier = [roles.verified, roles.lifetime].filter(Boolean);
        const holders = humans.filter(m => tier.some(r => m.roles.includes(r))).length;
        if (holders > 0) {
            return { ok: false, reason: `empty links list while ${holders} member(s) hold a customer role` };
        }
    }

    // discord_id -> lifetime?, active links only. A licence can carry a second Discord account
    // (owner rebind/add in the panel); if any active link of an account is lifetime, it is.
    const active = new Map();
    for (const link of data.links) {
        if (!link || !link.active) continue;
        const id = String(link.discord_id || '');
        if (!id) continue;
        active.set(id, Boolean(link.lifetime) || active.get(id) === true);
    }

    const changes = [];
    for (const m of humans) {
        const add = [];
        const remove = [];
        const want = (roleId, wanted) => {
            if (!roleId) return; // role not configured/resolvable — leave it alone entirely
            const has = m.roles.includes(roleId);
            if (wanted && !has) add.push(roleId);
            else if (!wanted && has) remove.push(roleId);
        };
        const lifetime = active.get(m.id) === true;
        want(roles.verified, active.has(m.id) && !(lifetime && roles.lifetime));
        want(roles.lifetime, lifetime);
        if (add.length || remove.length) changes.push({ id: m.id, add, remove });
    }
    return { ok: true, changes };
}

// ── #verify chat: the pure part ───────────────────────────────────────────────
// #verify is for `/verify`, not for talking; index.js deletes what members type there and this
// decides how. A pasted key goes at once (it is a secret), a question about verifying gets a
// short hint first, anything else just goes.
// Keys are shaped XXXX-XXXX-XXXX-…: the panel issues 4-4-4-12 (a UUID minus its first group), the
// docs say 4-4-4-4, so the last group is left open. Without dashes: a run of 16+ letters and digits
// with at least one of each — all digits is a Discord id or mention, all letters is a long word.
const KEY_RE = /(?<![a-z0-9])[a-z0-9]{4}(?:-[a-z0-9]{4}){3}|(?<![a-z0-9])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{16,}(?![a-z0-9])/i;
const RELATED_RE = /\b(?:verif|licen[cs]|lizenz|activat|aktivier)\w*|\b(?:keys?|roles?|rollen?|codes?|premium|lifetime|link(?:s|ed)?|help)\b/i;

/** @returns {'key'|'related'|'other'} */
function classifyVerifyMessage(text) {
    const s = String(text || '');
    if (KEY_RE.test(s)) return 'key';
    return RELATED_RE.test(s) ? 'related' : 'other';
}

module.exports = { planRoleChanges, classifyVerifyMessage };
