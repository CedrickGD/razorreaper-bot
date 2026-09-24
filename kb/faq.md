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

**Activation fails / "key already used".**
Keys bind to one PC at activation. In order:
1. Check the key is pasted whole, with the dashes and no trailing space.
2. If it was activated on another PC (or after a Windows reinstall / new hardware), it has to be
   released and rebound — that is a manual step only the owner can do. Ask the member for the
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
Versions around **1.4.8** could get stuck in a loop where the update downloaded but never applied
— install-on-close plus the tray process plus the staged-installer cleanup could fight each other.
The fix is not another restart: download the current installer from <https://dl.razorreaper.app>
and run it over the existing install. Settings and licence survive; nothing has to be uninstalled
first.

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
