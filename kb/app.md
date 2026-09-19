# RazorReaper — the app

RazorReaper is a paid Windows desktop toolkit for **Steam ARK: Survival Evolved** (not ASA,
not the Microsoft Store build, not console). Everything below is quoted from the product
README — use these exact tool names when pointing a member at a page.

## Highlights

- **One app, 35+ tools** — organized into searchable sections with instant global search (`Ctrl+K`)
- **Self-contained installer** — bundles the .NET runtime; download, install, play (no prerequisites)
- **Updates on your schedule** — new versions download silently in the background; the restart that installs them is yours to trigger, from the sidebar or the tray
- **Four languages** — English, German, Russian and Simplified Chinese, switched live from Settings; the first wave of pages is translated, the rest stay English (see [`docs/i18n.md`](docs/i18n.md))
- **Fully themeable** — recolor the entire app with a built-in accent color picker
- **Tray-native** — minimizes to the system tray and stays out of your way while you play
- **Discord Rich Presence** — shows the tool you're using as your Discord activity (optional)
- **Session HUD** — click-through in-game overlay with clock, session timer, server info and alerts

## Features

### Core

| Tool | What it does |
| --- | --- |
| **Home** | Dashboard with system info, announcements, accent theming and game path handling |
| **Server** | Connect to and manage ARK servers from one panel |
| **Game** | Launch, control and monitor the ARK game process |

### ARK Tweaks

| Tool | What it does |
| --- | --- |
| **INI Changer** | Three-column INI workspace with preset gallery, editing, import/export |
| **INI Builder** | One-click `Game.ini` / `GameUserSettings.ini` presets with automatic backups |
| **Vision Tools** | TEK camera behavior, scope visibility and FOV in one place |
| **Gamma** | System-wide screen gamma on a hotkey or Logitech G HUB mouse button |
| **Launch Options** | ARK startup flags with their trade-offs explained |
| **Fonts** | In-game font switching with presets |
| **Pixel Glitch** | Texture file utilities with backup and revert support |
| **Paintings** | `MyPaintings` workflow and preset handling |

### Custom ARK

| Tool | What it does |
| --- | --- |
| **Sky Changer** | Replace the in-game sky with an image or solid color by patching local sky files |
| **Loading Screen** | Swap ARK's startup and loading videos for your own — fully reversible |
| **Char Manager** | Manage the appearance presets on ARK's character-creation screen |
| **Stretched Res** | Switch to a stretched resolution safely, with 15-second auto-revert |

### Automation

| Tool | What it does |
| --- | --- |
| **Scripts** | Automation hub — start, stop and configure ARK automation scripts |
| **Global Hotkeys** | Every script's start/stop hotkey, visible and editable at a glance |
| **Auto Clicker** | Advanced mouse-click automation |
| **Macros** | Record, replay and run premade input macros |
| **Fed Suit** | Automated transmitter slot transfers for the Federation Suit grind |
| **Auto Antidote** | Watches the HUD and refreshes your antidote automatically |
| **HUD Overlay** | Click-through overlay: clock, session timer, server info, tool status, alerts |
| **Notifier** | Live in-game alerts for rare dinos, resources and OSD events |

### Mods & Intel

| Tool | What it does |
| --- | --- |
| **Mutagen Prices** | Gen2 creature mutagen values, searchable by name |
| **Line List** | Track breeding lines and build WTS/WTB trade posts |
| **OC BPs** | Genesis 2 mission rewards for overcapped blueprints |
| **Bosses** | Boss and mini-boss tribute requirements, sorted by map |
| **TP Locations** | Teleport-worthy spots per map with copyable `setplayerpos` commands |
| **Underwater Drops** | Underwater loot crates by coordinate, searchable by map and crate type |
| **Map Mods** | Modded-map spots — caves, landmarks, obelisks, POIs — with coordinates and notes |
| **Steam Mods** | Installed workshop mods with fast search and latest-install filtering |

### Utilities

| Tool | What it does |
| --- | --- |
| **Building** | Foundation, wall, layout and meta build patterns with fullscreen lightbox |
| **Desync** | Freeze your character server-side by blocking ARK's outbound traffic — always auto-reverting |
| **File Modifier** | Remove or replace individual ARK files and clear redundant cooked data to reclaim disk space |
| **Crosshair** | Always-on-top crosshair overlay with editor, presets, animations and image import |
| **Macro / AHK** | Crafting macro and AHK references, videos and scripts |
| **Compact ARK** | Shrink the ARK install with transparent NTFS compression |

Plus **Troubleshoot**, **Feedback** and **Credits** pages built in.

## Getting Started

### Requirements

- Windows 10 or Windows 11 (x64)
- Steam **ARK: Survival Evolved**

### Updating

RazorReaper checks for updates on launch and every 30 minutes while it is open, and downloads a new version silently in the background — there is nothing to click and nothing to wait for.

Installing is the part you control. Once the download has finished and been verified, the update sits ready and the bell in the sidebar keeps a dot. From there, pick whichever suits you:

- **Restart & update to vX** in the **What's new & inbox** view (click the bell), or
- **Restart & update (vX)** in the tray menu, or
- nothing at all — the next time you start RazorReaper, the waiting update is applied before anything else runs.

Two rules never bend. The app will not restart itself while ARK or one of your macros is running: it says so and stays ready until you are done. And a release the manifest marks *mandatory* applies on its own as soon as that gate is clear — it does not wait for the button.

Because RazorReaper installs into Program Files, Windows shows a UAC prompt while an update is applied. The guarantee is narrower than "never during a session", so here it is exactly: RazorReaper will not restart while ARK or a macro is running. A mandatory release applies as soon as that gate is clear, whatever else you are doing. Every other update waits for you to press **Restart & update**, or for the next start.

If an update was applied and the installer failed, RazorReaper says so at the next start — in a warning and in the **What's new & inbox** view — and leaves the installer staged for one retry. That retry is yours to ask for: the same **Restart & update** button. It is not tried again on its own.

[Releases & updates](#releases--updates) below describes the same thing from the other side: how a version is cut, and how your install hears about it.

## Notes

- Some tools expect a valid ARK install path and will guide you to set one
- Actions that touch game files create backups and are designed to be reversible
- Telemetry and data handling: see [PRIVACY.md](PRIVACY.md)

