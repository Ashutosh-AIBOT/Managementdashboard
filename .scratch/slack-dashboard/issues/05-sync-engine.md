# Serialised incremental sync engine

Type: task
Status: ready-for-agent
Plan: Task 5

## Design

Workspace -> channels -> messages, one request at a time. Incremental from
`lastSyncTs`. First run backfills 90 days.

## Acceptance

- one in-flight sync; a second is rejected
- `invalid_auth` raises `ReconnectRequiredError`
- network failure mid-sync keeps partial progress and does not mark the
  channel synced
- progress emits `channelIndex` / `channelTotal`
- only messages newer than `lastSyncTs` are requested
