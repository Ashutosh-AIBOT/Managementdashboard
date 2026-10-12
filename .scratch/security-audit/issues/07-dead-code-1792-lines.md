# 1,792 lines of dead code across 11 files

Type: task
Status: needs-triage

## Problem

Computed unreachable from every entry point (`main/index.ts`, `preload/index.ts`,
renderer entry, all test imports):

| Lines | File |
| ---: | --- |
| 338 | `src/main/profiles/first-login-flow.ts` |
| 321 | `src/main/profiles/embedded-browser-auth.ts` |
| 281 | `src/main/profiles/slack-first-login-flow.ts` |
| 237 | `src/main/profiles/pane-auth.ts` |
| 167 | `src/renderer/src/components/AppPicker.tsx` |
| 163 | `src/main/profiles/chrome-embed-session.ts` |
| 90 | `src/main/profiles/local-auth-server.ts` |
| 84 | `src/renderer/src/components/AddProfileDialog.tsx` |
| 51 | `src/renderer/src/components/WorkspaceDropdown.tsx` |
| 35 | `src/renderer/src/lib/profile-avatar.ts` |
| 25 | `src/preload/auth-hide.ts` |

`embedded-browser-auth.ts` and `local-auth-server.ts` are reachable only from other
dead files — transitively dead.

## Compounding problem

`tests/unit/first-login-flow.test.ts` imports `__test__` from `first-login-flow.ts`.
There is a passing test suite guarding 337 lines of unreachable code.

## Note

This cluster is the *previous* login architecture. `slack-first-login-flow.ts`
implements what ADR 0006 describes; `chrome-embed-session.ts` is the version before
that. The shipped flow is real Chrome, in `chrome-browser-auth.ts`. See finding 10.

## Why needs-triage

Deletion is irreversible without a history to revert against. Decide whether this is
superseded code worth keeping for reference before removing it.
