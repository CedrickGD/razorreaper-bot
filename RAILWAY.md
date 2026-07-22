# Railway hosting + Notifier backend

This bot now does two jobs on one always-on host:

1. The existing Discord bot (tickets, moderation, utilities).
2. The **Notifier backend** — watches configured ARK alert channels and relays
   alerts to RazorReaper desktop clients over an SSE HTTP stream (`notifier.js`).

---

## 1. Migrate hosting from JustRunMy.App to Railway

Railway deploys straight from the GitHub repo using the committed `Dockerfile`
and `railway.json` (health check on `/health`, auto-restart on failure).

1. Create a project at <https://railway.app> → **New Project → Deploy from GitHub repo**
   → pick `CedrickGD/razorreaper-bot`.
2. Railway detects the `Dockerfile` and builds it. No start command needed
   (`CMD ["node", "index.js"]`).
3. **Variables** tab — add:
   | Variable | Value | Notes |
   |---|---|---|
   | `TOKEN` | *(your bot token)* | Same one JustRunMy uses. |
   | `NOTIFIER_TOKEN` | *(a long random string)* | Clients must present this. Keep it private. (`NOTIFIER_SECRET` works as a legacy alias.) |
   | `NOTIFIER_CHANNELS` | *(JSON, see below)* | Channels to watch. `{}` to start. |
   | `NOTIFIER_MESSAGE_CONTENT` | `true` | Requires the privileged intent portal toggle FIRST (see §3) — without it, alert embeds arrive empty. |
   | `VERIFY_API_BASE` | `https://rr-admin-panel.pages.dev` | License‑community gate. Base URL of the admin panel. |
   | `VERIFY_SHARED_SECRET` | *(long random string)* | Must MATCH the same var on Cloudflare Pages. |
   | `VERIFIED_ROLE_ID` | *(role id)* | The `Verified` role granted to license holders. |
   | `VERIFY_GUILD_ID` | *(guild id)* | Optional — defaults to the bot's only guild. |
   | `VERIFY_RECONCILE_MINUTES` | `30` | Optional — how often lapsed licenses lose the role. |
   `PORT` is injected by Railway automatically — do **not** set it. The four `VERIFY_*` role vars
   are optional: without all of `VERIFY_API_BASE` + `VERIFY_SHARED_SECRET` + `VERIFIED_ROLE_ID`
   the `/verify` gate stays dormant and the bot runs exactly as before. Full setup:
   `RR-Admin-Panel/SETUP-ACCESS-DISCORD.md`.
4. **Settings → Networking → Generate Domain** to get a public URL like
   `https://razorreaper-bot-production.up.railway.app`. This is the base URL the
   app's Notifier page uses.
5. Deploy. Check the logs: you should see `[RazorReaper] Online as …`,
   `[Notifier] HTTP/SSE server listening on :<port>` and the bot come online in
   Discord.
6. Verify the stream is up:
   `https://<your-domain>/health` → `{"ok":true,"uptime":…,"clients":…,"watching":…}`
   `https://<your-domain>/notifier/test?token=<NOTIFIER_TOKEN>` → `{"ok":true,...}`
7. **Only after Railway is confirmed working**, turn off the old host so the bot
   isn't running twice (double slash-command replies): in the GitHub repo, disable
   or delete `.github/workflows/deploy.yml` (the JustRunMy auto-deploy), and stop
   the app on the JustRunMy dashboard. Until then, leave both — Railway runs from
   this branch, JustRunMy from `main`, so merging is the switch.

> Two live instances of the same bot will double-respond to commands. Run only one
> at a time once you've cut over.

---

## 2. Point RazorReaper at the backend

In the app: **Notifier** page → Endpoint field →
`https://<your-domain>/notifier/stream` and enter the `NOTIFIER_TOKEN`. Use
**Test alert** (or hit `/notifier/test` above) to confirm alerts reach the HUD.

---

## 3. Configure watched channels

The bot only relays messages from channels listed in `NOTIFIER_CHANNELS`, a JSON
map of `channelId → { cluster, type }`:

```json
{
  "1234567890": { "cluster": "Mesa",   "type": "rare-dino" },
  "2345678901": { "cluster": "Mesa",   "type": "resource" },
  "3456789012": { "cluster": "Fusion", "type": "osd" }
}
```

- Get a channel ID: Discord → User Settings → Advanced → **Developer Mode** on,
  then right-click the channel → **Copy Channel ID**.
- **The bot must be a member of that server and able to read that channel.** You
  can only add the bot to servers you have Manage-Server on. For clusters you
  don't control, ask their staff to invite the bot to a read-only alert channel,
  or mirror their alerts into a channel on your own server (e.g. via a webhook /
  follow) and watch that.
- `type` should match the app's alert types: `rare-dino`, `resource`, `osd`,
  `element-node` (free-form is allowed; the app filters on these).

**Reading alerts requires the Message Content intent:** Discord withholds the
`content` **and** `embeds`/`attachments` of messages written by other users/bots
unless the privileged **Message Content Intent** is enabled — and alert channels
are exactly that. So for the notifier to see anything: first enable **Message
Content Intent** in the [Discord Developer Portal](https://discord.com/developers/applications)
→ your app → Bot → Privileged Gateway Intents, **then** set
`NOTIFIER_MESSAGE_CONTENT=true`. If you set the flag without enabling the portal
toggle, the bot fails to log in (that is why the flag is opt-in). With the flag
off, the bot runs fine but watched-channel messages arrive empty and no alerts
are relayed.

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Health check — `{"ok":true,"uptime":…,"clients":…,"watching":…}`. |
| GET | `/notifier/stream?token=…` | token | SSE alert stream for clients (heartbeat comment every 25s; supports `Last-Event-ID` replay). |
| GET | `/notifier/test?token=…` | token | Inject a synthetic alert to all clients. Accepts `&type=`, `&cluster=`, `&subject=`. |
| GET | `/notifier/channels?token=…` | token | List watched channels — `{"ok":true,"channels":[{channelId,cluster,type}]}`. |
| POST | `/notifier/channels?token=…` | token | Add/update a channel. JSON body `{channelId, cluster, type}`. Applies live. |
| DELETE | `/notifier/channels?token=…&id=<channelId>` | token | Remove a channel. Applies live. |

The token may be passed as `?token=` or `Authorization: Bearer <token>`
(`?secret=` is accepted as a legacy alias). If `NOTIFIER_TOKEN` is not set on
the server, the stream refuses every connection with 503 — fail closed.

## Live channel management + persistence (Railway Volume)

The watched-channel map is editable live from the RazorReaper app (the Notifier
page's **Watched channels** card → the `/notifier/channels` endpoints above). No
redeploy is needed — edits mutate the in-memory map the message handler reads.

To make those edits **survive restarts/redeploys**, attach a **Railway Volume**
(Service → Settings → Volumes) mounted at **`/data`** (or set `NOTIFIER_DATA_DIR`
to the mount path). The bot persists `channels.json` there and, on first boot
with an empty volume, seeds it from `NOTIFIER_CHANNELS`. Without a volume the
feature still works — edits just reset to the `NOTIFIER_CHANNELS` seed on the
next restart (persistence is best-effort and never fatal).
