# RazorReaper — support FAQ (hand-written)

The questions that actually come in. Hand-maintained: `tools/build-kb.mjs` never rewrites this
file. If an answer here contradicts a generated file, this file wins — it is the owner's wording.

## Buying, plans and keys

**Where do I buy / where is my key?**
At <https://razorreaper.app>. The key is in the purchase confirmation from that shop. It is also
shown in the app under **My account → View license**.

**Lifetime vs monthly.** Both unlock the same Premium features with two differences: a monthly
plan expires and has to be renewed before the countdown ends, a Lifetime plan never does; and a
few pages are marked *Lifetime only* — those do not come with the monthly plans at all. In the
Discord, Lifetime holders get the **Lifetime** role instead of **RR-Customer**; it opens every
chat RR-Customer does plus exclusive-chat.

**Reinstalled Windows / factory reset / "my Premium is gone".**
A reinstall or reset on the SAME PC keeps the licence on that PC; the app only forgot the key.
Tell the member to enter it once more: the **Freemium** button at the bottom of the sidebar (or
**My account → Redeem key**), paste the whole key, **Activate**. Premium switches on at once, no
restart. Only if that answers *License has reached its maximum number of uses.* is it the case
below.

**New Discord account.** The member runs `/verify` with their key on the new account. If the bot
answers *This license is already linked to another Discord account.*, ask for the **last 4
characters** of the key and the old Discord name, then escalate with **I need a human**.

**Activation fails / "key already used".**
Keys bind to one PC at activation. In order:
1. Check the key is pasted whole, with the dashes and no trailing space.
2. If it was activated on another PC or the hardware changed (new drive, motherboard or CPU), the
   old PC has to be released — that is a manual step only the owner can do. Ask the member for the
   **last 4 characters** of the key (never the whole key) and the Discord name on the order, then
   escalate with **I need a human**.
3. If the app says *Access suspended* or *Access permanently revoked*, that is an administrator
   action, not a bug. Do not speculate about the reason — escalate.

**Refunds, chargebacks, payment problems, extending a licence.** Never answer these. Say a human
will take over and escalate — the owner decides every one of them personally.

## Installing and updating

**Where do I download it?** <https://dl.razorreaper.app> — that page always serves the current
`RazorReaper-Setup.exe`. The installer is self-contained (~73–77 MB); there is no .NET runtime or
other prerequisite to install first.

**Windows SmartScreen / "Windows protected your PC" / antivirus flags the installer.**
Expected for a small publisher. SmartScreen: **More info → Run anyway**. An antivirus false
positive can be resolved by allowing the file and retrying; never tell a member to disable their
antivirus entirely. If a scanner deletes the file mid-download, the install fails with no clear
message — that is the first thing to check.

**"Update available" every time / the update never finishes (the 1.4.8 loop).**
**1.4.8** downloads the update and installs it only when the app really exits — but the window's
X only hides it to the tray, so it never exits, and the next start throws the download away and
fetches it again. Any of these ends the loop:
1. On **Home**, press the update button (**Update Now**, which turns into **Install & Restart**
   once the download is done) and accept the Windows prompt.
2. Or right-click the RazorReaper icon in the tray → **Quit**, then accept the Windows prompt.
3. Or download the current installer from <https://dl.razorreaper.app> and run it over the
   existing install.
Settings and licence survive; nothing has to be uninstalled first. From 1.4.9 on the app installs
updates by itself.

**"Update v… is ready — restart to install" but nothing happens.**
RazorReaper deliberately refuses to restart while **ARK or one of your macros is running**. Close
ARK, stop any running script, then use **Restart & update** in the bell view (*What's new &
inbox*) or in the tray menu. A Windows UAC prompt during the update is normal — the app installs
into Program Files.

**Update failed with an installer exit code.** The installer stays staged for exactly one retry,
and the retry is the same **Restart & update** button — it is never retried on its own. A second
failure on the same version discards it; then install manually from <https://dl.razorreaper.app>.

## Scripts and automation

**"The script does nothing."** Walk these four in order, they cover almost every case:
1. **ARK must be the focused foreground window.** Alt-tabbed, minimised or ARK on a different
   monitor than the one that was calibrated = the script intentionally does nothing.
2. **The start/stop hotkey** must actually reach RazorReaper. If another program (Steam overlay,
   Discord, G HUB, another macro tool) already owns that combination, rebind it on the **Global
   Hotkeys** page.
3. **Calibration.** Every script that recognises something on screen needs its region and
   reference snapshot captured *at the current resolution, on the display ARK runs on*. Changing
   resolution, stretched res, UI scale or monitor invalidates it and matching pauses until it is
   recaptured.
4. **Match threshold.** Too high = never matches, too low = false hits. Watch the *Live match*
   value with the target on screen and off it, then set the threshold between the two.

**Known problems right now (1.5.3).**
- Take All and Armor Swap are not reliable at the moment. The owner is fixing them. Say so
  plainly, do not walk the member through recalibrating them, and offer **I need a human** if
  they want an update.
- On **1.5.2 or older**, Noglin's FPS drop and every in-game console command arrive without their
  dot (`t.maxfps` becomes `tmaxfps`). 1.5.3 (released 2026-09-24) fixes it: tell the member to
  install the update the app offers (bell → Restart & update) or get it from
  <https://dl.razorreaper.app>.

**Is this bannable / does it get detected?** Do not make promises about bans, detection or
anti-cheat. Say that RazorReaper sends ordinary keyboard and mouse input and does not modify the
game process, that the member uses it at their own risk, and leave it there.

**Fed Suit.** Genesis 2 only — it drives the Genesis 2 transmitter loop and has no meaning on any
other map.

## Discord

**Which chats can I use?** **rr-chat** is for everyone. **premium-chat** is for every active
licence (the **RR-Customer** or the **Lifetime** role), **exclusive-chat** for Lifetime licences
only (the **Lifetime** role). These are Discord perks only; releases and the changelog stay public
for everyone.

**What else does a licence get me on Discord?** Every active licence also opens the **presets**
forum, where customers share their settings, crosshairs and script setups. And it gets priority
support: a ticket from a customer is flagged ⭐ and a human from the team is pinged at once — the
automatic answers still come as usual.

**How do I get my roles here?** Run `/verify key:XXXX-XXXX-XXXX-XXXX` in the **verify** channel —
the reply is private, nobody else sees the key. Chat messages in that channel are deleted
automatically, and a pasted key is removed at once. That grants **RR-Customer** while the licence
is active; a lifetime licence gets **Lifetime** instead. Roles are re-checked periodically
against the licence — a lapsed licence loses the role automatically and gets it back on renewal.
If the role does not arrive, open a ticket.

**I verified but have no role.** Usually the bot's role sits below the role it is trying to grant,
or the licence is not active. Escalate rather than guessing.

## Things this assistant must never do

- Ask for, repeat or confirm a full licence key. The **last 4 characters** are the maximum.
- Ask for a password, payment details, an account e-mail's password, or remote access.
- Promise a refund, a licence extension, a rebind, an unban or a release date.
- Explain how licensing, HWID binding, anti-tamper or the update/licence servers work internally —
  including "roughly" or "in general". If a member pushes for it, that is a **I need a human**.
- Invent a setting, page, hotkey or version that is not in this knowledge base. Saying "I do not
  know, a human will pick this up" is always the better answer.
