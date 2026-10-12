# Audit — Orbit security, dead code and coverage

Status: complete

Full-codebase static audit of `src/` (13,670 LOC), 10 test files, build config and ADRs.
Findings filed as tickets under `issues/`, numbered by severity.

## Method

Reachability was computed with an import graph built from every entry point
(`src/main/index.ts`, `src/preload/index.ts`, the renderer entry, and every test import).
A file is dead when no path reaches it.

## Verdict

The architecture is sound. Partition isolation (ADR 0001), the typed IPC contract, renderer
isolation (ADR 0005) and the OAuth flow (ADR 0003) are all implemented correctly and verified clean.

The failures are concentrated in one theme: **the security boundary is implemented in the UI and in
the build config, not in the main process.** Three of the top four findings follow from that.

## Findings

| # | Severity | Finding |
| --- | --- | --- |
| 01 | critical | Admin credentials ship in plaintext inside the app bundle |
| 02 | high | Idle lock has no authentication outside macOS |
| 03 | high | Admin gate is enforced only in React, never in main |
| 04 | medium | No rate limiting on admin login |
| 05 | medium | Packaged `.env` resolution prefers the launch directory |
| 06 | medium | Update feed is a placeholder URL; notarization hardcoded off |
| 07 | medium | 1,792 lines of dead code across 11 files |
| 08 | low | Login auto-confirm is macOS-only |
| 09 | low | ~4,000 lines of Electron core have no test coverage |
| 10 | low | ADR 0006 describes an architecture no longer in the code |

## Verified clean

- OAuth `state` verified; window closed in `finally`; `sandbox` + `contextIsolation` set.
- Log redaction scrubs `xox*`, `Bearer …`, and any `token|secret|password|authorization` key.
- Slack tokens stored via `safeStorage`; refuses to run when OS encryption is unavailable.
- Admin password never written to disk — only a SHA-256 hash.
- `timingSafeEqual` used correctly, including the length-mismatch path.
- No `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function` in the renderer.
- Popup host allowlist is end-anchored, so `slack.com.evil.com` correctly fails to match.
- No deprecated symbols still referenced.

## Could not be assessed

`node_modules` is absent, so `npm run ci` was never run. Treat this codebase as
unverified-at-runtime — not as passing. There was no git history to diff against.