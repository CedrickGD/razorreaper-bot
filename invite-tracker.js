// ── Invite tracker: the pure part ─────────────────────────────────────────────
// Who invited whom, like the invite-tracker bots do it: Discord never says which invite a member
// used, so the bot compares every invite's use count right before and right after the join. No
// discord.js here — index.js feeds in plain snapshots and the store, test/ covers the rules.
//
// Store (/data/invites.json): { v: 1, startedAt, earlier: {inviterId: n},
//                               joins: { memberId: { inviter, code, via, at, left, fake } } }
// A member is exactly one of regular / left / fake; `earlier` is the invite uses from before
// tracking started, snapshotted once, since nobody can tell who of those has left since.

const DAY_MS = 86_400_000;
const UNKNOWN = Object.freeze({ via: 'unknown', code: null, inviter: null });

/**
 * Which invite a join used. `before`/`after` are `code -> { uses, inviterId }`; a code missing
 * from `before` had 0 uses (created since), a code missing from `after` was deleted and cannot
 * be the one. Exactly one thing went up or it is 'unknown' — two joins in the same second must
 * not both be credited to a guess.
 */
function diffInvites(before, after, vanityBefore, vanityAfter) {
    if (!before || !after) return UNKNOWN;
    const hits = Object.entries(after).filter(([code, inv]) => (inv.uses || 0) > (before[code]?.uses || 0));
    const vanity = vanityBefore != null && vanityAfter != null && vanityAfter > vanityBefore;
    if (hits.length === 1 && !vanity) return { via: 'invite', code: hits[0][0], inviter: hits[0][1].inviterId || null };
    if (!hits.length && vanity) return { via: 'vanity', code: null, inviter: null };
    return UNKNOWN;
}

/** A fresh store: every invite's current uses become its inviter's `earlier`. */
function newStore(codes = {}, now = Date.now()) {
    const earlier = {};
    for (const { uses, inviterId } of Object.values(codes)) {
        if (inviterId && uses > 0) earlier[inviterId] = (earlier[inviterId] || 0) + uses;
    }
    return { v: 1, startedAt: new Date(now).toISOString(), earlier, joins: {} };
}

/** The stored tracker, or null when the text is not one (corrupt file → start fresh). */
function parseStore(text) {
    try {
        const s = JSON.parse(text);
        const obj = x => x && typeof x === 'object' && !Array.isArray(x);
        if (obj(s) && s.v === 1 && obj(s.earlier) && obj(s.joins)) return s;
    } catch { /* fall through */ }
    return null;
}

function isFake(accountCreatedAt, joinedAt, days) {
    return joinedAt - accountCreatedAt < days * DAY_MS;
}

/** A (re)join replaces the member's record: counted once, for whoever invited them this time. */
function recordJoin(store, memberId, { via, code, inviter }, fake, at = Date.now()) {
    return (store.joins[memberId] = { inviter, code, via, at: new Date(at).toISOString(), left: false, fake: !!fake });
}

/** true when something changed (a member the tracker never saw leaves silently). */
function recordLeave(store, memberId) {
    const j = store.joins[memberId];
    if (!j || j.left) return false;
    j.left = true;
    return true;
}

function countsFor(store, inviterId) {
    const c = { regular: 0, earlier: store.earlier[inviterId] || 0, left: 0, fake: 0, total: 0 };
    for (const j of Object.values(store.joins)) {
        if (j.inviter !== inviterId) continue;
        if (j.left) c.left++;
        else if (j.fake) c.fake++;
        else c.regular++;
    }
    c.total = c.regular + c.earlier;
    return c;
}

/**
 * Everyone with a total above 0, best first (ties: more regular, then id, so the order is
 * stable). `caller` is the caller's own row with its rank, or null when they have none.
 */
function leaderboard(store, n, callerId) {
    const ids = new Set([...Object.keys(store.earlier), ...Object.values(store.joins).map(j => j.inviter).filter(Boolean)]);
    const rows = [...ids].map(id => ({ inviterId: id, ...countsFor(store, id) }))
        .filter(r => r.total > 0)
        .sort((a, b) => b.total - a.total || b.regular - a.regular || (a.inviterId < b.inviterId ? -1 : 1))
        .map((r, i) => ({ ...r, rank: i + 1 }));
    return { top: rows.slice(0, n), caller: rows.find(r => r.inviterId === callerId) || null };
}

module.exports = { diffInvites, newStore, parseStore, isFake, recordJoin, recordLeave, countsFor, leaderboard };
