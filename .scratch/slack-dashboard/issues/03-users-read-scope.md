# Add users:read scope

Type: task
Status: ready-for-agent
Plan: Task 3

## Problem

`SlackMessageSummary.user` is a raw ID (`U024BE7LH`) passed straight from the
wire. `users:read` is not in `USER_SCOPES`, so names cannot be resolved.

## Why now

Scopes are granted at consent time. Adding the scope later means a second
re-connect pass over every workspace. Adding it now costs one.

## Known limitation

Existing workspaces keep the old grant until each is re-connected. The
dashboard must show a "reconnect for names" hint rather than raw IDs.

## Acceptance

- `users:read` appended to `USER_SCOPES`
- `oauth-flow.test.ts` expectation updated
