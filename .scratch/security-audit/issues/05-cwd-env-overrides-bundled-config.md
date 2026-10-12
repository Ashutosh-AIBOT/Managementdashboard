# Packaged `.env` resolution prefers the launch directory

Type: task
Status: ready-for-agent

## Problem

`src/main/load-app-env.ts:32-39`. When packaged, candidates resolve in this order:

1. `userData/.env`
2. hardcoded `~/Library/Application Support/{slack-dashboard,Orbit,Workspace Dashboard}/.env`
3. `app.getPath('resourcesPath')/.env`   <- the app's own bundled config
4. `process.cwd()/.env`                  <- whatever directory it was launched from

The app's own bundled config is checked *before* the current working directory,
so a `.env` in the launch directory silently overrides the shipped one.

## Failure scenario

On Linux, launching from `~` means a stray `~/.env` controls the admin password.

## Fix

Move `process.cwd()` to the front for dev only, or drop it entirely when
`app.isPackaged`. Also drop the hardcoded macOS paths — they run on every platform
and are dead weight on Linux and Windows.
