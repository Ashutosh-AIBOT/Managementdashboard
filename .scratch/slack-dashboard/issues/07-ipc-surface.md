# Dashboard IPC surface

Type: task
Status: ready-for-agent
Plan: Task 7

## Acceptance

- six channels: get, sync-now, progress, set-auto-sync, clear, reconnect-needed
- channel strings unique across IpcChannels
- preload exposes exactly the declared methods
- types additive only - no existing interface altered
