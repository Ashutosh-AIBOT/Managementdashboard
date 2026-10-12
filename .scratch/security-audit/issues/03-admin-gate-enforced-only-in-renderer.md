# Admin gate is enforced only in React, never in main

Type: task
Status: ready-for-agent

## Problem

`src/main/ipc/handle.ts:11`

    ipcMain.handle(channel, async (_event, payload) => handler(payload))

No channel checks authorization. Grepping the IPC layer returns only
`adminAuth.status/login/logout` — zero guards. `ProfileDelete`, `ProfileClearAll`,
`AppSettingsSet` and `ProfileImportMetadata` are callable regardless of login state.

The gate lives solely at `src/renderer/src/App.tsx:657`:

    if (!adminAuthenticated) return <AdminLoginOverlay ... />

## Honest severity

The renderer is sandboxed with no Node access, so this is not remotely exploitable
today. It is a defense-in-depth failure: the main process trusts a UI decision.
Any future renderer bug, devtools session, or XSS bypasses the gate completely.

It compounds finding 01, where the credential itself ships in the bundle.

## Fix

Pass an `isAuthenticated: () => boolean` guard into `registerAppIpc` and
`registerProfileIpc`, and reject privileged channels inside `handleInvoke`. Read-only
channels (`ProfileList`, `AppSettingsGet`, `AppAdminStatus`) can stay open.
