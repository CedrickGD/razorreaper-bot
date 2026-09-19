// ── Licence reconcile: the pure part ──────────────────────────────────────────
// Turns (what the admin panel says about every linked Discord account, what roles the guild's
// members actually hold) into the list of role add/remove operations. No discord.js, no I/O —
// so the safety rules below can be unit-tested without logging the bot in (see test/).

/**
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

    // Safety 3: an empty list while members still hold the customer role is far more likely a
    // broken query than every licence in the server lapsing inside the same sweep interval.
    if (data.links.length === 0) {
        const holders = humans.filter(m => m.roles.includes(roles.verified)).length;
        if (holders > 0) {
            return { ok: false, reason: `empty links list while ${holders} member(s) hold the customer role` };
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
        want(roles.verified, active.has(m.id));
        want(roles.lifetime, active.get(m.id) === true);
        if (add.length || remove.length) changes.push({ id: m.id, add, remove });
    }
    return { ok: true, changes };
}

module.exports = { planRoleChanges };
