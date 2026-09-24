# RazorReaper Bot — Command List

## Slash Commands (`/`)

| Command | Description | Parameters | Permission |
|---------|-------------|------------|------------|
| `/ping` | Check bot latency and WebSocket ping | — | Everyone |
| `/help` | Interactive help menu | — | Everyone |
| `/info` | View server statistics | — | Everyone |
| `/userinfo [user]` | View detailed user profile | `user` (optional) | Everyone |
| `/status` | View bot & server status — uptime, ping, tickets | — | Everyone |
| `/rules` | Display the server rules | — | Everyone |
| `/invites [user]` | How many members someone brought in: total (regular + earlier) and the regular · earlier · left · fake breakdown, plus who invited them | `user` (optional, default: self) | Everyone |
| `/inviteleaderboard` | The top 10 inviters by total, and your own rank if you are not in it | — | Everyone |
| `/invitecontest status` | The running invite contest: top 10 and your own count and rank (ephemeral) | — | Everyone |
| `/ticket` | View your open tickets | — | Everyone |
| `/queue` | See how many tickets are open | — | Everyone |
| `/ticketinfo` | View info about the current ticket | — | Everyone |
| `/adduser <user>` | Add a user to the current ticket | `user` (required) | Staff / Ticket Owner |
| `/close [reason]` | Close the current ticket | `reason` (optional) | Staff / Ticket Owner |
| `/transcript` | Get this ticket's conversation as an HTML file (ephemeral) | — | Staff / Ticket Owner |
| `/delete` | Close the ticket if it is still open, then delete the channel | — | Staff |
| `/enableai` | Let the AI answer in this ticket again | — | Staff / Ticket Owner |
| `/disableai` | Stop the AI answering in this ticket | — | Staff / Ticket Owner |
| `/ticketping <user>` | Toggle the support-ping role — who "I need a human" pings | `user` (required) | **Bot owner only** |
| `/say <message> [channel]` | Send a message as the bot | `message` (required), `channel` (optional) | Staff |
| `/giveaway start <prize> <duration> [winners] [channel]` | Post a giveaway; members react 🎉 to join. At the end the bot draws the winners at random (bots and members who left don't count), edits the post and pings the winners once to open a ticket for the prize | `prize` (≤200 chars), `duration` (`30m`, `12h`, `2d`, `1w`, `1d12h`; 1 min – 60 days), `winners` (1–10, default 1), `channel` (optional, default: current) | Staff |
| `/giveaway end · reroll · cancel <message>` | Draw now · draw new winners from the same entries (previous winners skipped while others are left) · end without winners | `message` (link or id), `winners` (reroll only, optional) | Staff |
| `/giveaway list` | The running giveaways with link and end time (ephemeral) | — | Staff |
| `/invitecontest start <duration> <prize> [winners] [channel]` | One invite contest at a time: invites made while it runs count (members still here at the end, accounts ≥ 7 days old); live top 5 in the post, updated every 10 min; at the end the winners are pinged once | `duration` (as `/giveaway`), `prize`, `winners` (1–5, default 1), `channel` (optional) | Staff |
| `/invitecontest end` | Finish the invite contest now | — | Staff |
| `/buildembed [channel]` | Discohook-style embed builder in an ephemeral message — title, text, author, footer, images, fields, colour presets or hex, RR logo/avatars as icons, timestamp, up to 5 link buttons, JSON import/export — then sends a NEW message | `channel` (optional, default: current) | Staff |
| `/editembed message` | The same builder, loaded with a message the bot sent; "Save" edits it in place | `message` (required: the message link) | Staff |
| `/clear <amount> <filter> [user]` | Delete messages in a channel | `amount` (required), `filter` (required: All/User/Bots), `user` (optional) | Staff |
| `/purge <amount>` | Quick bulk-delete messages (1–100) | `amount` (required) | Staff |
| `/kick <user> [reason]` | Kick a member from the server | `user` (required), `reason` (optional) | Staff |
| `/ban <user> [reason]` | Ban a member from the server | `user` (required), `reason` (optional) | Staff |
| `/warn <user> [reason]` | Warn a member | `user` (required), `reason` (optional) | Staff |
| `/warns [user]` | View warnings for a member | `user` (optional) | Staff |
| `/clearwarns <user>` | Clear all warnings for a member | `user` (required) | Staff |
| `/steal <emojis>` | Steal or download emojis (up to 5) | `emojis` (required) | Manage Expressions |
| `/stealsticker [name]` | Steal a sticker (searches last 10 messages) | `name` (optional) | Manage Expressions |
| `/changeformat <file>` | Convert image or video to a different format | `file` (required attachment) | Everyone |
| `/roles [user]` | Interactive role selector — ephemeral dropdown(s) to sync roles | `user` (optional, default: self) | **Server owner only** |

## Inside a ticket: `@RazorReaper <command>`

A message in a ticket channel that **starts** with a mention of the bot runs the same five ticket
actions as the slash commands and the ticket buttons: `close [reason]`, `transcript`, `delete`,
`enableai`, `disableai` (a leading `/` is allowed, case does not matter). The message never
reaches the AI. `transcript` arrives as a DM — the channel only gets a one-line confirmation.

### Supported Formats for `/changeformat`

- **Image:** PNG, JPG, WebP, GIF, BMP, TIFF
- **Video:** MP4, AVI, MOV, MKV, WebM, GIF
