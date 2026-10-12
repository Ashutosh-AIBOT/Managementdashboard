# Admin credentials ship in plaintext inside the app bundle

Type: task
Status: ready-for-human

## Problem

`electron-builder.yml:15-19`

    extraResources:
      - from: .env
        to: .env

`.env` holds `ADMIN_USERNAME` and `ADMIN_PASSWORD` in plaintext. This copies it
unencrypted into every distributed build.

## Failure scenario

Build a Mac `.app`, send the zip to a colleague. They unzip it, `cat` the `.env`,
and now hold the admin password guarding every workspace connected to that build.

README section 7 Option A instructs this deliberately, so it is intended — but it
means the app's only security boundary is a password that ships with the app.

## Why ready-for-human

The distribution model decides the fix. Removing `extraResources` breaks the
"hand someone a build and they sign in" flow in README section 7. Options:

- Ship credentials out-of-band (written to `userData/.env` on first run).
- Keep the bundle copy but fail the build unless an explicit `ALLOW_BUNDLED_CREDS=1`.
- Accept it and document that builds are trusted-closed-distribution only.

Do not change `electron-builder.yml` without settling this first.

## Note for Linux

`extraResources` is **top-level**, not nested under `mac:` — so this affects
every target, including the Linux AppImage, snap and deb. Anyone who unzips an
AppImage or extracts the deb gets the admin password in plaintext.
