// ── RazorReaper embed design ──────────────────────────────────────────────────
// One helper for every support / ticket / verify message, because "weniger ist mehr" only holds
// if a single place decides what an embed may look like. The owner's rules are ENFORCED here
// rather than trusted to whoever writes the next call site:
//
//   • the brand colour is the client's own accent — `--accent-purple` in
//     RazorReaper/wwwroot/css/shared/theme.css, the one colour the whole app is tinted with
//   • a title is at most five words
//   • a block is at most two short lines, and blocks are separated by exactly ONE blank line
//   • the RR logo rides along as the thumbnail: the guild icon, else the bot's own avatar —
//     the same resolution the #verify and #support panels already did by hand, now in one place
//
// discord.js is required here, but nothing in this file touches the gateway, so it unit-tests
// without a login — unlike index.js, which logs in at require time.

const { EmbedBuilder } = require('discord.js');

const BRAND = 0x8b5cf6;       // --accent-purple
const BRAND_BAD = 0xef4444;   // --accent-red   — a refusal, a rejection, a close
const BRAND_GOOD = 0x22c55e;  // --accent-green — something worked
const BRAND_FOOTER = 'RazorReaper • razorreaper.app';

const MAX_TITLE_WORDS = 5;
const MAX_BLOCK_LINES = 2;
const MAX_DESCRIPTION = 4096;  // Discord's own ceiling

/** Five words, hard. A long title is a wall of text with a bigger font. */
function brandTitle(title) {
    return String(title ?? '').trim().split(/\s+/).filter(Boolean)
        .slice(0, MAX_TITLE_WORDS).join(' ').slice(0, 256);
}

/**
 * Blocks → one description. Each block keeps at most two non-empty lines, blocks are joined by a
 * single blank line. Falsy blocks drop out, so a call site can write `cond && 'line'` inline.
 * @param {(string|false|null|undefined)[]|string} blocks
 */
function brandBody(blocks) {
    return (Array.isArray(blocks) ? blocks : [blocks])
        .filter(Boolean)
        .map(block => String(block).split('\n').map(l => l.trim()).filter(Boolean)
            .slice(0, MAX_BLOCK_LINES).join('\n'))
        .filter(Boolean)
        .join('\n\n')
        .slice(0, MAX_DESCRIPTION);
}

/** The RR logo: the server icon if there is one, otherwise the bot's avatar. */
function brandThumb(guild, botUser) {
    return guild?.iconURL?.({ size: 256 }) || botUser?.displayAvatarURL?.({ size: 256 }) || null;
}

/**
 * The one embed builder for the support surface.
 * @param {object} opts
 * @param {string} [opts.title]      at most five words
 * @param {(string|false|null)[]|string} [opts.blocks]  at most two lines each
 * @param {{name: string, value: string, inline?: boolean}[]} [opts.fields]  verbatim (the ticket
 *        form is fields, not prose — capping those lines would eat the member's own answer)
 * @param {number} [opts.colour]
 * @param {string|null} [opts.thumb]
 * @param {string|null} [opts.footer]  null removes it
 * @param {boolean} [opts.timestamp]
 */
function rrEmbed({ title, blocks, fields, colour = BRAND, thumb, footer = BRAND_FOOTER, timestamp } = {}) {
    const e = new EmbedBuilder().setColor(colour);
    const name = brandTitle(title);
    if (name) e.setTitle(name);
    const body = brandBody(blocks);
    if (body) e.setDescription(body);
    if (fields?.length) {
        e.addFields(fields.map(f => ({
            name: String(f.name).slice(0, 256),
            value: String(f.value).slice(0, 1024),
            ...(f.inline ? { inline: true } : {}),
        })));
    }
    if (thumb) e.setThumbnail(thumb);
    if (footer) e.setFooter({ text: footer });
    if (timestamp) e.setTimestamp();
    return e;
}

/** One line, capped — member prose and model prose both arrive with newlines in them. */
function shortLine(text, max = 180) {
    const one = String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** `2h 14m`, `3m`, `12s` — how long a ticket was open, for staff, not for a machine. */
function humanDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The #ticket-log row. Open and close produce the SAME title on purpose: the close looks the
 * entry up by title and edits it, so one ticket is one row in the log rather than two posts.
 * A rejected form has no channel and no follow-up, so it gets its own title and never collides.
 * @param {object} e
 * @param {'open'|'closed'|'false_topic'} [e.status]
 * @returns {{title: string, blocks: (string|false|null)[]}}
 */
function ticketLogEntry({
    ticketName, opener, category, status = 'open', problem,
    closedBy, openMs = 0, messages = 0, aiReplies = 0, provider,
}) {
    if (status === 'false_topic') {
        return {
            title: '⚠️ False topic',
            blocks: [`${opener} • ${category} • no channel created`, shortLine(problem, 220)],
        };
    }
    const title = `Ticket ${String(ticketName ?? '').replace(/[^0-9]/g, '') || ticketName}`;
    if (status === 'open') {
        return { title, blocks: [`${opener} • ${category}`, problem && `Problem: ${shortLine(problem, 220)}`] };
    }
    return {
        title,
        blocks: [
            `${opener} • ${category} • ${status}`
                + `\nOpen for ${humanDuration(openMs)} • ${messages} message${messages === 1 ? '' : 's'}`,
            `Closed by ${closedBy || 'unknown'} • ${aiReplies} AI repl${aiReplies === 1 ? 'y' : 'ies'}`
                + (provider ? ` • ${provider}` : ''),
        ],
    };
}

module.exports = {
    rrEmbed, brandTitle, brandBody, brandThumb,
    shortLine, humanDuration, ticketLogEntry,
    BRAND, BRAND_BAD, BRAND_GOOD, BRAND_FOOTER,
    MAX_TITLE_WORDS, MAX_BLOCK_LINES,
};
