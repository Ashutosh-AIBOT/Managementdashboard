# Login auto-confirm is macOS-only

Type: task
Status: needs-triage

## Problem

`src/main/profiles/chrome-cookie-probe.ts:35`

    const out = spawnSync('/usr/bin/sqlite3', [tmp, sql], { encoding: 'utf8' })

Hardcoded absolute path. Google sign-in needs 2+ matching cookies, Slack needs 1
(`chrome-browser-auth.ts:305` polls every 750ms for up to 10 minutes).

`src/main/profiles/chrome-system-login.ts:42-44` likewise hardcodes
`/Applications/...` and shells to `osascript` throughout, with non-macOS stubs.

## Failure scenario

On Linux or Windows the probe never fires, so login never auto-confirms and the
user must click Continue manually. Everything still works — it just silently
degrades, which is why this has gone unnoticed.

## Why needs-triage

**On Linux this is the primary blocker for the core login flow**, not a
side-issue. `resolveChromeExecutable()` checks only `/Applications/*.app`, so on
this host it returns `null` and Google/Slack sign-in cannot start at all.
Chromium is installed at `/usr/bin/chromium` and is never considered.

Two related notes:

- The `/usr/bin/sqlite3` half of this ticket is **already fine on Linux** —
  that binary is present, so the cookie probe runs. Do not "fix" it.
- The earlier framing of this ticket asked whether Linux is really supported.
  That question is now answered: Linux is the primary target.

## Fix, given Linux is the target

Make `resolveChromeExecutable()` probe a platform-appropriate list:

- darwin — the existing three `/Applications/...` paths
- linux — `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`,
  `/usr/bin/chromium`, `/usr/bin/chromium-browser`, plus `which` lookups
- win32 — the usual `%ProgramFiles%` locations

The `osascript` window-docking code in `chrome-system-login.ts` is separately
macOS-only (lines 450–526) and has non-darwin stubs that return early, so the
window will not be positioned over the app pane on Linux. Deciding whether to
implement Linux window docking or drop the docking concept is part of this.
