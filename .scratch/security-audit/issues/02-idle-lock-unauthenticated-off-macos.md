# Idle lock has no authentication outside macOS

Type: task
Status: ready-for-agent

Severity on **Linux, the primary target**: the feature does nothing at all.
There is no Touch ID branch to fall through, so `unlock()` unconditionally clears
the lock. Not degraded — absent.

## Problem

`src/main/app-lock.ts:49-68`

    async unlock(): Promise<boolean> {
      if (!this.locked) return true
      if (process.platform === 'darwin') {
        try { await systemPreferences.promptTouchID(...) }
        catch { /* retry once, then return false */ }
      }
      this.locked = false   // <- Linux/Windows: unconditional

The Touch ID block is the only gate. On Linux and Windows `unlock()` clears the
lock and returns `true` with no check at all.

## Failure scenario

User walks away from an unlocked Linux or Windows machine. Idle lock engages.
Anyone who touches the keyboard clicks Unlock and has every profile's Slack session.

## Fix

Require a real credential on every platform. `systemPreferences` offers
`promptTouchID` (macOS) and, on Windows, `promptTouchID` is unavailable — so gate
the unlock behind the admin password instead of OS biometrics, or refuse to enable
idle lock where no authenticator exists.

Note: `AdminAuthController` is not currently reachable from `AppLockController`.
Wiring it in is part of this work.
