// ── Ticket state: the pure part ───────────────────────────────────────────────
// A ticket channel's TOPIC holds the facts that never change — who opened it, which category, and
// (once) that it was closed. It is written exactly twice in a ticket's life, by channels.create
// and by the close, because Discord allows a channel TWO edits per 10 minutes: a topic written on
// a hot path (the AI stepping aside, a reply counter) sits in discord.js's queue for minutes and
// drags everything awaiting it along, which is what made a close look half-done.
//
// Everything that DOES change while a ticket is open lives in index.js's Maps and is rebuilt after
// a restart by rebuildTicketState() below, out of the bot's own control messages — the buttons it
// posted are the record of what it asked for and whether that was answered.
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
 * ticket's topic is exactly what it always was. `from` is no longer written by anything — it is
 * still parsed so topics from before the in-memory rebuild keep reading; `closed` is stamped by
 * the close path in the same channel edit as the rename, and is what lets the auto-delete sweep
 * survive a restart.
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

// ── What a restart lost ───────────────────────────────────────────────────────
/**
 * The custom ids the rebuild below reads. index.js builds those rows, and a button is only ever
 * ENABLED while the thing it asks for is still open: pressing it (or the member answering another
 * way) disables it, so the row itself says whether the bot is still waiting for an answer.
 */
const TICKET_BUTTONS = {
    aiOn: 'ticket:ai-on',           // rides on every "handed to a human" message
    reportSent: 'ticket:report-sent',  // rides on the "Send your report" message
    del: 'ticket:delete',           // rides on the one "Ticket closed" message, staff only
};

/**
 * Rebuild what index.js's Maps knew about a ticket from the ticket's own recent history. The bot
 * restarts on every deploy — one happened in the middle of the owner's first real ticket — and
 * nothing here may cost a channel edit, so the control messages ARE the record:
 *
 *   • a live "Re-enable AI" button  ⇒ the AI stepped aside and nobody brought it back
 *   • a disabled one               ⇒ it was brought back, and the reply cap started over there
 *   • a live "I've sent it" button ⇒ the ticket is still waiting for the support report
 *   • a "Ticket closed" message    ⇒ closed at that message's timestamp, whatever the name says
 *   • the bot's PLAIN messages are its answers — every notice it posts is an embed
 *
 * `sawHandoff` separates "on because a hand-off said so" from "on because nothing said otherwise":
 * the fetch returns the NEWEST messages, so a hand-off inside the window is the newest one in the
 * channel and decides the state on its own — only the no-evidence case needs the caller's caution.
 *
 * @param {{bot: boolean, text: boolean, buttons?: {id: string, disabled?: boolean}[], ts: number}[]} messages
 *        the channel's recent messages, OLDEST FIRST.
 * @returns {{ai: boolean, replies: number, reportAsked: boolean, waitingSince: number, closedAt: number, sawHandoff: boolean}}
 */
function rebuildTicketState(messages = []) {
    const out = { ai: true, replies: 0, reportAsked: false, waitingSince: 0, closedAt: 0, sawHandoff: false };
    for (const m of messages || []) {
        if (!m || !m.bot) continue;
        const button = (id) => (m.buttons || []).find(b => b && b.id === id);
        if (m.text) {
            // An answer. It also ends a report wait: the second pass is what the ticket waited for.
            out.replies++;
            out.waitingSince = 0;
            continue;
        }
        const handoff = button(TICKET_BUTTONS.aiOn);
        if (handoff) {
            out.sawHandoff = true;
            out.ai = Boolean(handoff.disabled);
            // A re-enable resets the cap — the eight answers already standing there are the round
            // that ended, not this one.
            if (out.ai) out.replies = 0;
        }
        const report = button(TICKET_BUTTONS.reportSent);
        if (report) {
            out.reportAsked = true;
            out.waitingSince = report.disabled ? 0 : m.ts;
        }
        if (button(TICKET_BUTTONS.del)) {
            out.closedAt = m.ts;
            out.ai = false;
        }
    }
    return out;
}

/**
 * Next free ticket number: one past the highest `ticket-N` / `closed-N` in the guild — the same
 * ticket-N/closed-N convention the existing /close + transcript handlers key on — and never below
 * `floor`. The channel list used to be the whole history, because a closed ticket kept its channel
 * and therefore its number. Auto-delete removes those channels a day after the close, so on its
 * own the list would hand out 1 again after a quiet weekend and #ticket-log would end up with two
 * rows called "Ticket 1". `floor` is the highest number a record that outlives the channels still
 * knows about (index.js reads it off #ticket-log).
 * @param {string[]} names  every channel name in the guild
 * @param {number} floor    highest number already issued, 0 when nothing else knows
 */
function nextTicketNumber(names, floor = 0) {
    let highest = Number.isFinite(floor) && floor > 0 ? Math.floor(floor) : 0;
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
 *
 * The open limit is per CATEGORY when the caller names one: a member with a License ticket open
 * can still report a bug, they just cannot open a second License ticket. Topics from before
 * categories existed read as `other`, which is a category like any other here.
 * @param {{name: string, topic: string|null, createdTimestamp: number, closed?: boolean}[]} channels
 *        `closed` is the caller's own bookkeeping: the close rename is no longer awaited and can
 *        sit in Discord's queue for minutes, so the NAME alone would keep a closed ticket "open".
 * @param {string} userId
 * @param {number} now
 * @param {{maxOpen?: number, maxPerDay?: number, cat?: string}} limits
 *        no `cat` = every open ticket of this member counts, whatever it is about.
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
        const topic = parseTopic(ch.topic);
        if (topic?.opener !== userId) continue;
        if (OPEN_RE.test(ch.name) && !ch.closed && (limits.cat === undefined || topic.cat === limits.cat)) {
            openCount++;
            if (!open) open = ch.name;
        }
        if (now - (ch.createdTimestamp || 0) < DAY_MS) recent++;
    }
    if (openCount >= maxOpen) return { ok: false, reason: 'open', open };
    if (recent >= maxPerDay) return { ok: false, reason: 'daily', count: recent };
    return { ok: true };
}

// ── "@bot close" ──────────────────────────────────────────────────────────────
/** What you can do to a ticket. The slash commands, the buttons and @bot all use these words. */
const TICKET_COMMANDS = ['close', 'transcript', 'delete', 'enableai', 'disableai'];

/**
 * A ticket command typed at the bot instead of picked from the slash menu. The message must START
 * with the mention: "ask @RazorReaper to close this" is a sentence about the bot, not an order to
 * it, and a member quoting the bot mid-sentence must never trigger anything.
 * Discord auto-creates a managed ROLE named after the bot, and anyone allowed to mention roles —
 * staff, i.e. exactly the people who type "@bot close" — gets it offered next to the user in the
 * autocomplete. Picking it inserts `<@&roleId>`, so that id counts as us too.
 * @param {string} content  the raw message text
 * @param {string} botId    this bot's user id — another bot's mention is not our command
 * @param {string|null} botRoleId  the bot's own managed role, when the caller can see one
 * @returns {{action: string, reason: string}|null}  null when the message is not addressed to us;
 *          `action: ''` when it is but the word after the mention is not one of ours (the caller
 *          then lists them), otherwise the command and everything after it as the reason.
 */
function parseBotCommand(content, botId, botRoleId = null) {
    const m = /^<@[!&]?(\d+)>([\s\S]*)$/.exec(String(content ?? '').trim());
    // String(null) is never all digits, so a missing id can never be the one that matched.
    if (!m || !botId || (m[1] !== String(botId) && m[1] !== String(botRoleId))) return null;
    const [word = '', ...rest] = m[2].trim().split(/\s+/);
    const action = word.replace(/^\//, '').toLowerCase();
    return TICKET_COMMANDS.includes(action) ? { action, reason: rest.join(' ') } : { action: '', reason: '' };
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
 * `closedAt(id)` is the bot's own bookkeeping for this process, consulted when the topic carries
 * no stamp — the close writes the stamp and the rename in ONE edit that is no longer awaited, so
 * a sweep running before that edit lands would otherwise forget the ticket it just closed.
 * @param {{id?: string, name: string, topic: string|null}[]} channels
 * @param {{now?: number, hours?: number, closedAt?: (id: string) => number|undefined}} opts
 *        hours = 0 means never delete
 */
function deletableTickets(channels, { now = Date.now(), hours = 24, closedAt } = {}) {
    if (!(hours > 0)) return [];
    const cutoff = now - hours * 60 * 60 * 1000;
    return (channels || []).filter((ch) => {
        if (!/^closed-\d+$/i.test(ch?.name || '')) return false;
        const stamped = parseTopic(ch.topic)?.closed;
        const closed = stamped ? stamped * 1000 : (closedAt ? closedAt(ch.id) : 0);
        return Boolean(closed) && closed <= cutoff;
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
        // The window is measured from `since`, so a wait rebuilt out of the ticket's history after
        // a restart expires when it was always going to, not 30 minutes after the restart.
        start(id, since = now()) { waiting.set(id, { since, until: since + ttlMs }); return since; },
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
    buildTopic, parseTopic, rebuildTicketState, nextTicketNumber, ticketChannelName, checkLimits,
    slowmodeSeconds, deletableTickets, makeWaiting, parseBotCommand,
    TOPIC_TAG, SLOWMODE_MAX, TICKET_BUTTONS, TICKET_COMMANDS,
};
