// ── Ticket state: the pure part ───────────────────────────────────────────────
// Everything the AI ticket flow has to remember lives in the ticket channel's TOPIC, because this
// repo has no database and every timer/Map in index.js is lost on restart (see the warns object).
// A topic survives restarts, redeploys and the container being rebuilt, and Discord hands it to us
// for free on every channel object — so there is nothing to load, migrate or back up.
//
// index.js logs into Discord at require time, so all of this lives here instead: unit-testable
// without a gateway connection, the same split role-plan.js already uses.

const TOPIC_TAG = 'rr-ticket';
const OPEN_RE = /^ticket-(\d+)$/i;
const ANY_RE = /^(?:ticket|closed)-(\d+)$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Serialise ticket state into a channel topic. Deliberately flat `k=v` pairs: a human reading the
 * channel settings can see (and correct) it, and there is no JSON to break on a manual edit.
 *
 * `from` and `closed` are epoch SECONDS and are written only when they exist, so an ordinary open
 * ticket's topic is exactly what it always was. `from` is stamped when the AI is switched back on
 * and marks where the reply cap starts counting again; `closed` is stamped by the close path in
 * the same channel edit as the rename, and is what lets the auto-delete sweep survive a restart.
 * @param {{opener: string, cat: string, ai?: boolean, replies?: number, from?: number, closed?: number}} state
 */
function buildTopic({ opener, cat, ai = true, replies = 0, from = 0, closed = 0 }) {
    return `${TOPIC_TAG} opener=${opener} cat=${cat} ai=${ai ? 'on' : 'off'} replies=${replies}`
        + (from ? ` from=${from}` : '')
        + (closed ? ` closed=${closed}` : '');
}

/**
 * Parse a channel topic back into ticket state. Anything that is not one of our topics (a
 * hand-made ticket channel, a Ticket Tool leftover, an empty topic) returns null — the caller
 * then treats the channel as "not AI-managed", which is the safe direction.
 * @returns {{opener: string, cat: string, ai: boolean, replies: number, from: number, closed: number}|null}
 */
function parseTopic(topic) {
    // The tag must be a whole word: "rr-ticketish opener=1" is somebody else's topic, not ours.
    if (typeof topic !== 'string' || !new RegExp(`^${TOPIC_TAG}(?:\\s|$)`).test(topic)) return null;
    const get = (k) => new RegExp(`\\b${k}=([^\\s]+)`).exec(topic)?.[1];
    const num = (k) => { const n = Number(get(k)); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const opener = get('opener');
    if (!opener || !/^\d+$/.test(opener)) return null;
    return {
        opener,
        cat: get('cat') || 'other',
        ai: get('ai') !== 'off',
        replies: num('replies'),
        from: num('from'),
        closed: num('closed'),
    };
}

/**
 * Next free ticket number: one past the highest `ticket-N` / `closed-N` in the guild, so numbers
 * never repeat even after a ticket is closed (closed channels keep their number) — the same
 * ticket-N/closed-N convention the existing /close + transcript handlers key on.
 * @param {string[]} names  every channel name in the guild
 */
function nextTicketNumber(names) {
    let highest = 0;
    for (const name of names || []) {
        const n = Number(ANY_RE.exec(name || '')?.[1]);
        if (Number.isFinite(n) && n > highest) highest = n;
    }
    return highest + 1;
}

/** `ticket-0042` — 4-digit padding to match what Ticket Tool left behind in this server. */
function ticketChannelName(number) {
    return `ticket-${String(number).padStart(4, '0')}`;
}

/**
 * Per-member limits, answered entirely from channels that already exist — no counter to persist.
 * Closed tickets keep their channel (renamed to closed-N), so the 24h history is right there.
 * @param {{name: string, topic: string|null, createdTimestamp: number}[]} channels
 * @param {string} userId
 * @param {number} now
 * @param {{maxOpen?: number, maxPerDay?: number}} limits
 * @returns {{ok: true}|{ok: false, reason: 'open'|'daily', open?: string, count?: number}}
 */
function checkLimits(channels, userId, now = Date.now(), limits = {}) {
    const maxOpen = limits.maxOpen ?? 1;
    const maxPerDay = limits.maxPerDay ?? 3;

    let open = null;
    let openCount = 0;
    let recent = 0;
    for (const ch of channels || []) {
        if (!ANY_RE.test(ch.name || '')) continue;
        if (parseTopic(ch.topic)?.opener !== userId) continue;
        if (OPEN_RE.test(ch.name)) {
            openCount++;
            if (!open) open = ch.name;
        }
        if (now - (ch.createdTimestamp || 0) < DAY_MS) recent++;
    }
    if (openCount >= maxOpen) return { ok: false, reason: 'open', open };
    if (recent >= maxPerDay) return { ok: false, reason: 'daily', count: recent };
    return { ok: true };
}

// ── Message cooldown ──────────────────────────────────────────────────────────
/**
 * Discord's own per-channel slowmode does the cooldown the owner asked for: it is enforced
 * server-side, staff bypass it natively (Manage Messages), and it costs the bot nothing to run.
 * The only thing worth writing down is the clamp, because a bad env var otherwise makes
 * channels.create() throw and no ticket gets opened at all.
 * @param {unknown} value  env string
 */
const SLOWMODE_MAX = 21600;  // Discord's ceiling for rateLimitPerUser (6 hours)
function slowmodeSeconds(value, fallback = 45) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(Math.floor(n), SLOWMODE_MAX);
}

// ── Auto-delete ───────────────────────────────────────────────────────────────
/**
 * Which closed ticket channels the sweep may delete. Three guards, all of them load-bearing:
 * the name must be a CLOSED ticket, the topic must be one of ours, and it must carry a `closed=`
 * stamp — so a hand-made "closed-shop" channel, an open ticket and every ticket closed before
 * this feature existed are all invisible to the sweep.
 * @param {{id?: string, name: string, topic: string|null}[]} channels
 * @param {{now?: number, hours?: number}} opts  hours = 0 means never delete
 */
function deletableTickets(channels, { now = Date.now(), hours = 24 } = {}) {
    if (!(hours > 0)) return [];
    const cutoff = now - hours * 60 * 60 * 1000;
    return (channels || []).filter((ch) => {
        if (!/^closed-\d+$/i.test(ch?.name || '')) return false;
        const state = parseTopic(ch.topic);
        return Boolean(state?.closed) && state.closed * 1000 <= cutoff;
    });
}

// ── "Waiting for the support report" ──────────────────────────────────────────
/**
 * While a ticket waits for the member's support report the AI is WAITING, not off: it answers
 * nothing else in that channel, and the wait ends on the button, on Skip, on a valid Report ID,
 * or by itself after `ttlMs`. In memory on purpose — a 30-minute window is not worth a channel
 * edit, and a restart simply means the AI starts answering again, which is the safe direction.
 */
function makeWaiting(ttlMs = 30 * 60 * 1000, now = () => Date.now()) {
    const waiting = new Map();
    return {
        /** @returns {number} the moment the report was asked for, used as the `since` filter. */
        start(id, since = now()) { waiting.set(id, { since, until: now() + ttlMs }); return since; },
        /** @returns {{since: number, until: number}|null} — expired waits clean themselves up. */
        active(id) {
            const w = waiting.get(id);
            if (!w) return null;
            if (now() >= w.until) { waiting.delete(id); return null; }
            return w;
        },
        stop(id) { return waiting.delete(id); },
        get size() { return waiting.size; },
    };
}

module.exports = {
    buildTopic, parseTopic, nextTicketNumber, ticketChannelName, checkLimits,
    slowmodeSeconds, deletableTickets, makeWaiting,
    TOPIC_TAG, SLOWMODE_MAX,
};
