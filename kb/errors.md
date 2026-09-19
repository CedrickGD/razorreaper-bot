# RazorReaper — error codes and troubleshooting

Codes shown as `RR-Exxxx` in the app (Troubleshoot page → *Last error* / *Error codes*).

- **RR-E1000** — Unhandled exception: The app hit an unexpected error. Restart and check the log file.
- **RR-E1001** — Startup timeout: The UI did not load in time. Restart or reinstall the app.
- **RR-E1002** — Startup script error: A startup script failed before the UI loaded.
- **RR-E1003** — Background task failure: A background task crashed. Check the log file for details.
- **RR-E1004** — StartupTaskFailure (no user-facing description in the app).

## Before assuming something is broken (from the Troubleshoot page)

- If Steam is updating or repairing ARK, paths can appear missing or locked. Wait for Steam to finish, then try again.
- If files refuse to change, close the game first and rerun the tool.
- If you ever see a startup error code, note it and share it with support.

## Getting logs out of a member

- Turn on logs to capture issues and share details.
- Troubleshoot page → **Enable logging** (optionally *Verbose diagnostics*), reproduce the
  problem, then **Open log folder** and attach the newest file to the ticket.
- Describe what went wrong in the report form. Windows, ARK, license, feature prerequisites, and recent operation details are attached when you send it.
