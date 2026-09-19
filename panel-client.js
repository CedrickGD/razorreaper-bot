// ── The bot half of the bot ↔ admin-panel contract ────────────────────────────
// Three endpoints the bot calls (`/api/discord/support-context`, `/api/discord/purchase`,
// `/api/discord/tickets`), all authenticated exactly the way `/api/discord/links` already is —
// Bearer VERIFY_SHARED_SECRET. index.js's verifyApi() IS that POST, so nothing here opens a
// socket: the `post` function is injected, every shape below is a plain object, and the whole
// file unit-tests with a stub (index.js logs into Discord at require time; this does not).
//
// Panel answers are external input. The panel masks the order reference and ships only the last
// four characters of a key, and this side masks again anyway — a trust boundary is the one place
// where doing it twice is cheaper than being wrong once.

/** The client shows `Report ID: FB-XXXXXXXXXXXX` after a support report (panel: makeFeedbackReportId). */
const REPORT_ID_RE = /\bFB-[0-9A-Z]{4,20}\b/i;

/** The panel's readJsonBody override for the ticket upload — bigger bodies come back as 413. */
const MAX_UPLOAD_BYTES = 800 * 1024;

/** The Report ID out of a member's follow-up message, or null. */
function findReportId(text) {
    const m = REPORT_ID_RE.exec(String(text ?? ''));
    return m ? m[0].toUpperCase() : null;
}

/** `…AB12`. Idempotent on something the panel already masked, and null on nothing. */
function maskTail(value, keep = 4) {
    const s = String(value ?? '').trim();
    if (!s) return null;
    return s.length <= keep ? s : `…${s.slice(-keep)}`;
}

/** ISO date, or null — the panel sends ISO strings, members see `2026-04-12`. */
function shortDate(value) {
    if (!value) return null;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

const iso = (value) => {
    const t = new Date(value ?? Date.now()).getTime();
    return new Date(Number.isFinite(t) ? t : Date.now()).toISOString();
};

/**
 * `/api/discord/purchase` → the blocks of the "My purchase" embed. Two blocks per purchase
 * (what it is, what it cost you to prove) so the embed stays inside the brand rules.
 * @param {object[]} purchases
 * @returns {string[]}
 */
function purchaseBlocks(purchases) {
    const list = Array.isArray(purchases) ? purchases : [];
    if (!list.length) return ['No purchase is recorded for this Discord account.'];
    return list.slice(0, 3).flatMap((p) => {
        const plan = p.lifetime ? 'Lifetime' : (p.plan || 'Licence');
        const duration = !p.lifetime && p.durationDays ? ` (${p.durationDays} days)` : '';
        const bought = shortDate(p.purchasedAt) || shortDate(p.activatedAt);
        const expires = p.lifetime ? 'never' : (shortDate(p.expiresAt) || 'unknown');
        const detail = [
            maskTail(p.orderRef) && `Order ${maskTail(p.orderRef)}`,
            p.keyLast4 && `key ••••${String(p.keyLast4).slice(-4)}`,
            Number.isFinite(p.seatsMax) && `seats ${p.seatsUsed ?? 0}/${p.seatsMax}`,
            p.source && String(p.source),
        ].filter(Boolean).join(' · ');
        return [
            `**${plan}${duration}** · ${p.status || 'unknown'}`
                + `\n${bought ? `Bought ${bought} · ` : ''}expires ${expires}`,
            detail,
        ];
    }).filter(Boolean);
}

/**
 * The exact `/api/discord/tickets` body. Built in one place so the panel side has one shape to
 * diff against, and so the 413 retry can swap the html without rebuilding anything else.
 */
function ticketUploadPayload({
    channelId, ticketNo, channelName, discordId, discordTag, category, status,
    openedAt, closedAt, closedBy, aiReplies, messageCount, provider, transcriptHtml,
}) {
    return {
        channel_id: String(channelId),
        ticket_no: Number(ticketNo) || 0,
        channel_name: String(channelName || ''),
        discord_id: discordId ? String(discordId) : null,
        discord_tag: discordTag ? String(discordTag) : null,
        category: String(category || 'other'),
        status: String(status),
        opened_at: iso(openedAt),
        closed_at: iso(closedAt),
        closed_by: closedBy ? String(closedBy) : null,
        ai_replies: Number(aiReplies) || 0,
        message_count: Number(messageCount) || 0,
        provider: provider ? String(provider) : null,
        transcript_html: String(transcriptHtml || ''),
    };
}

/**
 * Upload once; on a 413 retry ONCE with a shorter transcript. The html is the only field that can
 * be the problem, so `shrink()` re-renders it from fewer (the oldest dropped) messages.
 * @param {(path: string, body: object) => Promise<{status: number, data: any}>} post
 * @param {() => string|null} [shrink]
 */
async function uploadTicket(post, payload, shrink) {
    let res = await post('/api/discord/tickets', payload);
    if (res?.status === 413 && typeof shrink === 'function') {
        const smaller = shrink();
        if (smaller) res = await post('/api/discord/tickets', { ...payload, transcript_html: smaller });
    }
    return res;
}

module.exports = {
    REPORT_ID_RE, MAX_UPLOAD_BYTES,
    findReportId, maskTail, shortDate, purchaseBlocks, ticketUploadPayload, uploadTicket,
};
