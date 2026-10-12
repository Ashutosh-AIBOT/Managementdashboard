# ~4,000 lines of Electron core have no test coverage

Type: task
Status: needs-triage

## Problem

No test file imports `electron`. Uncovered modules:

| Lines | Module |
| ---: | --- |
| 1041 | `src/main/profiles/browser-view-manager.ts` |
| 913 | `src/main/profiles/chrome-system-login.ts` |
| 795 | `src/main/ipc/profiles.ipc.ts` |
| 438 | `src/main/profiles/chrome-browser-auth.ts` |
| 114 | `src/main/ipc/app.ipc.ts` |

`profile-store.ts` (1167 lines) has partial coverage.

## Why it matters

The riskiest code in the repo — view lifecycle, partition management, auth state
machines — has none. The auth status transitions in `profile-store.ts:51-69` are
pure data and would be trivially testable, and those are exactly the paths that
produce the "stuck signing-in" state the app already has a launch-time repair for.

## Suggested first step

Extract the transition tables into a dependency-free module and test the state
machine exhaustively. It needs no Electron and removes the largest untested
surface that is actually testable today.
