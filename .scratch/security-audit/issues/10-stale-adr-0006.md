# ADR 0006 describes an architecture no longer in the code

Type: task
Status: ready-for-agent

## Problem

`docs/adr/0006-explicit-first-login-after-profile-create.md` specifies that
Google and Slack sign-in happen as two sequential steps inside **one Electron
`BrowserWindow`** on `partitionForProfile(id)`, with `setWindowOpenHandler` forcing
SSO navigations into that window.

That is `slack-first-login-flow.ts` / `first-login-flow.ts` — which finding 07
establishes are both unreachable.

The shipped flow is entirely different: `chrome-browser-auth.ts` launches **real
Google Chrome** as a separate OS process, positioned over the right pane, using
`--user-data-dir=userData/chrome-login-profiles/<profileId>`, then imports cookies
via `chrome-cookie-probe.ts`.

## Why it matters

ADRs are read as current truth by every agent and by `docs/agents/domain.md`. A
stale ADR that contradicts the code sends the next reader down a dead path.

## Fix

Supersede ADR 0006 with a new ADR describing the real-Chrome flow, keeping 0006
in place marked `Superseded by ADR 0011`. Do not delete it — the history is the point.

Related: ADR 0001 still says `persist:profile-<id>`, but `partitionForProfile()` now
produces `persist:profile-<id>-<appId>`. That one needs a smaller correction.
