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
 * @param {{opener: string, cat: string, ai: boolean, replies: number}} state
 */
function buildTopic({ opener, cat, ai = true, replies = 0 }) {
    return `${TOPIC_TAG} opener=${opener} cat=${cat} ai=${ai ? 'on' : 'off'} replies=${replies}`;
}

/**
 * Parse a channel topic back into ticket state. Anything that is not one of our topics (a
 * hand-made ticket channel, a Ticket Tool leftover, an empty topic) returns null — the caller
 * then treats the channel as "not AI-managed", which is the safe direction.
 * @returns {{opener: string, cat: string, ai: boolean, replies: number}|null}
 */
function parseTopic(topic) {
    // The tag must be a whole word: "rr-ticketish opener=1" is somebody else's topic, not ours.
    if (typeof topic !== 'string' || !new RegExp(`^${TOPIC_TAG}(?:\\s|$)`).test(topic)) return null;
    const get = (k) => new RegExp(`\\b${k}=([^\\s]+)`).exec(topic)?.[1];
    const opener = get('opener');
    if (!opener || !/^\d+$/.test(opener)) return null;
    const replies = Number(get('replies'));
    return {
        opener,
        cat: get('cat') || 'other',
        ai: get('ai') !== 'off',
        replies: Number.isFinite(replies) && replies >= 0 ? replies : 0,
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

module.exports = { buildTopic, parseTopic, nextTicketNumber, ticketChannelName, checkLimits, TOPIC_TAG };
