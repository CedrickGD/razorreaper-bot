# RazorReaper Bot — Command List

## Prefix Commands (`!`)

| Command | Description | Parameters | Permission |
|---------|-------------|------------|------------|
| `!ping` | Check bot latency and WebSocket ping | — | Everyone |
| `!help` | Interactive help menu with category dropdown | — | Everyone |
| `!info` | Display server statistics (members, boosts, etc.) | — | Everyone |
| `!userinfo [@user]` | Show detailed user profile | `@user` (optional) | Everyone |
| `!status` | Show bot uptime, ping, open tickets, member count | — | Everyone |
| `!rules` | Display server rules | — | Everyone |
| `!ticket` | View your open tickets | — | Everyone |
| `!queue` | Show open/closed ticket counts | — | Everyone |
| `!ticketinfo` | Info about current ticket (use inside ticket channel) | — | Everyone |
| `!adduser @user` | Add a user to the current ticket | `@user` (required) | Everyone |
| `!close [reason]` | Close the current ticket | `reason` (optional) | Staff / Ticket Owner |
| `!say [#channel] <message>` | Send a message as the bot | `#channel` (optional), `message` (required) | Staff |
| `!clear` | Interactive message cleaner with dropdown menus | — | Staff |
| `!purge <amount>` | Quick bulk-delete messages (1–100) | `amount` (required) | Staff |
| `!kick @user [reason]` | Kick a member from the server | `@user` (required), `reason` (optional) | Staff |
| `!ban @user [reason]` | Ban a member from the server | `@user` (required), `reason` (optional) | Staff |
| `!warn @user [reason]` | Warn a member (sends DM notification) | `@user` (required), `reason` (optional) | Staff |
| `!warns [@user]` | View all warnings for a member | `@user` (optional) | Staff |
| `!clearwarns @user` | Clear all warnings for a member | `@user` (required) | Staff |
| `!steal <emoji(s)>` | Steal or download emojis from other servers | `emoji(s)` (required), `name` (optional) | Staff (steal) / Everyone (download) |
| `!stealsticker` | Steal or download a sticker (reply to a sticker message) | `name` (optional) | Staff (steal) / Everyone (download) |

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

### Supported Formats for `/changeformat`

- **Image:** PNG, JPG, WebP, GIF, BMP, TIFF
- **Video:** MP4, AVI, MOV, MKV, WebM, GIF
