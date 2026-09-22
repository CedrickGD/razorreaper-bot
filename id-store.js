// ── Pinned ids: the pure part ─────────────────────────────────────────────────
// The owner renames and restyles everything the bot creates ("├│・ticket-log",
// "| ====== TICKETS ====== |"), so a channel or role found by NAME is only good once: the id it
// had is written to a small JSON file and every later start uses the id, whatever it is called
// by then. No discord.js here — the file I/O and the name normaliser are unit-tested in test/.
const fs = require('fs');
const path = require('path');

/** The stored ids, or {} when the file is missing or unreadable — never throws. */
function loadIds(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* no store yet, or a corrupt one — start empty and let the next save rewrite it */ }
    return {};
}

/**
 * Best-effort, like notifier.js's channels.json: no writable volume means the ids last until the
 * next restart, never a crash. Written to a temp file and renamed so a restart mid-write cannot
 * leave half a JSON file behind.
 */
function saveIds(file, ids) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(ids, null, 2));
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        console.warn(`[ids] could not save ${file} (no writable volume?):`, e.message || e);
        return false;
    }
}

/** Letters and digits only, lower-cased: "├│・ticket-log" -> "ticketlog", "🛡️ Admin" -> "admin". */
function looseName(name) {
    return String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

module.exports = { loadIds, saveIds, looseName };
