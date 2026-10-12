# START HERE

Single entry point for this repo. Read this before starting any work.

---

## 1. Right now — security, in this order

### 1.1 Do not run npm

`~/.nvm/versions/node/v24.20.0/lib/node_modules/npm/lib/cli.js` is booby-trapped.
Every `npm` command re-spawns the payload. Launch Orbit directly instead:

```bash
cd ~/Desktop/slack-dashboard-main
node node_modules/electron-vite/bin/electron-vite.js dev
```

(`npm run dev` is just `node scripts/patch-electron-mac-identity.mjs && electron-vite dev`.
The patch script exits immediately on non-macOS, so it can be skipped.)

### 1.2 Restore npm — uses curl, never the compromised npm

```bash
cd /tmp && rm -rf npmfix && mkdir npmfix && cd npmfix
curl -sL https://registry.npmjs.org/npm/-/npm-11.19.0.tgz -o npm.tgz
tar xzf npm.tgz
cp package/lib/cli.js ~/.nvm/versions/node/v24.20.0/lib/node_modules/npm/lib/cli.js
grep -c 'A11--' ~/.nvm/versions/node/v24.20.0/lib/node_modules/npm/lib/cli.js   # must print 0
npm cache clean --force
```

### 1.3 Rotate every credential

Code ran as this user for ~30 minutes with `eval()` and `spawn()` available.
Treat every secret on the machine as disclosed.

- [ ] Slack `CLIENT_SECRET` + `SIGNING_SECRET` — in the Slack app settings
- [ ] npm token
- [ ] GitHub PAT and SSH keys
- [ ] Anything in `.env`

### 1.4 Trace the source

Every file in the downloaded archive shared mtime `2026-09-08 21:30:32`, so the
payload shipped with the download rather than being added later. Find where the
repo came from, treat that source as hostile, and check any other repos pulled
the same way.

### 1.5 Optional: rebuild instead

Restoring npm closes the known vector. It cannot prove there is no second one.
A clean rebuild is the only way to be certain. This is a judgement call about
how much the machine holds.

---

## 2. Verify it worked

```bash
grep -c 'A11--' ~/.nvm/versions/node/v24.20.0/lib/node_modules/npm/lib/cli.js  # 0
ss -tnp | grep -c 193.247.144.38                                              # 0
grep -rl 'A11--' ~/.nvm/                                                    # no output
npm --version                                                                 # 11.19.0
```

All four clean means npm is trustworthy again. Then `npm run ci` is safe to use.

---

## 3. Where the actual project work starts

11 tickets in `issues/`, ranked. Read the spec first: `spec.md`.

**Target platform is Linux** (AppImage / snap / deb). This raises the priority of
two tickets and changes one finding outright — see `AGENTS.md` for the full table
of macOS assumptions that are broken on this host.

### Fix now — clear, self-contained, no decisions needed

| Ticket | What | Size |
| --- | --- | --- |
| `02` | Idle lock has no auth on Linux — not degraded, **absent** | ~15 lines |
| `04` | No rate limiting on admin login | ~20 lines |
| `05` | Packaged `.env` resolution prefers launch dir | ~10 lines |
| `03` | Admin gate enforced only in React, never in main | ~30 lines |
| `08` | Sign-in cannot find Chromium — blocks the core login flow | ~40 lines |

Start with **02**. It is the clearest, it is a genuine security hole, and it is
independent of every other ticket.

**08 is now a functional blocker, not just a defect.** Until
`resolveChromeExecutable()` knows about Linux, Google and Slack sign-in cannot
start at all on this platform.

### Decide before touching

| Ticket | Blocked on |
| --- | --- |
| `01` | Is distribution trusted-closed or public? Changes whether `.env` can ship at all |
| `06` | What is the real update feed URL? Should auto-update exist at all? |
| `07` | Delete 1,792 lines of dead code, or keep for reference? |
| `08` | Is Linux/Windows genuinely supported, or macOS-only in practice? |
| `09` | Scope of testing the Electron core |
| `10` | Supersede ADR 0006 — mechanical once approved |

Ticket `00` (the cryptojacker) is closed. Do not reopen unless npm re-taints.

### Order that works

1. **02** — fix, verify, commit
2. **04**, **05** — small, independent, same commit style
3. **03** — needs the `isAuthenticated` guard wired through both `registerAppIpc` and `registerProfileIpc`
4. **Answer 01 / 06** — these gate any release
5. **07** — only after deciding, and only because git history now exists to revert it

---

## 4. Ground rules for this repo

- **Verify before claiming done.** `npm run ci` — lint + typecheck + 50 tests.
  Tests never import `electron`, so passing tests say nothing about the Electron
  paths. That gap is ticket `09`.
- **One invariant above all others.** Every profile × app gets partition
  `persist:profile-<id>-<appId>`. Never share one, never fall back to the
  default session. ADR 0001.
- **Never commit `.env`.** Gitignored, and `electron-builder.yml` copies it into
  shipped builds — that is ticket `01`.
- **ADRs are read as current truth.** Ticket `10` exists because ADR 0006
  contradicts the code, which sends readers down a dead path.