# BACKDOOR: obfuscated payload appended to eslint.config.mjs

Type: task
Status: ready-for-human

Severity: **critical — treat the host as compromised**

## What was found

`eslint.config.mjs` lines 1-34 are a legitimate, standard electron-vite ESLint config.
They end mid-expression at `eslintConfigPrettier` with no closing bracket.

**Line 35 is 26,295 characters of obfuscated JavaScript appended after the closing `);`.**

    function GSkqNNyuJw$_padNcYwam(){const etOZXsn_OxqoSnJy$OEFSTCE=[
      'bcbdaff1','f3fdfdfa','a0ba88bbbba8b0','a1aca8adacbbba','b9a0b9ac',
      'a1bdbdb9baf3e6e6f8bbb9aae7a0a6e6acbda1', ...

A string-array + decoder-function packer. All `require()` calls are indirect:

    require(BEf$CYFUWXrAiwaYBJ(0x19f))

Payload indicators on that line: `spawn` x2, `require` x6, `eval` x1,
`https` x4, `Buffer` x5. Recovered decoder output includes these function names:

    linkAbort · decompressStream · httpRequest · withRpcEndpoints · rpcCall · rpcBatch

That is a **JSON-RPC client over HTTPS with process spawning and eval** — a backdoor
loader, not a linter artifact.

## Trigger surface

`eslint.config.mjs` is imported whenever ESLint starts. That means:

- `npm run lint`, and therefore `npm run ci` (currently blocked at the lint stage —
  the 16 lint errors ARE this payload being reported)
- `npm run dev` on any editor that shells ESLint on save
- **`.github/workflows/ci.yml` runs `npm ci` + `npm run ci` on `ubuntu-latest` on
  every push and every pull request**

Simply having this project open in VS Code with the ESLint extension is enough.

## Exposure already incurred

The payload was executed twice on this machine before it was identified:

1. `npm run ci` (lint stage)
2. `npx eslint . -f json`

Both via `npm run lint` / direct invocation. No other execution is known.
All investigation after detection was static (`grep`, `awk`, string slicing).

## Required response

1. **Stop running `npm run ci` and `npm run dev`** in this repo.
2. **Quarantine the file** before any further use — do not delete it yet, it is
   the only evidence. Move it out of the project root first.
3. **Assume credential compromise** on this host. Rotate:
   - npm tokens (`~/.npmrc`)
   - any `.env` / admin credentials used to build
   - Slack tokens if a signed-in profile was ever launched
   - GitHub PATs and SSH keys if this ran in CI
4. **Audit CI history** — the workflow has been executing this on every push.
   Check Actions logs and any outbound network calls from runners.
5. **Check for second-stage persistence**: `~/.bashrc`, `~/.profile`, `~/.zshrc`,
   cron, systemd user units, and `node_modules/.bin` shims.
6. **Determine provenance** — every file in this checkout shares mtime
   `2026-09-08 21:30:32`, so the payload shipped with the archive. Find where
   this repo was downloaded from and treat that source as hostile.

## Provenance note

The `.github/workflows/ci.yml` has never been able to pass: lint has always failed
on this payload's own code. That is consistent with a payload that is not meant
to be lived with.