# Orbit — Agent Instructions

Product: **Orbit** (`com.orbit.app`). Repo and data folder name: `slack-dashboard`.

## Target platform: Linux

Primary target is **Linux** — `build:linux` produces AppImage, snap and deb. The dev host is Linux too.

This is not a macOS project with Linux as an afterthought. Several code paths are written macOS-only and are therefore **broken here, not merely degraded**:

| Assumption in code | Linux reality | Effect |
| --- | --- | --- |
| `resolveChromeExecutable()` checks only `/Applications/*.app` | Chromium lives at `/usr/bin/chromium` | Google + Slack sign-in finds no browser and returns `null` |
| Idle lock gates on `systemPreferences.promptTouchID` | No Touch ID; that branch never runs | `unlock()` clears the lock with **no check at all** |
| `CHROME_USER_AGENT` says `Macintosh; Intel Mac OS X` | Intentional — Slack needs a desktop Chrome UA | Keep it |
| Electron clipboard needs `xclip` or `xsel` | Neither installed | Harmless log noise; `xclip: command not found` |

Two macOS assumptions happen to hold on this host and should not be "fixed" blind:
`/usr/bin/sqlite3` **is** present, so the cookie probe works. `secret-tool` is present, so
Electron `safeStorage` works.

Note `extraResources` in `electron-builder.yml` is **top-level**, not mac-only — so a Linux
AppImage/snap/deb also ships whatever `.env` exists on the build machine.

## The one invariant

Every profile × app pair gets its own Chromium session partition, `persist:profile-<id>-<appId>`
(`src/main/profiles/session-partition.ts`). Never reuse a partition across profiles, never fall
back to the default session. Breaching this leaks one account's cookies into another's session —
see ADR 0001.

## Layout

| Path | Owns |
| --- | --- |
| `src/main/` | All privileged work. Electron main process, full Node access. |
| `src/main/ipc/` | IPC handlers. Route every channel through `ipc/handle.ts`. |
| `src/main/profiles/` | Browser view lifecycle, auth flows, partition logic. |
| `src/preload/` | The only renderer↔main bridge. Exposes `window.api` via `contextBridge`. |
| `src/renderer/` | React UI. Sidebar and overlays only — the embedded app views are **not** React. |
| `src/shared/` | Types and the IPC contract. Imported by all three processes. |
| `tests/unit/` | Vitest, plain Node. No test imports `electron`. |

## Verify before claiming done

```bash
npm run ci   # lint + typecheck + vitest
```

## Launch without npm

`npm` is currently booby-trapped on this host — see `.scratch/security-audit/START-HERE.md`.
Until it is repaired, run:

```bash
node node_modules/electron-vite/bin/electron-vite.js dev
```

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.