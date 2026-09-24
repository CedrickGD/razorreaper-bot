// ── Giveaways and the invite contest: the pure part ──────────────────────────
// Owner, 2026-09-24: "reaction = join the giveaway, after a set time a winner is rolled", and an
// invite contest where the most invites over a set period win. No discord.js here — index.js
// posts, fetches the 🎉 reactions and keeps the file; test/ covers the rules.
//
// Store (/data/giveaways.json), times in ms:
//   { v: 1, giveaways: [{ messageId, channelId, prize, winners, endsAt, hostId, state, winnerIds }],
//     contest: { messageId, channelId, prize, winners, startsAt, endsAt, hostId, state, winnerIds,
//                lastStandingsAt } | null,
//     pastContests: [contest…] }
// state: 'active' | 'ended' | 'cancelled'.
const crypto = require('crypto');

const MINUTE = 60_000;
const UNIT = { m: MINUTE, h: 60 * MINUTE, d: 1440 * MINUTE, w: 10080 * MINUTE };
const MAX_MS = 60 * UNIT.d;
const STANDINGS_EVERY_MS = 10 * MINUTE;

/** `30m`, `12h`, `2d`, `1w`, `1d12h` → ms; anything else, under a minute or over 60 days → null. */
function parseDuration(text) {
    const s = String(text ?? '').toLowerCase().replace(/\s+/g, '');
    if (!/^(\d+[mhdw])+$/.test(s)) return null;
    let ms = 0;
    for (const [, n, u] of s.matchAll(/(\d+)([mhdw])/g)) ms += Number(n) * UNIT[u];
    return ms >= MINUTE && ms <= MAX_MS ? ms : null;
}

function draw(pool, n, randomInt) {
    const left = [...pool], out = [];
    while (out.length < n && left.length) out.push(left.splice(randomInt(left.length), 1)[0]);
    return out;
}

/**
 * `n` distinct winners, uniformly at random; fewer entrants than `n` → all of them. `exclude`
 * (a reroll's previous winners) is only drawn from once everyone else has won.
 */
function pickWinners(entrants, n, randomInt = crypto.randomInt, exclude = []) {
    const skip = new Set(exclude);
    const pool = [...new Set(entrants)];
    const fresh = draw(pool.filter(id => !skip.has(id)), n, randomInt);
    return fresh.concat(draw(pool.filter(id => skip.has(id)), n - fresh.length, randomInt));
}

/**
 * The contest ranking from the invite tracker's joins: a join counts for its inviter when it came
 * through an invite inside [startsAt, endsAt], is not fake and the member has not left. Ties:
 * whoever reached their count first (earliest last counted join), then id.
 * @returns {{inviterId: string, count: number, lastAt: number, rank: number}[]}
 */
function contestStandings(inviteStore, contest, now = Date.now()) {
    const to = Math.min(contest.endsAt, now);
    const rows = new Map();
    for (const j of Object.values(inviteStore?.joins || {})) {
        const at = Date.parse(j.at);
        if (j.via !== 'invite' || !j.inviter || j.fake || j.left || !(at >= contest.startsAt && at <= to)) continue;
        const r = rows.get(j.inviter) || { inviterId: j.inviter, count: 0, lastAt: 0 };
        r.count++;
        r.lastAt = Math.max(r.lastAt, at);
        rows.set(j.inviter, r);
    }
    return [...rows.values()]
        .sort((a, b) => b.count - a.count || a.lastAt - b.lastAt || (a.inviterId < b.inviterId ? -1 : 1))
        .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** What the ticker has to do now: giveaways to draw, the contest to finish, standings to refresh. */
function dueItems(store, now) {
    const c = store.contest?.state === 'active' ? store.contest : null;
    return {
        giveaways: store.giveaways.filter(g => g.state === 'active' && g.endsAt <= now),
        contest: c && c.endsAt <= now ? c : null,
        standings: c && c.endsAt > now && now - (c.lastStandingsAt || 0) >= STANDINGS_EVERY_MS ? c : null,
    };
}

const newStore = () => ({ v: 1, giveaways: [], contest: null, pastContests: [] });

/** The stored giveaways, or null when the text is not a store (corrupt file → start empty). */
function parseStore(text) {
    try {
        const s = JSON.parse(text);
        if (s?.v === 1 && Array.isArray(s.giveaways) && Array.isArray(s.pastContests)
            && (s.contest === null || (typeof s.contest === 'object' && !Array.isArray(s.contest)))) return s;
    } catch { /* fall through */ }
    return null;
}

module.exports = { parseDuration, pickWinners, contestStandings, dueItems, newStore, parseStore, STANDINGS_EVERY_MS };
