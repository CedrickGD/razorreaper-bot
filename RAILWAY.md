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
   | `NOTIFIER_SECRET` | *(a long random string)* | Clients must present this. Keep it private. |
   | `NOTIFIER_CHANNELS` | *(JSON, see below)* | Channels to watch. `{}` to start. |
   | `NOTIFIER_MESSAGE_CONTENT` | `false` | Leave `false` unless you enable the privileged intent (see §3). |
   `PORT` is injected by Railway automatically — do **not** set it.
4. **Settings → Networking → Generate Domain** to get a public URL like
   `https://razorreaper-bot-production.up.railway.app`. This is the base URL the
   app's Notifier page uses.
5. Deploy. Check the logs: you should see `[RazorReaper] Online as …`,
   `[Notifier] HTTP/SSE server listening on :<port>` and the bot come online in
   Discord.
6. Verify the stream is up:
   `https://<your-domain>/health` → `ok`
   `https://<your-domain>/notifier/test?secret=<NOTIFIER_SECRET>` → `{"ok":true,...}`
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
`https://<your-domain>/notifier/stream` and enter the `NOTIFIER_SECRET`. Use
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

**Embeds vs. plain text:** most ARK alert bots post **embeds**, which the notifier
reads with no privileged intent. If a source posts alerts as plain message text,
set `NOTIFIER_MESSAGE_CONTENT=true` — but first enable **Message Content Intent**
in the [Discord Developer Portal](https://discord.com/developers/applications) →
your app → Bot → Privileged Gateway Intents. If you set the flag without enabling
the intent, the bot fails to log in.

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Health check (returns `ok`). |
| GET | `/notifier/stream?secret=…` | secret | SSE alert stream for clients. |
| GET | `/notifier/test?secret=…` | secret | Inject a synthetic alert to all clients. |

Secret may be passed as `?secret=` or `Authorization: Bearer <secret>`.
