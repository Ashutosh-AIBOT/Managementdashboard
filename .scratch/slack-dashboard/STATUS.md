# Slack Dashboard — Implementation Status

**As of:** 2026-10-14
**Branch:** `clean-dashboard`
**Baseline:** `6a95482` (Tasks 1–7 landed)
**Plan:** `.scratch/slack-dashboard/plan-ui-and-watchlist.md` — Tasks 8–20, all of them
**SDD ledger:** `.superpowers/sdd/plan-ui-and-watchlist/progress.md` (git-ignored scratch)

> **Read this before touching the code.** The backend exists and is tested. The
> feature is still invisible in the app: there is no sidebar button, no dashboard
> screen, nothing rendered. Everything below the line is why.

---

## 1. Verification state

| Gate | Command | Result |
| --- | --- | --- |
| Tests | `node node_modules/vitest/vitest.mjs run` | **268 passed / 19 files** |
| Lint | `node node_modules/eslint/bin/eslint.js .` | **clean** |
| Typecheck (main) | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false` | **clean** |
| Typecheck (web) | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false` | **clean** |

**`npm` is booby-trapped on this host — never run it.** Use the `node node_modules/…`
forms above. Launch the app with:

```bash
node node_modules/electron-vite/bin/electron-vite.js dev
```

---

## 2. Completed and verified

### Tasks 1–7 — the backend (pre-existing, landed at baseline `6a95482`)

| Task | What | File |
| --- | --- | --- |
| 1 | Rate limiter honouring `retry_after` | `src/main/slack/rate-limiter.ts` |
| 2 | Cursor-paginated `conversations.history` with `oldest=`; `users.list`; `auth.test` | `src/main/slack/slack-api-client.ts` |
| 3 | `users:read` scope added | `src/main/slack/oauth-flow.ts` |
| 4 | Store: lifetime totals, per-day counts, 90-day window, prune | `src/main/slack/dashboard-store.ts` |
| 5 | Per-workspace serialised, resumable sync engine | `src/main/slack/sync-engine.ts` |
| 6 | Pluggable AI analyzer, three-state degrade contract | `src/main/slack/ai-analyzer.ts` |
| 7 | Six dashboard IPC channels + the auto-sync driver | `src/main/ipc/slack-dashboard.ipc.ts` |

### Task 8 — pure view-model (`22b38f5`, `bf46858`, `d2d41c0`)

`src/shared/dashboard-view.ts` — every dashboard decision expressible as a pure
function: `utcDay`, `channelAiState`, `sentimentTrend`, `dailySeries`,
`orderWorkspaces`, `isWatched`, `effectiveWatched`, `toggleWatched`,
`selectWatchedChannels`, `relativeTime`. 29 tests.

It is a separate module for a hard reason: vitest is
`include: ['tests/unit/**/*.test.ts']` in a **`node` environment** — no jsdom, no
`.tsx` in the include. React components cannot be tested at all here, so anything
worth testing has to live in a `.ts` module.

Reviewed and approved. Two fix rounds closed: the unlabelled-message guard and the
mean-score arithmetic had tests that passed with the target code deleted; both now
carry mutation-proofed assertions. Every fix in this task was mutation-tested —
the implementer deleted the target code and confirmed the specific test failed.

### Task 9 — derive trend and series into the snapshot (`5a35729`)

`buildSnapshot` now derives `sentimentTrend` and `dailySeries` per channel on read.
Neither is persisted — a test reads the raw JSON back off disk and asserts both are
absent. 1 test, mutation-verified.

---

## 3. NOT completed — Tasks 10–20

None of these are started. They are the whole remaining feature.

| Task | What is missing | Touches |
| --- | --- | --- |
| **10** | Persisted model **v2**: `WorkspaceRollup.watchedChannelIds?`, `ChannelRollup.summaries?`, `ChannelSummary`, `DASHBOARD_VERSION` 1 → 2, normalizer branches, v1 back-compat | `src/shared/types.ts`, `dashboard-store.ts` |
| **11** | Sync engine filters the walk by the watch list; tolerates `channel_not_found` by skipping **and auto-unwatching** | `src/main/slack/sync-engine.ts` |
| **12** | Auto-pick the busiest channels **once** per workspace, never re-applying | `sync-engine.ts`, `dashboard-store.ts` |
| **13** | Hourly scheduler staggered by a stable FNV-1a hash of `teamId`; one timer, no bursts; catch-up on wake | `slack-dashboard.ipc.ts` |
| **14** | The summariser: one request per workspace covering all watched channels | `src/main/slack/summarizer.ts` (new) |
| **15** | Append one digest per channel per **UTC day** — append-only, never overwritten | `slack-dashboard.ipc.ts`, `src/main/index.ts` |
| **16** | `set-watched-channels` + `list-channels` over IPC, preload, contract | `ipc-contract.ts`, `preload/index.ts`, `slack-dashboard.ipc.ts` |
| **17** | `useDashboard.ts` — zustand store over the dashboard channels | `src/renderer/src/hooks/` (new) |
| **18** | `SlackDashboard.tsx` — the actual screen | `src/renderer/src/components/` (new), `main.css` |
| **19** | Sidebar entry, ⌘D, mount in `App.tsx`, CSS | `ProfileSidebar.tsx`, `App.tsx`, `main.css` |
| **20** | ADR 0007, ticket closure, whole-branch verification | `docs/adr/`, `.scratch/` |

**The headline: Task 18 and 19 are why the app looks unchanged today.** The fetch,
store, prune, analyse and IPC pipeline all work. Nothing calls it.

---

## 4. Decisions already locked — do not relitigate

| Decision | Value | Where |
| --- | --- | --- |
| Token type | **`xoxp-` user token**, one per workspace install | `oauth-flow.ts` |
| Scopes | **Exactly six, frozen**: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `team:read`, `users:read` | `oauth-flow.ts:11-18` |
| `reactions:read` / `pins:read` | **Declined by the operator.** Not added. Adding later means re-consenting every workspace | — |
| Sync interval | **Hourly**, staggered by a stable per-workspace minute slot | Task 13 |
| "Batch" | **One request per workspace covering all its channels** — *not* OpenAI's `/v1/batches` | Task 14 |
| Digests | **Daily and append-only**; the UTC day key is the idempotence guard | Task 15 |
| Watch list | Auto-pick on first sync **plus** a manual picker; the heuristic never re-applies | Tasks 12, 18 |
| Derived fields | **Never persisted** — computed on read, like the existing three AI fields | Task 9 (done) |

### Why `/v1/batches` is not the answer

It is half price, but asynchronous with a **24-hour SLA**. A digest submitted after
the 23:00 sync appears after the *next* night's sync — the dashboard would be
permanently a day stale. Batching across channels in one synchronous request cuts the
request count by the channel count at the same price per token.

---

## 5. What the operator must set up before any of this can be tested for real

| Variable | Source |
| --- | --- |
| `SLACK_CLIENT_ID` | Slack app → Basic Information → Client ID |
| `SLACK_CLIENT_SECRET` | Slack app → Basic Information → Client Secret |
| `SLACK_REDIRECT_URI` | Slack app → OAuth & Permissions → Sign in with Slack |
| `OPENAI_API_KEY` | platform.openai.com |

**Slack app:** create it at `https://api.slack.com/apps` → *From a manifest*. The
ready-to-paste YAML manifest is in
`/home/creator/.opencode/plan/slack-dashboard-token-setup-and-flow.md`. Note
`long_description` must be 174–4000 characters or the editor rejects it.

**`SLACK_SIGNING_SECRET` is not needed** — Orbit polls; it does not receive Events
API requests.

**Test with 1–3 workspaces first**, not 30. Connect, press Sync once by hand, confirm
the walk completes, then let the hourly driver take over.

---

## 6. Outstanding security actions

None are code changes; all are operational. **Do these before a client sees this.**

| # | Action | Why |
| --- | --- | --- |
| 1 | **Rotate `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET`** | Both were pasted into a chat log |
| 2 | **Rotate the GitHub personal access token** | A `ghp_`-prefixed token was pasted into a chat log. Rotate it before using it for anything |
| 3 | **Get written authorisation from each client organisation** | Slack's API ToS requires it from the **organisation**, not the individual member |
| 4 | Ship a visible "connected and reading" indicator | Slack emits **zero** notification for an API read. There is no audit action for "app read a message" — accountability has to be self-imposed |

`.env` is git-ignored, is not tracked on any branch, and holds only the six keys
listed above. `.env.example` is tracked and holds placeholders.

---

## 7. Known limitations

- **Hourly sync needs the machine awake.** It is a desktop process. The `lastSyncTs`
  cursor makes a resumed cycle lossless, so sleep costs latency, not data.
- **30 grants = 30 failure modes.** Each workspace's token is tied to a human; if the
  person who connected a client workspace leaves, Slack auto-uninstalls the app and
  that client silently stops refreshing. Use a dedicated service account per client.
- **Auto-pick is weak on day one.** A brand-new workspace has `totalMessages: 0` on
  every channel, so the first pick is alphabetical, not volume-ranked. The operator
  overrides it in the picker.
- **Slack permanently deleted free-workspace messages older than 1 year** on a rolling
  basis since 26 Aug 2024. "Lifetime" counters start from the day we first read a
  message; they can never be backfilled.
- **`utcDay` can return `''`** for an out-of-range timestamp. Task 18 should treat
  that as a blank label, not render it as a date.

---

## 8. How to resume

1. Read the plan: `.scratch/slack-dashboard/plan-ui-and-watchlist.md`, Task 10 onward.
2. Read the ledger if present: `.superpowers/sdd/plan-ui-and-watchlist/progress.md` —
   it carries four preflight rulings (R1–R4) that correct **defects in the plan text**
   and that a new implementer must not undo.
3. Continue at **Task 10**.
4. Verify with the four commands in §1. Baseline to hold: **268 tests / 19 files**,
   lint clean, both typechecks clean.

### Do not

- Run `npm`.
- Add scopes beyond the six.
- Persist a derived field — trend, series or AI counts must stay read-time.
- Modify `src/main/profiles/session-partition.ts`. The `persist:profile-<id>-<appId>`
  invariant is what stops one account's cookies leaking into another's session
  (ADR 0001).
- Key anything by `teamName`. Two workspaces may share a display name; use `teamId`.
- Create a second test harness. `tests/unit/dashboard-ipc-contract.test.ts` owns the
  only dashboard IPC harness in the repo.