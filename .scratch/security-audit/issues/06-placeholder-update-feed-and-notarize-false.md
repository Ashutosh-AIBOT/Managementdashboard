# Placeholder update feed; notarization hardcoded off

Type: task
Status: needs-info

## Problem

Three related gaps:

1. `electron-builder.yml:60-62` ships `url: https://example.com/auto-updates` —
   a literal example URL as the default update feed.
2. `electron-builder.yml:48` sets `notarize: false` unconditionally.
3. `src/main/ipc/app.ipc.ts:73` calls `autoUpdater.setFeedURL()` with no scheme
   validation.

Gap 2 contradicts README section 11, which documents a notarization procedure that
the config disables outright.

## Failure scenario

An `UPDATE_FEED_URL` set to `http://` allows a network attacker to serve an update.
On macOS, an unnotarized build triggers Gatekeeper prompts and cannot be distributed
to end users.

## Needed before starting

What is the real feed URL, and is this app distributed to untrusted users or only
to a fixed internal group? The answer decides whether auto-update should exist at all.
