# RazorReaper — current release

- Latest version offered to clients: **1.5.3.0**
- Mandatory update: no
- Public release notes: https://dl.razorreaper.app/release-notes/v1.5.3

## What changed in this version

- Crosshair codes: press Copy code under Your profiles to share your crosshair as text, and paste a code into the code box to load one. Image crosshairs can't be shared as a code.
- RazorReaper is now in German, Russian and Simplified Chinese. Pick your language in Settings. The translations are machine-made, so tell us in Feedback & Support if something reads wrong.
- A bell next to Premium/Freemium in the sidebar replaces the Inbox link. It opens the release notes and your latest support replies, and shows a dot when something is new.
- A short sound plays when a support reply comes in while the app is open. It follows your sound settings.
- Script warnings and errors also show as a small banner at the top of ARK while you play. You can turn this off in Settings.
- Stretched Res lets you pick the monitor for a preset and for a custom resolution. Before, it always changed your main monitor.
- The Crosshair page tells you when ARK's Fullscreen mode can hide the crosshair, with a button to switch ARK to Windowed Fullscreen (close ARK first).
- Ammo calculator on the Turret Manager page: how many whole stacks of bullets or shards each turret gets from what you carry.
- New guide: Higher dino levels, under Mods & Intel (Lifetime key only).
- Turret Manager (experimental) is rebuilt. Switch it on, open a turret, and it fills it once with Advanced Rifle Bullets or Element Shards. Nothing to calibrate.
- Fed Suit is rebuilt. It switches to your inventory tab, moves each worn piece and waits for the game at every step instead of running on fixed timers. Nothing to calibrate, at any resolution or interface scale.
- Fed Suit has new settings: Runs (how many suits before it stops), Pieces (which pieces to move) and Lag buffer for laggy servers.
- When a Fed Suit run finishes, you walk away wearing the fresh set. If the transmitter is full or doesn't open, it stops and tells you why.
- Updates still download in the background, but the app no longer closes itself to install them. Use Restart & update in the bell or the tray icon, or it installs the next time you start RazorReaper.
- The app never restarts for an update while ARK, a script, a macro or the Auto Clicker is running. A required update installs as soon as they are closed.
- If an update fails to install, the app says so and waits for you to try again.
- Report a Problem is now Feedback & Support with two tabs: Feedback sends an idea without a system snapshot, Support sends a problem report with one.
- Your license (plan, key, expiry) opens from the Premium/Freemium button in the sidebar instead of the card on Home.
- On My account, Manage license is now View license, or Redeem key and Buy Premium on the free plan.
- Scripts take their keys from your ARK key binds. The Scripts page says where the keys came from, and Rescan re-reads them after you change them in ARK.
- The Scripts page shows whether ARK is running and in front, because scripts only act while ARK is the active window.
- Each script shows when it last actually did something, not just that it's running.
- Scripts that match a calibrated snapshot show the live match %, so you can set the threshold from real numbers.
- A calibration remembers which monitor and resolution it was taken on. If ARK has moved, the script says so and won't start instead of matching at random.
- Astro, Auto Download, Fast TP and Crafting in Walk mode are marked Experimental. They run on fixed timings and can't check the result, so lag can make them miss.
- When a hotkey can't be registered, the key shows a warning and names what is holding it: another RazorReaper feature or another program. This covers scripts, the Auto Clicker and the crosshair.
- Stretched Res presets start from your screen's own height, so a 1440p screen gets 1920x1440 and 1800x1440, which are only stretched sideways.
- Crafting pressed E to open inventories on most PCs. It now uses your Access Inventory key (F by default).
- Noglin's FPS drop didn't work because the console command was typed wrong. Commands the app types into the ARK console now arrive exactly as written.
- Script key presses are held long enough for ARK to notice them, and a key a script holds down (like Auto Walk's W) is always released when it stops.
- Scripts that watch the screen looked at the wrong monitor when ARK was on your second screen, so they never triggered.
- The crosshair stays above ARK in Fullscreen after the game takes focus again.
- The crosshair re-centres after a resolution change or Stretched Res.
- The crosshair no longer sits half a pixel off centre, and imported PNG crosshairs are trimmed so they centre too.
- Changes to GameUserSettings.ini (INI Changer, INI Builder, Tek camera, Stretched Res, Custom FOV) now work when the file is read-only, and it stays read-only.
- Custom FOV no longer says it was set when it couldn't write the file.
- Starting Fed Suit from the Scripts list used up two free runs. It now counts as one.
- Scrolling the page no longer changes a number field under the mouse.
- Dropdown menus are no longer cut off or hidden behind the next card.
- When your graphics driver refuses a custom resolution, Stretched Res now points AMD and Intel users to their own settings app, not NVIDIA's.
- Fixed a few rare crashes and glitches from background work, such as the app closing by itself or a notification showing twice.
- The Valorant/CS2 code import and the Crosshair X workshop import. They couldn't recreate those crosshairs exactly. Use crosshair codes, or import an image or video.
- The first file conversion downloads ffmpeg once.

Older versions: point the member at the release-notes page above rather than guessing.
