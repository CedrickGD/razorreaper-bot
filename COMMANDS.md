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
| `/ticket` | View your open tickets | — | Everyone |
| `/queue` | See how many tickets are open | — | Everyone |
| `/ticketinfo` | View info about the current ticket | — | Everyone |
| `/adduser <user>` | Add a user to the current ticket | `user` (required) | Everyone |
| `/close [reason]` | Close the current ticket | `reason` (optional) | Staff / Ticket Owner |
| `/transcript` | Get this ticket's conversation as an HTML file (ephemeral) | — | Staff / Ticket Owner |
| `/delete` | Close the ticket if it is still open, then delete the channel | — | Staff |
| `/enableai` | Let the AI answer in this ticket again | — | Staff / Ticket Owner |
| `/disableai` | Stop the AI answering in this ticket | — | Staff / Ticket Owner |
| `/ticketping <user>` | Toggle the support-ping role — who "I need a human" pings | `user` (required) | **Bot owner only** |
| `/say <message> [channel]` | Send a message as the bot | `message` (required), `channel` (optional) | Staff |
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
