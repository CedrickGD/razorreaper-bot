# RazorReaper — automation scripts

Found on the **Scripts** page (sidebar group *Automation*). Ground rules that apply to all
of them and answer most "the script does nothing" tickets:

- They send real keyboard/mouse input, so **ARK must be the focused foreground window**.
  Minimised, alt-tabbed or on another monitor = the script deliberately does nothing.
- Each script has its own **start/stop hotkey** (Scripts page, or the Global Hotkeys page).
  A hotkey another program already owns never reaches RazorReaper.
- Scripts that recognise something on screen (Take All, Tek Saddle, Noglin, Turret, Fed Suit,
  Flak, Antidote …) must be **calibrated for the current resolution and monitor**: capture the
  region and a reference snapshot on the same display ARK runs on. Changing resolution, UI
  scale or monitor invalidates the calibration and matching pauses until it is recaptured.
- "Match threshold" is a similarity percentage: too high = never matches, too low = false hits.

Defaults and min/max below are read straight from the shipped code.

## Anti-AFK (id `antiafk`)
Opens/closes inventory on an interval to avoid the idle kick.
- IntervalSeconds — default 600 (allowed 30…3600)
- InventoryKey — default "I"
- invkey: Inventory key
- invkey.desc: Toggles your inventory — prefilled from your ARK 'Show my inventory' binding.
- interval: Interval (seconds)
- interval.desc: Seconds between pulses.

## Astro (id `astro`)
One-shot: fires the Astrocetus downward-teleport sequence when you press Start.

## Auto Antidote (id `antidote`)
Watches a calibrated icon and presses a hotbar key when it appears, disappears, or its timer runs low.
- trigger: Trigger
- trigger.desc: When the watcher fires: the icon appearing, disappearing, or its timer running low.
- mode.appears: Icon appears
- mode.disappears: Icon disappears
- mode.timer: Timer below
- burstkey: Burst key
- burstkey.desc: Hotbar key pressed when it fires.
- burstpresses: Burst presses
- burstpresses.desc: Presses per trigger.
- timer: Timer threshold
- timer.desc: Fires at or below this many seconds remaining.
- threshold.desc: Similarity % at which the icon counts as visible.
- cooldown: Cooldown
- cooldown.desc: Seconds before it may fire again.
- livematch: Live match
- livematch.desc: Similarity of the last scan, and how often it has fired.
- fired: · {0} fired
- region: Icon region
- toast.needregion: Capture the HUD icon region first (calibration step 1).
- toast.needreference: Capture a reference snapshot with the icon visible (calibration step 2).
- toast.watching: Auto Antidote is watching.
- toast.stopped: Auto Antidote stopped.
- toast.regionupdated: Region updated — capture a new reference snapshot with the icon visible.
- toast.regionfailed: Failed to capture the icon region.
- toast.referencefailed: Could not capture the reference snapshot.
- toast.referencecaptured: Reference snapshot captured.
- toast.referencecapturefailed: Failed to capture the reference snapshot.
- toast.referencecleared: Reference snapshot cleared.
- toast.badburstkey: That key can't be used for the burst — reset to 5.
- toast.badhotkey: That combination can't be used as a toggle hotkey — keeping the previous one.
- toast.hotkeyinuse: Could not register {0} — the combination may be in use by another app.
- toast.noregion: Auto Antidote stopped — no calibrated region for the current resolution.
- activity.started: Auto Antidote started
- activity.stopped: Auto Antidote stopped
- activity.referencecaptured: Auto Antidote reference snapshot captured
- activity.noregion: Auto Antidote stopped (region missing)
- activity.triggered: Auto Antidote triggered (#{0})
- activity.burstfailed: Auto Antidote burst did not complete (game window unavailable?)

## Auto Download (id `autodownload`)
Repeats a chat command (default /download) on an interval.
- Command — default "/download"
- DelayMs — default 5000 (allowed 500…120000)

## Auto-Walk (id `autowalk`)
Holds the forward key so you keep running hands-free (released when ARK loses focus).
- ForwardKey — default "W"
- SprintKey — default "LeftShift"

## Crafting (id `crafting`)
Crafts at Fabricator/Chem Bench/Replicator — Watcher or Walk mode, with ping compensation.
- AccessKey — default "F"
- CraftKey — default "E"
- CraftPresses — default 3 (allowed 1…20)
- ForwardKey — default "W"
- MatchThresholdPercent — default 90 (allowed 50…100)
- Mode — default CraftingMode.Watcher
- PingCompensationMs — default 0 (allowed 0…3000)
- ScanIntervalMs — default 400 (allowed 100…5000)
- WalkMs — default 900 (allowed 100…10000)

## Dino Ready (id `dinoready`)
Single-stat leveler: clicks a calibrated stat + button N times (one-shot).
- ClickDelayMs — default 80 (allowed 20…1000)
- Presses — default 10 (allowed 1…200)

## Fast TP (id `fasttp`)
With the teleport menu open, types a destination and confirms (one-shot).
- ConfirmWithEnter — default true
- Destination — default ""
- destination: Destination
- destination.desc: Name typed into the teleport search field.
- confirm: Confirm with Enter
- confirm.desc: Press Enter after typing to pick the first match.

## Fed Suit (id `fedsuit`)
Genesis 2 transmitter loop: opens it, moves the worn exo set into it, closes, and the next suit is on you.

## Armor Swap (id `flak`)
Reads the durability numbers next to your armor and swaps in a fresh piece from the hotbar — flak, riot or tek, without opening anything.
- DurabilityThreshold — default 50 (allowed 1…100000)
- ScanIntervalMs — default 1000 (allowed 500…10000)
- swapbelow: Swap below
- swapbelow.desc: Durability points left on a piece before it is replaced. An absolute number, so it means the same on any server multiplier.
- rowkey: Row {0} hotbar key
- rowkey.badkey: '{0}' is not a key that can be sent — use a single character like 8, or a name like F5.
- rowkey.top: Hotbar slot holding the spare for the top armor row. Leave a row empty to ignore it.
- rowkey.other: Leave empty if you carry no spare for this row.
- scan.desc: Milliseconds between reads.
- lastread: Last read
- hint.notrunning: Start the script to see what it reads.
- hint.waiting: Waiting for ARK to be in the foreground…
- hint.nonumber: No number recognised — check the calibrated region.
- hint.swapping: Lowest {0} — at or below {1}, swapping{2}
- hint.nothing: Lowest {0} — above {1}, nothing to do{2}
- hint.lastswap: · last swap {0}
- activity.swapped: Armor swapped — row {0} was at {1}

## ICalibratable

## Inv Size (id `invsize`)
Experimental: Shift+right-click spam to inflate inventory (needs your blueprint hotkeys; lag/loss risk).
- IntervalMs — default 60 (allowed 20…2000)
- pulse: Pulse interval
- pulse.desc: Milliseconds between Shift+right-click pulses.

## Mammoth (id `mammoth`)
Alternates left/right clicks to keep the Mammoth war drum going AFK.
- IntervalMs — default 700 (allowed 100…10000)
- interval.desc: Milliseconds between drum cycles (left + right click).

## Noglin (id `noglin`)
Detects the Noglin mind-control icon and drops FPS to 1 until it clears.
- MatchThresholdPercent — default 90 (allowed 50…100)
- NormalFps — default 1000
- RestoreAfterCleanScans — default 3 (allowed 1…20)
- ScanIntervalMs — default 400 (allowed 100…5000)
- ThrottledFps — default 1
- threshold.desc: Similarity % at which the mind-control icon counts as visible.
- restore: Restore after
- restore.desc: Clean scans before FPS is restored.
- activity.throttled: Noglin: FPS throttled (mind-control detected)
- activity.restored: Noglin: FPS restored

## Take All (id `takeall`)
Clicks the container Take-All button whenever it's visible (calibrated region).
- ClickIntervalMs — default 50 (allowed 20…2000)
- MatchThresholdPercent — default 90 (allowed 50…100)
- clickinterval: Click interval
- clickinterval.desc: Milliseconds between scan + click attempts.
- threshold.desc: Similarity % at which the button counts as visible.

## Tek Saddle (id `teksaddle`)
While the Tek Saddle buff is up and you hold left-click, spams extra clicks.
- ClickDelayMs — default 20 (allowed 5…500)
- MatchThresholdPercent — default 90 (allowed 50…100)

## Turret Filler (id `turretfill`)
Fills the turret inventory you have open — a set amount, or until it stops taking.
- Amount — default TurretFillAmount.WholeStack
- ChangeThresholdPercent — default 0.2 (allowed 0.02…10)
- FilterSettleMs — default 250 (allowed 100…2000)
- FilterText — default ""
- MatchThresholdPercent — default 90 (allowed 50…100)
- Mode — default TurretFillMode.EvenSplit
- PressDelayMs — default 200 (allowed 60…2000)
- PressesPerTurret — default 1 (allowed 1…20)
- TransferKey — default "T"
- cursorwarning: Presses move whatever your cursor hovers. Hover your own ammo, not the turret's — the script cannot tell the two sides apart.
- mode: Mode
- mode.desc: Even split sends a set amount; Fill keeps going until nothing moves; Filter only types the search text and stops.
- mode.evensplit: Even split
- mode.fill: Fill
- mode.filteronly: Filter only
- amount: Transfer amount
- amount.desc: What one press moves: the whole hovered stack (T), half (Shift+T), or one item (Ctrl+T).
- amount.stack: Whole stack
- amount.half: Half stack
- amount.single: One item
- presses: Presses per turret
- presses.desc: Even split sends exactly this many. Fill stops earlier when nothing moves.
- transferkey.desc: Prefilled from your ARK 'Transfer item' binding.
- pressdelay: Delay between presses
- pressdelay.desc: Raise it on a laggy server — a press the server has not answered yet reads as 'nothing moved'.
- changethreshold: Change threshold
- changethreshold.desc: How much of the calibrated area has to change for a press to count. Lower it if real transfers read as 'nothing moved'.
- usefilter: Filter by ammo type
- usefilter.desc: Types the name into the inventory search box first, so only that ammo is left to hover. Needs both points below.
- filtertext: Ammo name
- filtertext.desc: Part of the item name as your game spells it, e.g. Advanced Rifle
- settle: Filter settle time
- settle.desc: How long the list gets to redraw before the first press.
- point.search: Search box
- point.slot: First ammo slot
- point.set: Set at {0}, {1}
- point.notset: Not set — hover the spot, then Capture.
- point.capture: Capture
- point.clear: Clear
- point.countdown: Hover the spot — {0} s
- activity.noinventory: Turret Filler: no inventory detected
- activity.done: Turret Filler: {0} of {1} presses moved something (last change {2} %)

## Turret Manager (id `turret`)
When a turret inventory is open, presses transfer to refill its ammo.
- MatchThresholdPercent — default 90 (allowed 50…100)
- ScanIntervalMs — default 500 (allowed 100…5000)
- TransferKey — default "T"
- TransferPresses — default 3 (allowed 1…20)
- threshold.desc: Similarity % at which the turret inventory counts as open.
- transferkey.desc: Pushes ammo into the turret — prefilled from your ARK 'Transfer item' binding.
- presses: Transfer presses
- presses.desc: Presses per detection.

## Yuty (id `yuty`)
Spams the Yutyrannus courage roar on an interval while mounted.
- IntervalMs — default 5000 (allowed 200…60000)
- RoarKey — default "C"
- roarkey: Roar key
- roarkey.desc: Key pressed each interval. ARK exposes no binding for the Yuty roar, so set this one yourself.
- interval.desc: Milliseconds between roars.
