# Dashboard store

Type: task
Status: ready-for-agent
Plan: Task 4

## Files
`src/main/slack/dashboard-store.ts`, `tests/unit/dashboard-store.test.ts`

## Design

`dashboard.json` in userData. No database (npm is booby-trapped on this host,
so no new dependencies). Mirrors `profile-store.ts` conventions.

## Acceptance

- aggregates accumulate across syncs
- `lastSyncTs` advances to newest `ts`
- messages older than 90 days pruned
- `totalMessages` and `dailyCounts` survive pruning
- corrupt file resets to empty rather than throwing
