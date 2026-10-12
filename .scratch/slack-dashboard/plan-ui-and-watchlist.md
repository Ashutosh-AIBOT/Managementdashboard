# Slack Dashboard — Watch List, Hourly Sync & AI Digests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the finished Slack Dashboard visible in the app, let the operator choose which channels of each workspace are read, sync them on an hourly stagger, and append a daily AI digest per channel.

**Architecture:** The main process already fetches, stores, prunes and labels Slack data (Tasks 1–7, 236 tests green). Nothing there changes shape except two additive fields on the persisted model and a per-workspace channel filter. All new decision logic — slot assignment, watch-list selection, AI state classification, sentiment trend, sparkline series — lives as pure functions in `src/shared/dashboard-view.ts`, which every process can import and vitest can test without Electron or a DOM.

**Tech Stack:** Electron + React 18 + TypeScript (strict), zustand for renderer state, vitest (node env, `tests/unit/**/*.test.ts` only), plain CSS in `src/renderer/src/assets/main.css`.

**Spec:** `/home/creator/.opencode/plan/slack-hourly-30-workspaces.md` (operating design), `/home/creator/.opencode/plan/slack-polling-archive-and-cost.md` (cost model), `/home/creator/.opencode/plan/slack-private-channels-and-ai-summary.md` (access rules). This plan implements them.

## Global Constraints

- **Never modify `src/main/profiles/session-partition.ts` semantics.** The `persist:profile-<id>-<appId>` invariant is unchanged by this plan.
- **Scopes stay exactly as they are.** `USER_SCOPES` in `src/main/slack/oauth-flow.ts` remains `channels:read, channels:history, groups:read, groups:history, team:read, users:read`. The operator has explicitly declined `reactions:read` and `pins:read`. Do not add scopes.
- **Key everything by `teamId`, never `teamName`.** Two workspaces may share a display name.
- **Derived fields are never persisted.** Anything computable from the stored window is computed at read time in `buildSnapshot`, exactly as `aiConfigured` / `aiEligible` / `aiAnalyzed` already are (`src/shared/types.ts:168-176`). Only `watchedChannelIds` and `summaries` are new persisted fields.
- **Degraded AI is normal.** `0 < aiAnalyzed < aiEligible` must never render as an error.
- **No npm.** `npm` is booby-trapped on this host. Every command below uses `node node_modules/…` directly.
- **Target platform is Linux.** No macOS-only APIs.
- **Test scope is `tests/unit/**/*.test.ts` in a `node` environment.** No `.tsx` tests exist and none may be added. Any logic worth testing must therefore live in a `.ts` module — which is why the pure logic goes in `src/shared/dashboard-view.ts` and the React component stays a thin rendering shell.
- **One `DashboardStore` instance** is shared by the sync engine and the IPC handlers. Two instances on one path race.
- **AI calls are best-effort.** An AI failure degrades the dashboard; it must never fail a sync.

### Verification commands (run after every task)

```bash
node node_modules/eslint/bin/eslint.js .
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
node node_modules/vitest/vitest.mjs run
```

## Review Focus

The five failure modes most likely to bite a person using this. Each gets a test in the task that owns the code.

1. **A workspace is renamed or a second workspace shares its display name.** The dashboard must still list, sync and label each independently. Everything is keyed by `teamId`; nothing may key on `teamName`.
2. **The operator closes the laptop mid-cycle, or quits during a 40-channel walk.** Already-synced channels must stay on disk, the failing channel must keep its old cursor, and the next run must resume rather than restart.
3. **A channel in the watch list is archived, deleted, or the user loses access to it.** `channel_not_found` must be skipped and reported per channel; it must never wedge the whole workspace or abort the cycle.
4. **A channel has a large `totalMessages` but an empty 90-day window** (long-idle channel). It must render as idle, never as "0 messages" or broken.
5. **The person who connected a client workspace leaves it.** Slack auto-uninstalls the app, the token dies, and the dashboard would otherwise silently stop refreshing forever. Must surface as an explicit reconnect prompt for that workspace.

---

## File Structure

**New files**

| Path | Responsibility |
| --- | --- |
| `src/shared/dashboard-view.ts` | Every pure dashboard decision: AI-state classification, sentiment trend, sparkline series, workspace ordering, watch-list toggle/auto-pick, relative time. Imports only `src/shared/types.ts`. No process, no Electron, no React. |
| `src/main/slack/summarizer.ts` | Turns a workspace's watched channels + stored window into one `ChannelSummaryBody` per channel, in one request. Owns the `SummaryProvider` interface and the OpenAI implementation. |
| `src/renderer/src/hooks/useDashboard.ts` | zustand store over the six existing `window.api.slackDashboard` channels. Holds the snapshot, the progress tick, and the reconnect banner. All logic delegated to `dashboard-view.ts`. |
| `src/renderer/src/components/SlackDashboard.tsx` | Pure rendering: workspace list, channel rows, sparkline, sentiment bar, digest list, watch-list picker. No IPC, no store logic. |
| `tests/unit/dashboard-view.test.ts` | Covers all five Review Focus items that belong to pure logic. |
| `tests/unit/dashboard-scheduler.test.ts` | Slot assignment and due-this-minute selection. |
| `tests/unit/summarizer.test.ts` | Summary request shape, malformed-reply handling, key-collision rejection. |
| `tests/unit/dashboard-store-v2.test.ts` | v1→v2 migration and normalizer. |
| `tests/unit/sync-engine-watchlist.test.ts` | Watch-list filtering and `channel_not_found` tolerance. |
| `tests/unit/dashboard-watchlist-ipc.test.ts` | The new set-watched-channels channel. |

**Modified files**

| Path | Change |
| --- | --- |
| `src/shared/types.ts` | `WorkspaceRollup.watchedChannelIds?`, `ChannelRollup.summaries?`, `ChannelSummary`, `DashboardChannel.sentimentTrend` + `.dailySeries`, new payload/result types. |
| `src/main/slack/dashboard-store.ts` | `DASHBOARD_VERSION` 1→2, v1 migration, normalizer branches for the two new fields. |
| `src/main/slack/sync-engine.ts` | Filter channels by the watch list; tolerate `channel_not_found`; auto-pick on first sync. |
| `src/main/slack/ai-analyzer.ts` | No behavioural change. `AiAnalyzer` gains an optional `summarizeChannel` passthrough. |
| `src/main/ipc/slack-dashboard.ipc.ts` | `buildSnapshot` derives the trend and series; scheduler becomes hourly + staggered; daily summarisation; new `set-watched-channels` handler. |
| `src/shared/ipc-contract.ts` | Two new channel constants, four new `IpcApi` methods. |
| `src/preload/index.ts` | Bridge the two new channels. |
| `src/main/index.ts` | Pass the summarizer into `registerSlackDashboardIpc`; start the one-minute scheduler. |
| `src/renderer/src/App.tsx` | `dashboardOpen` state, `showEmbed` negation, mount, Escape rung, ⌘D. |
| `src/renderer/src/components/ProfileSidebar.tsx` | One new nav entry + `onOpenDashboard` prop. |
| `src/renderer/src/assets/main.css` | All new classes, using the existing token set. |

**Unchanged on purpose:** `slack-api-client.ts` (already sends `types: 'public_channel,private_channel'` and already pages with `oldest`), `oauth-flow.ts` (scopes frozen), `session-partition.ts`.

---

### Task 8: Pure dashboard view-model

**Files:**
- Create: `src/shared/dashboard-view.ts`
- Test: `tests/unit/dashboard-view.test.ts`

**Interfaces:**
- Consumes: `DashboardChannel`, `DashboardMessage`, `DashboardWorkspace`, `WorkspaceRollup`, `Sentiment` from `src/shared/types.ts` (all already exist).
- Produces: every symbol listed in the implementation below. Tasks 9, 12, 17 and 18 all import from here.

```ts
import type { DashboardChannel, DashboardMessage, WorkspaceRollup } from './types'

export type AiState = 'unavailable' | 'empty' | 'failing' | 'degraded' | 'healthy'

export interface TrendPoint {
  /** UTC YYYY-MM-DD */
  date: string
  /** Mean score for the day, -1..1. */
  score: number
  /** Messages that carried a label that day. */
  count: number
}

export function utcDay(ts: string): string
export function channelAiState(c: DashboardChannel): AiState
export function sentimentTrend(messages: DashboardMessage[], days?: number): TrendPoint[]
export function dailySeries(dailyCounts: Record<string, number>, days: number, now?: Date): number[]
export function orderWorkspaces<T extends WorkspaceRollup>(ws: Record<string, T>): Array<[string, T]>
export function isWatched(ids: string[] | undefined, channelId: string): boolean
export function effectiveWatched(ids: string[] | undefined, allChannelIds: string[]): string[]
export function toggleWatched(ids: string[] | undefined, channelId: string): string[]
export function selectWatchedChannels<T extends { channelId: string; totalMessages: number }>(
  candidates: T[],
  limit: number
): string[]
export function relativeTime(iso: string | undefined, now: number): string
```

**Behaviour contracts — these are the tests**

- `channelAiState` implements the five-row table in `src/shared/types.ts:185-191` exactly. `degraded` is a normal state and is never folded into `failing`.
- `effectiveWatched(undefined, all)` returns `all`. This is the v1→v2 back-compat rule: a workspace synced before the watch list existed is fully watched until the operator narrows it.
- `selectWatchedChannels` returns ids sorted by `totalMessages` descending, ties broken by `channelId` ascending so the choice is deterministic across runs. `limit <= 0` returns `[]`.
- `relativeTime(undefined, now)` returns `'never'`. Anything under 60s returns `'just now'`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/dashboard-view.test.ts
import { describe, expect, it } from 'vitest'
import {
  channelAiState,
  dailySeries,
  effectiveWatched,
  orderWorkspaces,
  relativeTime,
  selectWatchedChannels,
  sentimentTrend,
  toggleWatched,
  utcDay
} from '../../src/shared/dashboard-view'
import type { DashboardChannel, DashboardMessage, WorkspaceRollup } from '../../src/shared/types'

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0) // 2026-10-12T12:00:00Z

function channel(over: Partial<DashboardChannel> = {}): DashboardChannel {
  return {
    channelId: 'C01',
    channelName: 'general',
    isPrivate: false,
    totalMessages: 0,
    dailyCounts: {},
    recentMessages: [],
    aiConfigured: true,
    aiEligible: 0,
    aiAnalyzed: 0,
    ...over
  }
}

function message(ts: string, sentiment?: 'positive' | 'neutral' | 'negative'): DashboardMessage {
  return { ts, text: 'x', ...(sentiment ? { sentiment } : {}) }
}

describe('utcDay', () => {
  it('keys by UTC, not local time', () => {
    expect(utcDay('1728739200.000100')).toBe('2026-10-12')
  })
})

describe('channelAiState', () => {
  it('reports unavailable when no provider is wired, regardless of counts', () => {
    expect(channelAiState(channel({ aiConfigured: false, aiEligible: 12, aiAnalyzed: 12 }))).toBe(
      'unavailable'
    )
  })

  it('reports empty when there is nothing to analyse', () => {
    expect(channelAiState(channel({ aiEligible: 0 }))).toBe('empty')
  })

  it('reports failing only when every eligible message came back unlabelled', () => {
    expect(channelAiState(channel({ aiEligible: 5, aiAnalyzed: 0 }))).toBe('failing')
  })

  // Review Focus: degraded is normal and must never read as an error.
  it('reports degraded for a partial result rather than failing', () => {
    expect(channelAiState(channel({ aiEligible: 5, aiAnalyzed: 3 }))).toBe('degraded')
  })

  it('reports healthy once every eligible message is labelled', () => {
    expect(channelAiState(channel({ aiEligible: 5, aiAnalyzed: 5 }))).toBe('healthy')
  })

  it('never reports healthy when a provider is absent and nothing is labelled', () => {
    expect(channelAiState(channel({ aiConfigured: false, aiEligible: 0, aiAnalyzed: 0 }))).toBe(
      'unavailable'
    )
  })
})

describe('sentimentTrend', () => {
  it('groups labelled messages into UTC days', () => {
    const trend = sentimentTrend([
      message('1728739200.000100', 'positive'),
      message('1728739260.000200', 'negative'),
      message('1728642000.000300', 'neutral')
    ])
    expect(trend).toHaveLength(2)
    expect(trend[0]).toEqual({ date: '2026-10-11', score: 0, count: 1 })
  })

  it('omits days with no labelled messages instead of emitting zero-score points', () => {
    const trend = sentimentTrend([message('1728739200.000100', 'positive')], 30)
    expect(trend).toHaveLength(1)
  })

  it('returns an empty trend for an empty window', () => {
    expect(sentimentTrend([])).toEqual([])
  })
})

describe('dailySeries', () => {
  it('returns exactly `days` points ending today, zero-filled', () => {
    const series = dailySeries({ '2026-10-12': 4 }, 3, new Date(NOW))
    expect(series).toEqual([0, 0, 4])
  })

  it('ignores days outside the window', () => {
    const series = dailySeries({ '2026-01-01': 99 }, 3, new Date(NOW))
    expect(series).toEqual([0, 0, 0])
  })
})

describe('orderWorkspaces', () => {
  // Review Focus: two workspaces may share a display name.
  it('sorts by teamName then teamId, so shared names stay in a stable order', () => {
    const ws: Record<string, WorkspaceRollup> = {
      T_B: {
        teamId: 'T_B',
        teamName: 'Acme',
        profileId: 'p1',
        lastSyncAt: '',
        channels: {}
      },
      T_A: {
        teamId: 'T_A',
        teamName: 'Acme',
        profileId: 'p1',
        lastSyncAt: '',
        channels: {}
      },
      T_C: {
        teamId: 'T_C',
        teamName: 'Zeta',
        profileId: 'p1',
        lastSyncAt: '',
        channels: {}
      }
    }
    expect(orderWorkspaces(ws).map(([id]) => id)).toEqual(['T_A', 'T_B', 'T_C'])
  })
})

describe('watch list', () => {
  it('treats an absent list as fully watched, so pre-v2 data keeps syncing', () => {
    expect(effectiveWatched(undefined, ['C01', 'C02'])).toEqual(['C01', 'C02'])
  })

  it('treats an empty list as watching nothing', () => {
    expect(effectiveWatched([], ['C01'])).toEqual([])
  })

  it('drops watched ids that no longer exist rather than reporting them', () => {
    expect(effectiveWatched(['C01', 'GONE'], ['C01', 'C02'])).toEqual(['C01'])
  })

  it('toggles on and off without mutating the input', () => {
    const before = ['C01']
    expect(toggleWatched(before, 'C02')).toEqual(['C01', 'C02'])
    expect(toggleWatched(['C01', 'C02'], 'C02')).toEqual(['C01'])
    expect(before).toEqual(['C01'])
  })

  it('picks the busiest channels deterministically', () => {
    const picked = selectWatchedChannels(
      [
        { channelId: 'C_B', totalMessages: 10 },
        { channelId: 'C_A', totalMessages: 10 },
        { channelId: 'C_C', totalMessages: 99 }
      ],
      2
    )
    expect(picked).toEqual(['C_C', 'C_A'])
  })

  it('picks nothing when the limit is zero or negative', () => {
    expect(selectWatchedChannels([{ channelId: 'C_A', totalMessages: 1 }], 0)).toEqual([])
    expect(selectWatchedChannels([{ channelId: 'C_A', totalMessages: 1 }], -1)).toEqual([])
  })
})

describe('relativeTime', () => {
  it('reports never for an absent timestamp', () => {
    expect(relativeTime(undefined, NOW)).toBe('never')
  })

  it('collapses anything under a minute to just now', () => {
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now')
  })

  it('reports minutes, hours and days', () => {
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m ago')
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h ago')
    expect(relativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2d ago')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node node_modules/vitest/vitest.mjs run tests/unit/dashboard-view.test.ts
```
Expected: FAIL — `Cannot find module '../../src/shared/dashboard-view'`

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/dashboard-view.ts
import type { DashboardChannel, DashboardMessage, WorkspaceRollup } from './types'

export type AiState = 'unavailable' | 'empty' | 'failing' | 'degraded' | 'healthy'

export interface TrendPoint {
  /** UTC YYYY-MM-DD */
  date: string
  /** Mean score for the day, -1..1. */
  score: number
  /** Messages that carried a label that day. */
  count: number
}

const DAY_MS = 86_400_000
const SENTIMENT_SCORE: Record<'positive' | 'neutral' | 'negative', number> = {
  positive: 1,
  neutral: 0,
  negative: -1
}

/** UTC day key for a Slack `ts` (seconds with a fractional part). */
export function utcDay(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10)
}

/**
 * The five AI states, in the order the table on `ChannelAiStatus` gives them.
 *
 * `degraded` is a first-class outcome, not a soft failure: a provider may omit
 * rows, so `aiAnalyzed` legitimately sits between 0 and `aiEligible` on a
 * healthy system. Collapsing it into `failing` is what makes a working
 * integration look broken.
 */
export function channelAiState(c: DashboardChannel): AiState {
  if (!c.aiConfigured) return 'unavailable'
  if (c.aiEligible === 0) return 'empty'
  if (c.aiAnalyzed === 0) return 'failing'
  if (c.aiAnalyzed < c.aiEligible) return 'degraded'
  return 'healthy'
}

/**
 * Per-day sentiment, derived from the stored window rather than persisted.
 *
 * Days with no labelled message are omitted rather than emitted as score 0 —
 * a zero-score day and a silent day are different facts and a sparkline drawn
 * from them would be lying.
 */
export function sentimentTrend(messages: DashboardMessage[], days = 90): TrendPoint[] {
  const cutoff = Date.now() - days * DAY_MS
  const buckets = new Map<string, { sum: number; count: number }>()
  for (const m of messages) {
    if (!m.sentiment) continue
    const at = Number(m.ts) * 1000
    if (!Number.isFinite(at) || at < cutoff) continue
    const day = utcDay(m.ts)
    const b = buckets.get(day) ?? { sum: 0, count: 0 }
    b.sum += SENTIMENT_SCORE[m.sentiment]
    b.count += 1
    buckets.set(day, b)
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, b]) => ({
      date,
      score: Math.round((b.sum / b.count) * 1000) / 1000,
      count: b.count
    }))
}

/** Fixed-width, zero-filled, oldest-first series ending today — sparkline input. */
export function dailySeries(
  dailyCounts: Record<string, number>,
  days: number,
  now: Date = new Date()
): number[] {
  const out: number[] = new Array(Math.max(0, days)).fill(0)
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  for (let i = 0; i < out.length; i++) {
    const key = new Date(today - (out.length - 1 - i) * DAY_MS).toISOString().slice(0, 10)
    out[i] = dailyCounts[key] ?? 0
  }
  return out
}

/** Sort by display name, tie-broken by `teamId` so shared names stay stable. */
export function orderWorkspaces<T extends WorkspaceRollup>(
  ws: Record<string, T>
): Array<[string, T]> {
  return Object.entries(ws).sort(([, a], [, b]) =>
    a.teamName === b.teamName ? (a.teamId < b.teamId ? -1 : 1) : a.teamName.localeCompare(b.teamName)
  )
}

/** An absent list means "everything", which is how pre-v2 workspaces keep syncing. */
export function effectiveWatched(ids: string[] | undefined, allChannelIds: string[]): string[] {
  if (ids === undefined) return allChannelIds
  const known = new Set(allChannelIds)
  return ids.filter((id) => known.has(id))
}

export function toggleWatched(ids: string[] | undefined, channelId: string): string[] {
  const current = ids ?? []
  return current.includes(channelId)
    ? current.filter((id) => id !== channelId)
    : [...current, channelId]
}

/**
 * The busiest `limit` channels, deterministic across runs.
 *
 * Volume is a proxy, not the answer — `#random` outranks `#client-escalations`
 * on message count alone — which is why the dashboard also lets the operator
 * override this by hand.
 */
export function selectWatchedChannels<T extends { channelId: string; totalMessages: number }>(
  candidates: T[],
  limit: number
): string[] {
  if (limit <= 0) return []
  return [...candidates]
    .sort((a, b) =>
      b.totalMessages !== a.totalMessages
        ? b.totalMessages - a.totalMessages
        : a.channelId.localeCompare(b.channelId)
    )
    .slice(0, limit)
    .map((c) => c.channelId)
}

export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return 'never'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 'never'
  const secs = Math.floor((now - at) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < DAY_MS / 1000) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86_400)}d ago`
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node node_modules/vitest/vitest.mjs run tests/unit/dashboard-view.test.ts
```
Expected: PASS — 22 tests

- [ ] **Step 5: Commit**

```bash
git add src/shared/dashboard-view.ts tests/unit/dashboard-view.test.ts
git commit -m "feat(dashboard): pure view-model for AI state, trends and the watch list"
```

---

### Task 9: Derive trend and series into the snapshot

**Files:**
- Modify: `src/shared/types.ts` (extend `DashboardChannel`)
- Modify: `src/main/ipc/slack-dashboard.ipc.ts:322-349` (`buildSnapshot`)
- Test: `tests/unit/dashboard-ipc-contract.test.ts` (extend)

**Interfaces:**
- Consumes: `sentimentTrend`, `dailySeries` from `src/shared/dashboard-view.ts` (Task 8).
- Produces: `DashboardChannel.sentimentTrend` and `.dailySeries`, consumed by Task 18.

- [ ] **Step 1: Extend `DashboardChannel` in `src/shared/types.ts`**

```ts
/** A stored channel plus its derived AI status. */
export type DashboardChannel = ChannelRollup & ChannelAiStatus & {
  /** Per-day sentiment over the 90-day window. Days with no labels are omitted. */
  sentimentTrend: import('./dashboard-view').TrendPoint[]
  /** Oldest-first, zero-filled, `TREND_DAYS` long. Sparkline input. */
  dailySeries: number[]
}
```

Add next to it:

```ts
/** Width of both derived series. Matches `MESSAGE_RETENTION_DAYS` in the store. */
export const TREND_DAYS = 90
```

- [ ] **Step 2: Write the failing test**

**Add this test INSIDE `tests/unit/dashboard-ipc-contract.test.ts`**, in the same
`describe` block as the other `slack-dashboard:get` tests. That file already mocks
`../../src/main/ipc/handle` into an `ipcHandlers` map and exposes a local deps factory
and a `seedWorkspace` helper — reuse them rather than writing a second harness.

Use that file's existing harness names (`harness`, its `invoke`/handler map, and its
`seedWorkspace`) exactly as the surrounding tests use them; the snippet below is the
assertion to add, not a standalone file:

```ts
it('derives a trend and a zero-filled series without persisting either', async () => {
  const snapshot = await getSnapshot()
  const ch = snapshot.workspaces.T1.channels.C1
  expect(ch.dailySeries).toHaveLength(TREND_DAYS)
  expect(ch.sentimentTrend.every((p) => p.count > 0)).toBe(true)
  // The persisted file must not have gained either field.
  const raw = JSON.parse(await readFile(harness.store.filePath, 'utf8'))
  expect(raw.workspaces.T1.channels.C1.sentimentTrend).toBeUndefined()
  expect(raw.workspaces.T1.channels.C1.dailySeries).toBeUndefined()
})
```

If `DashboardStore.filePath` is private, read the path from the harness's own seed
setup instead — the existing file already knows it. Do not widen `DashboardStore`'s
visibility for a test.

- [ ] **Step 3: Run the test to verify it fails**

Expected: FAIL — `ch.dailySeries` is `undefined`.

- [ ] **Step 4: Wire the derivation into `buildSnapshot`**

In `src/main/ipc/slack-dashboard.ipc.ts`, add to the imports:

```ts
import { dailySeries, sentimentTrend } from '../../shared/dashboard-view'
```

and replace the channel-spread line inside `buildSnapshot`:

```ts
      channels[channelId] = {
        ...channel,
        aiConfigured,
        aiEligible,
        aiAnalyzed,
        sentimentTrend: sentimentTrend(channel.recentMessages),
        dailySeries: dailySeries(channel.dailyCounts)
      }
```

- [ ] **Step 5: Run the full suite**

```bash
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
```
Expected: all PASS. The web typecheck matters — `App.tsx` consumes `DashboardSnapshot` and a widened `DashboardChannel` can surface a new required-field error there.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/ipc/slack-dashboard.ipc.ts tests/unit/dashboard-ipc-contract.test.ts
git commit -m "feat(dashboard): derive sentiment trend and daily series at read time"
```

---

### Task 10: Persisted model v2 — watch list and summaries

**Files:**
- Modify: `src/shared/types.ts:139-166`
- Modify: `src/main/slack/dashboard-store.ts:23`, the normalizer, and the reader
- Test: `tests/unit/dashboard-store-v2.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `WorkspaceRollup.watchedChannelIds?: string[]`, `ChannelRollup.summaries?: ChannelSummary[]`, `ChannelSummary`, `DASHBOARD_VERSION === 2`. Consumed by Tasks 11, 12, 14, 15, 16.

- [ ] **Step 1: Add the types to `src/shared/types.ts`**

Insert above `ChannelRollup`:

```ts
/** One point extracted from a channel digest. */
export interface ChannelSummaryPoint {
  kind: 'blocker' | 'decision' | 'deadline' | 'owner' | 'question' | 'risk'
  text: string
  /** Slack `ts` when the point is attributable to one message. */
  ts?: string
}

/**
 * One day's digest for one channel.
 *
 * Append-only: today's digest is added, yesterday's is never rewritten. That is
 * the whole point of storing a log — overwriting would leave the dashboard with
 * no history to show movement against, which is the only reason to keep it.
 */
export interface ChannelSummary {
  /** UTC YYYY-MM-DD. One summary per channel per day; the key that makes a second run a no-op. */
  date: string
  text: string
  points: ChannelSummaryPoint[]
  generatedAt: string
  model: string
}
```

Then extend `ChannelRollup`:

```ts
  sentimentScore?: number
  completionEstimate?: number
  /** Append-only daily digests, oldest first. Capped at `SUMMARY_HISTORY_LIMIT`. */
  summaries?: ChannelSummary[]
```

and `WorkspaceRollup`:

```ts
export interface WorkspaceRollup {
  teamId: string
  teamName: string
  profileId: string
  lastSyncAt: string
  channels: Record<string, ChannelRollup>
  /**
   * Channel ids to read. `undefined` means every channel — the shape a file
   * written before v2 has, and the reason a pre-existing workspace keeps
   * syncing instead of silently going quiet after an upgrade.
   */
  watchedChannelIds?: string[]
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/dashboard-store-v2.test.ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DashboardStore, DASHBOARD_VERSION } from '../../src/main/slack/dashboard-store'

const V1_FILE = {
  version: 1,
  workspaces: {
    T1: {
      teamId: 'T1',
      teamName: 'Acme',
      profileId: 'p1',
      lastSyncAt: '2026-10-01T00:00:00.000Z',
      channels: {
        C1: {
          channelId: 'C1',
          channelName: 'general',
          isPrivate: false,
          totalMessages: 12,
          dailyCounts: { '2026-10-01': 12 },
          recentMessages: [{ ts: '1.1', text: 'hi' }]
        }
      }
    }
  }
}

describe('DashboardStore v2', () => {
  it('bumps the version constant to 2', () => {
    expect(DASHBOARD_VERSION).toBe(2)
  })

  it('reads a v1 file without migrating it destructively', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dash-v2-'))
    const file = join(dir, 'dashboard.json')
    await writeFile(file, JSON.stringify(V1_FILE))
    const store = new DashboardStore({ filePath: file })
    const read = await store.read()
    expect(read.workspaces.T1.channels.C1.totalMessages).toBe(12)
    // Absent, not `[]` — an empty array would mean "watching nothing".
    expect(read.workspaces.T1.watchedChannelIds).toBeUndefined()
  })

  it('rejects a channel whose summaries are not an array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dash-v2-'))
    const file = join(dir, 'dashboard.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        workspaces: {
          T1: {
            ...V1_FILE.workspaces.T1,
            channels: {
              C1: { ...V1_FILE.workspaces.T1.channels.C1, summaries: 'nope' }
            }
          }
        }
      })
    )
    const store = new DashboardStore({ filePath: file })
    expect((await store.read()).workspaces.T1.channels.C1.summaries).toBeUndefined()
  })

  it('drops a summary whose points are not an array of well-formed points', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dash-v2-'))
    const file = join(dir, 'dashboard.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        workspaces: {
          T1: {
            ...V1_FILE.workspaces.T1,
            channels: {
              C1: {
                ...V1_FILE.workspaces.T1.channels.C1,
                summaries: [{ date: '2026-10-11', text: 'ok', points: 'bad', generatedAt: '', model: '' }]
              }
            }
          }
        }
      })
    )
    const store = new DashboardStore({ filePath: file })
    expect((await store.read()).workspaces.T1.channels.C1.summaries).toEqual([])
  })
})
```

- [ ] **Step 2b: Run the test to verify it fails**

```bash
node node_modules/vitest/vitest.mjs run tests/unit/dashboard-store-v2.test.ts
```
Expected: FAIL — `DASHBOARD_VERSION` is `1`, and the two malformed-field cases are unnormalised.

- [ ] **Step 3: Bump the version and add the normalizer branches**

In `src/main/slack/dashboard-store.ts`, change line 23:

```ts
export const DASHBOARD_VERSION = 2
```

Add beside `MESSAGE_RETENTION_DAYS`:

```ts
/**
 * How many daily digests a channel keeps.
 *
 * 90 entries at ~1 KB is ~90 KB per channel — nothing. The cap exists so a
 * daily job that fails to respect the one-per-day key cannot grow the file
 * without bound.
 */
export const SUMMARY_HISTORY_LIMIT = 90
```

Add a normalizer matching the file's existing style (a `string[]`/array-of-objects guard, unknown → `undefined`):

```ts
const SUMMARY_KINDS = new Set([
  'blocker',
  'decision',
  'deadline',
  'owner',
  'question',
  'risk'
])

function normalizeSummaries(raw: unknown): ChannelSummary[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ChannelSummary[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const date = typeof rec.date === 'string' ? rec.date : ''
    const text = typeof rec.text === 'string' ? rec.text : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || text.trim() === '') continue
    const points: ChannelSummaryPoint[] = []
    if (Array.isArray(rec.points)) {
      for (const p of rec.points) {
        if (!p || typeof p !== 'object') continue
        const pr = p as Record<string, unknown>
        if (typeof pr.kind !== 'string' || !SUMMARY_KINDS.has(pr.kind)) continue
        const pt = typeof pr.text === 'string' ? pr.text.trim() : ''
        if (pt === '') continue
        points.push({
          kind: pr.kind as ChannelSummaryPoint['kind'],
          text: pt,
          ...(typeof pr.ts === 'string' ? { ts: pr.ts } : {})
        })
      }
    }
    out.push({
      date,
      text,
      points,
      generatedAt: typeof rec.generatedAt === 'string' ? rec.generatedAt : '',
      model: typeof rec.model === 'string' ? rec.model : ''
    })
  }
  return out.slice(-SUMMARY_HISTORY_LIMIT)
}

function normalizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((v): v is string => typeof v === 'string' && v !== '')
}
```

Wire them into the existing channel normalizer (where `sentimentScore` is read):

```ts
      ...(sentimentScore !== undefined ? { sentimentScore } : {}),
      ...(summaries !== undefined ? { summaries } : {})
```

and into the workspace normalizer:

```ts
    ...(watchedChannelIds !== undefined ? { watchedChannelIds } : {})
```

Add `ChannelSummary` and `ChannelSummaryPoint` to the `export type { … } from '../../shared/types'` block already at the top of the file, and import `SUMMARY_HISTORY_LIMIT`'s consumers. Confirm `DASHBOARD_VERSION` is only ever written, never compared — a v1 file must load unchanged, which is what the "reads a v1 file" test pins.

- [ ] **Step 4: Run the test to verify it passes**

Expected: PASS — 4 tests.

- [ ] **Step 5: Run the whole verification set, then commit**

```bash
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
git add src/shared/types.ts src/main/slack/dashboard-store.ts tests/unit/dashboard-store-v2.test.ts
git commit -m "feat(dashboard): persist v2 model with a channel watch list and digest log"
```

---

### Task 11: Sync engine honours the watch list

**Files:**
- Modify: `src/main/slack/sync-engine.ts` (the `walk` method's channel loop)
- Test: `tests/unit/sync-engine-watchlist.test.ts` (create)

**Interfaces:**
- Consumes: `effectiveWatched` from `src/shared/dashboard-view.ts`; `WorkspaceRollup.watchedChannelIds` from Task 10.
- Produces: the walk skipping unwatched channels and surviving `channel_not_found`. No new exported symbols.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/sync-engine-watchlist.test.ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine } from '../../src/main/slack/sync-engine'
import { DashboardStore } from '../../src/main/slack/dashboard-store'
import type { ChannelRollup } from '../../src/shared/types'

const listChannels = vi.fn()
const listMessages = vi.fn()

vi.mock('../../src/main/slack/slack-api-client', () => ({
  listChannels: (...args: unknown[]) => listChannels(...args),
  listMessages: (...args: unknown[]) => listMessages(...args)
}))

function slackError(code: string): Error {
  return Object.assign(new Error(`slack: ${code}`), { data: { error: code } })
}

beforeEach(() => {
  listChannels.mockReset()
  listMessages.mockReset()
})

/**
 * `DashboardStoreOptions` is `{ filePath }` and nothing else — there is no
 * constructor seed. Seed through the public API: `upsertWorkspace` to create the
 * workspace, then `update` to place channels and the watch list.
 */
async function engineFor(seed: (store: DashboardStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'watchlist-'))
  const store = new DashboardStore({ filePath: join(dir, 'dashboard.json') })
  await store.upsertWorkspace({ teamId: 'T1', teamName: 'Acme', profileId: 'p' })
  await seed(store)
  const tokenStore = { tryGet: vi.fn().mockResolvedValue('xoxp-test') }
  const engine = new SyncEngine({ tokenStore, dashboardStore: store })
  return { store, engine }
}

function blankChannel(channelId: string): ChannelRollup {
  return {
    channelId,
    channelName: channelId.toLowerCase(),
    isPrivate: false,
    totalMessages: 0,
    dailyCounts: {},
    recentMessages: []
  }
}

describe('watch list filtering', () => {
  it('walks every channel when the watch list is absent', async () => {
    const { engine } = await engineFor(async (store) => {
      await store.update((f) => {
        f.workspaces.T1.channels.C1 = blankChannel('C1')
        f.workspaces.T1.channels.C2 = blankChannel('C2')
      })
    })
    listChannels.mockResolvedValue([
      { id: 'C1', name: 'a', isPrivate: false },
      { id: 'C2', name: 'b', isPrivate: false }
    ])
    listMessages.mockResolvedValue([])
    const result = await engine.syncWorkspace({ profileId: 'p', teamId: 'T1', teamName: 'Acme' })
    expect(result.channelsSynced).toBe(2)
  })

  it('walks only the watched channels when the list is present', async () => {
    const { engine } = await engineFor(async (store) => {
      await store.update((f) => {
        f.workspaces.T1.channels.C1 = blankChannel('C1')
        f.workspaces.T1.channels.C2 = blankChannel('C2')
        f.workspaces.T1.watchedChannelIds = ['C1']
      })
    })
    listChannels.mockResolvedValue([
      { id: 'C1', name: 'a', isPrivate: false },
      { id: 'C2', name: 'b', isPrivate: false }
    ])
    listMessages.mockResolvedValue([])
    const result = await engine.syncWorkspace({ profileId: 'p', teamId: 'T1', teamName: 'Acme' })
    expect(result.channelsSynced).toBe(1)
  })

  it('treats an empty watch list as watching nothing and reports zero channels', async () => {
    const { engine } = await engineFor(async (store) => {
      await store.update((f) => {
        f.workspaces.T1.channels.C1 = blankChannel('C1')
        f.workspaces.T1.watchedChannelIds = []
      })
    })
    listChannels.mockResolvedValue([{ id: 'C1', name: 'a', isPrivate: false }])
    listMessages.mockResolvedValue([])
    const result = await engine.syncWorkspace({ profileId: 'p', teamId: 'T1', teamName: 'Acme' })
    expect(result.channelsSynced).toBe(0)
  })
})
```

**The `vi.mock` block and `slackError` go at the TOP of the file, before the helpers**
(the mock is hoisted; putting it mid-file reads as though order matters). Then add
`beforeEach` resetting both mocks so no case leaks into the next:

```ts
beforeEach(() => {
  listChannels.mockReset()
  listMessages.mockReset()
})
```

Then the case itself — inside the same `describe('watch list filtering')` block:

```ts
// Review Focus: a watched channel that vanished must not wedge the workspace.
it('skips a channel that no longer exists, still records the rest, and unwatches it', async () => {
  const { engine, store } = await engineFor(async (s) => {
    await s.update((f) => {
      f.workspaces.T1.channels.C_GONE = {
        ...blankChannel('C_GONE'),
        lastSyncTs: '100.1',
        totalMessages: 5
      }
      f.workspaces.T1.channels.C_OK = blankChannel('C_OK')
      f.workspaces.T1.watchedChannelIds = ['C_GONE', 'C_OK']
    })
  })
  listChannels.mockResolvedValue([
    { id: 'C_GONE', name: 'archived', isPrivate: false },
    { id: 'C_OK', name: 'live', isPrivate: false }
  ])
  listMessages.mockImplementation((_t: string, channelId: string) =>
    channelId === 'C_GONE'
      ? Promise.reject(slackError('channel_not_found'))
      : Promise.resolve([{ ts: '200.1', text: 'hello' }])
  )

  const result = await engine.syncWorkspace({ profileId: 'p', teamId: 'T1', teamName: 'Acme' })

  expect(result.messagesRead).toBe(1)
  const after = (await store.read()).workspaces.T1
  expect(after.channels.C_OK.totalMessages).toBe(1)
  // The vanished channel keeps the cursor it had — a failed fetch must never
  // advance it, or the next run would skip messages it never read.
  expect(after.channels.C_GONE.lastSyncTs).toBe('100.1')
  expect(after.watchedChannelIds).toEqual(['C_OK'])
})

it('lets a non-gone Slack failure abort the walk rather than silently dropping a channel', async () => {
  const { engine } = await engineFor(async (s) => {
    await s.update((f) => {
      f.workspaces.T1.channels.C1 = blankChannel('C1')
      f.workspaces.T1.watchedChannelIds = ['C1']
    })
  })
  listChannels.mockResolvedValue([{ id: 'C1', name: 'a', isPrivate: false }])
  listMessages.mockRejectedValue(slackError('internal_error'))
  await expect(
    engine.syncWorkspace({ profileId: 'p', teamId: 'T1', teamName: 'Acme' })
  ).rejects.toThrow()
})
```

Reset both mocks in a `beforeEach` so the ordering between these two cases cannot leak.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node node_modules/vitest/vitest.mjs run tests/unit/sync-engine-watchlist.test.ts
```
Expected: the `watchedChannelIds` cases FAIL — the walk currently reads every channel.

- [ ] **Step 3: Filter the walk**

In `src/main/slack/sync-engine.ts`, import:

```ts
import { effectiveWatched } from '../../shared/dashboard-view'
```

Inside `walk`, where the channel list is built from `listChannels`, replace it with:

```ts
    const stored = (await this.dashboardStore.read()).workspaces[input.teamId]
    const listed = await listChannels(token)
    const watched = new Set(
      effectiveWatched(stored?.watchedChannelIds, listed.map((c) => c.id))
    )
    const channels = listed.filter((c) => watched.has(c.id))
```

Progress reporting must use `channels.length`, not `listed.length`, or the bar will stop short.

**Review Focus — the vanished channel.** Wrap the per-channel history fetch so `channel_not_found` skips rather than aborts:

```ts
const CHANNEL_GONE_CODES = new Set(['channel_not_found', 'is_archived'])

/** true when the failure means "this channel is gone", not "this walk failed". */
export function isChannelGoneError(err: unknown): boolean {
  const data = (err as { data?: { error?: unknown } } | undefined)?.data?.error
  return typeof data === 'string' && CHANNEL_GONE_CODES.has(data)
}
```

and in the loop:

```ts
      try {
        messages = await listMessages(token, channel.id, HISTORY_PAGE_LIMIT, channel.lastSyncTs)
      } catch (err) {
        if (!isChannelGoneError(err)) throw err
        // The operator archived it or lost access. Record it once, drop it from
        // the watch list so it stops costing a request every cycle, and move on.
        this.log('info', 'dashboard: watched channel is gone; unwatching', {
          teamId: input.teamId,
          channelId: channel.id
        })
        await this.dashboardStore.update((file) => {
          const ws = file.workspaces[input.teamId]
          if (ws?.watchedChannelIds) {
            ws.watchedChannelIds = ws.watchedChannelIds.filter((id) => id !== channel.id)
          }
        })
        continue
      }
```

If `SyncEngine` has no logger field, add `private log(level, msg, meta)` that forwards to `log` from `../logging`, or call `log.info` directly — whichever matches the file's existing imports. Do not add a second logging path.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node node_modules/vitest/vitest.mjs run tests/unit/sync-engine-watchlist.test.ts tests/unit/sync-engine.test.ts
```
Expected: PASS. The pre-existing engine tests must stay green — this is the regression that a reviewer would reject on.

- [ ] **Step 5: Commit**

```bash
git add src/main/slack/sync-engine.ts tests/unit/sync-engine-watchlist.test.ts
git commit -m "feat(dashboard): sync only watched channels and unwatch vanished ones"
```

---

### Task 12: Auto-pick the busiest channels on first sync

**Files:**
- Modify: `src/main/slack/sync-engine.ts` (`walk`)
- Modify: `src/main/slack/dashboard-store.ts` (add `setWatchedChannels`)
- Test: `tests/unit/sync-engine-watchlist.test.ts` (extend — **not** `dashboard-store-v2.test.ts`; these cases exercise `SyncEngine`, and Task 11's file already holds the `engineFor` / `blankChannel` helpers they need)

**Interfaces:**
- Consumes: `selectWatchedChannels` from Task 8; `DashboardStore` from Task 10.
- Produces: `DashboardStore.setWatchedChannels(teamId: string, channelIds: string[] | undefined): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/sync-engine-watchlist.test.ts`, inside the existing `describe` block:

```ts
it('records the auto-picked watch list once, and never overwrites it', async () => {
  const { engine, store } = await engineFor(async () => {})
  listChannels.mockResolvedValue([
    { id: 'C_A', name: 'a', isPrivate: false },
    { id: 'C_B', name: 'b', isPrivate: false },
    { id: 'C_C', name: 'c', isPrivate: false }
  ])
  listMessages.mockResolvedValue([])

  await engine.syncWorkspace({ profileId: 'p', teamId: 'T1', teamName: 'Acme' })
  const first = (await store.read()).workspaces.T1.watchedChannelIds
  expect(first).toBeDefined()
  expect(first).toHaveLength(2)

  await store.setWatchedChannels('T1', ['C_A'])
  await engine.syncWorkspace({ profileId: 'p', teamId: 'T1', teamName: 'Acme' })
  expect((await store.read()).workspaces.T1.watchedChannelIds).toEqual(['C_A'])
})

// Review Focus: the operator's choice outranks the heuristic, always.
it('leaves an explicitly narrowed watch list alone across many syncs', async () => {
  const { engine, store } = await engineFor(async () => {})
  listChannels.mockResolvedValue([
    { id: 'C_A', name: 'a', isPrivate: false },
    { id: 'C_B', name: 'b', isPrivate: false }
  ])
  listMessages.mockResolvedValue([])

  await store.setWatchedChannels('T1', ['C_B'])
  for (let i = 0; i < 3; i++) {
    await engine.syncWorkspace({ profileId: 'p', teamId: 'T1', teamName: 'Acme' })
  }
  expect((await store.read()).workspaces.T1.watchedChannelIds).toEqual(['C_B'])
})
```

Both cases are `async` — `engineFor` creates a temp directory.

- [ ] **Step 2: Run to verify it fails**

```bash
node node_modules/vitest/vitest.mjs run tests/unit/sync-engine-watchlist.test.ts
```
Expected: FAIL — `setWatchedChannels` does not exist, and no auto-pick is recorded.

- [ ] **Step 3: Implement**

In `src/main/slack/dashboard-store.ts`:

```ts
  /**
   * Narrow (or widen) a workspace's watch list.
   *
   * Passing `undefined` restores the v1 meaning — watch everything — rather
   * than storing an empty array, which would read as "watch nothing" and stop
   * the workspace dead.
   */
  async setWatchedChannels(teamId: string, channelIds: string[] | undefined): Promise<void> {
    await this.update((file) => {
      const ws = file.workspaces[teamId]
      if (!ws) return
      if (channelIds === undefined) {
        delete ws.watchedChannelIds
        return
      }
      ws.watchedChannelIds = [...new Set(channelIds)]
    })
  }
```

In `src/main/slack/sync-engine.ts`, import `selectWatchedChannels` alongside `effectiveWatched`, add near the top:

```ts
/**
 * How many channels a workspace starts watching on its first sync.
 *
 * Two is a starting point, not a policy: volume is only a proxy for what
 * matters, which is why the dashboard can override it. Override with
 * `DASHBOARD_WATCH_LIMIT`.
 */
export const DEFAULT_WATCH_LIMIT = 2

export function watchLimit(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_WATCH_LIMIT
  return Math.min(200, Math.round(parsed))
}
```

and in `walk`, immediately after the channels are filtered:

```ts
    // First sync for this workspace: choose a starting set. Never re-run it —
    // `watchedChannelIds` being defined means the operator has a list, and a
    // heuristic that re-applies itself would quietly undo their narrowing.
    if (stored?.watchedChannelIds === undefined && channels.length > 0) {
      await this.dashboardStore.setWatchedChannels(
        input.teamId,
        selectWatchedChannels(
          channels.map((c) => ({ channelId: c.id, totalMessages: 0 })),
          this.watchLimit
        )
      )
    }
```

Add `private readonly watchLimit: number` to the class, defaulting to `watchLimit(process.env.DASHBOARD_WATCH_LIMIT)` in the constructor.

> Note: on a *brand new* workspace every channel has `totalMessages: 0`, so the auto-pick is effectively alphabetical and the real first-sync volume arrives one cycle later. That is acceptable — the operator picks from the dashboard either way — but record it in ADR 0007 rather than pretending the heuristic is sharp on day one.

- [ ] **Step 4: Run to verify it passes**

```bash
node node_modules/vitest/vitest.mjs run tests/unit/sync-engine-watchlist.test.ts tests/unit/sync-engine.test.ts tests/unit/dashboard-store-v2.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/slack/sync-engine.ts src/main/slack/dashboard-store.ts tests/unit/sync-engine-watchlist.test.ts
git commit -m "feat(dashboard): auto-pick a starting watch list once per workspace"
```

---

### Task 13: Hourly staggered scheduler

**Files:**
- Modify: `src/main/ipc/slack-dashboard.ipc.ts:359-417` (the auto-sync section)
- Test: `tests/unit/dashboard-scheduler.test.ts` (create)

**Interfaces:**
- Consumes: `AutoSyncDecision`, `workspacesDueForAutoSync` — both already exist in the same file.
- Produces: `DEFAULT_AUTO_SYNC_INTERVAL_MINUTES` (now 60), `workspaceSlotMinutes(teamId, slots)`, `workspacesDueThisMinute(...)`, `autoSyncCatchUpTeamIds(...)`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/dashboard-scheduler.test.ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
  autoSyncCatchUpTeamIds,
  workspaceSlotMinutes,
  workspacesDueThisMinute
} from '../../src/main/ipc/slack-dashboard.ipc'

describe('workspaceSlotMinutes', () => {
  it('is stable for the same teamId', () => {
    expect(workspaceSlotMinutes('T0123', 60)).toBe(workspaceSlotMinutes('T0123', 60))
  })

  it('always lands inside the slot range', () => {
    for (const id of ['T1', 'T2', 'abc', 'zzzz', '']) {
      const slot = workspaceSlotMinutes(id, 60)
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThan(60)
    }
  })

  it('spreads different teams across different minutes', () => {
    const slots = new Set(
      Array.from({ length: 40 }, (_, i) => workspaceSlotMinutes(`T${i}`, 60))
    )
    expect(slots.size).toBeGreaterThan(15)
  })
})

describe('workspacesDueThisMinute', () => {
  const base = { enabled: true, ready: true, syncingTeamIds: [], knownTeamIds: ['T1', 'T2'] }

  it('starts only the teams whose slot matches this minute', () => {
    const slots = 60
    const due = new Set(
      [0, 1, 2, 3, 4, 5, 59].flatMap((m) =>
        workspacesDueThisMinute(base, m, slots).map((id) => `${id}@${m}`)
      )
    )
    expect(due.size).toBeGreaterThan(0)
    // Every (team, minute) pair emitted must actually match that team's slot.
    for (const entry of due) {
      const [id, minute] = entry.split('@')
      expect(workspaceSlotMinutes(id, slots)).toBe(Number(minute))
    }
  })

  it('declines everything when auto-sync is off', () => {
    expect(
      workspacesDueThisMinute({ ...base, enabled: false }, workspaceSlotMinutes('T1', 60), 60)
    ).toEqual([])
  })

  it('declines everything before Electron is ready', () => {
    expect(
      workspacesDueThisMinute({ ...base, ready: false }, workspaceSlotMinutes('T1', 60), 60)
    ).toEqual([])
  })

  it('skips a workspace that is already walking', () => {
    const minute = workspaceSlotMinutes('T1', 60)
    expect(workspacesDueThisMinute({ ...base, syncingTeamIds: ['T1'] }, minute, 60)).toEqual([])
  })

  it('runs one team exactly once across a full hour', () => {
    let count = 0
    for (let m = 0; m < 60; m++) {
      count += workspacesDueThisMinute(base, m, 60).filter((id) => id === 'T1').length
    }
    expect(count).toBe(1)
  })
})

describe('autoSyncCatchUpTeamIds', () => {
  it('catches up a workspace missed while the app was closed', () => {
    const now = Date.UTC(2026, 9, 12, 12, 30)
    const stale = new Date(now - 3 * 3600_000).toISOString()
    const fresh = new Date(now - 60_000).toISOString()
    expect(autoSyncCatchUpTeamIds({ enabled: true, ready: true, syncingTeamIds: [], knownTeamIds: ['T1', 'T2'], lastSyncAt: { T1: stale, T2: fresh } }, 60, now)).toEqual(['T1'])
  })

  it('catches up a workspace never synced at all', () => {
    const now = Date.UTC(2026, 9, 12, 12, 30)
    expect(
      autoSyncCatchUpTeamIds({ enabled: true, ready: true, syncingTeamIds: [], knownTeamIds: ['T1'], lastSyncAt: {} }, 60, now)
    ).toEqual(['T1'])
  })
})

describe('default interval', () => {
  it('defaults to hourly, not every 15 minutes', () => {
    expect(DEFAULT_AUTO_SYNC_INTERVAL_MINUTES).toBe(60)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — none of the three new exports exist; `DEFAULT_AUTO_SYNC_INTERVAL_MINUTES` is `15`.

- [ ] **Step 3: Implement**

In `src/main/ipc/slack-dashboard.ipc.ts`:

```ts
/**
 * How long between automatic cycles.
 *
 * Hourly, not 15 minutes. Each workspace gets its own rate-limit budget, and a
 * cycle spends one `conversations.history` per watched channel; a workspace
 * watching two channels spends 2 of its 60 hourly calls, so anything faster
 * buys nothing but 429s. Overridable with `DASHBOARD_AUTO_SYNC_MINUTES`.
 */
export const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 60

/**
 * A workspace's minute-of-hour, derived from its id.
 *
 * FNV-1a: cheap, well-distributed on short strings, and stable across restarts
 * — which is the property that matters. A slot recomputed from `Date.now()` on
 * every tick would move each restart and defeat the staggering entirely.
 */
export function workspaceSlotMinutes(teamId: string, slots: number): number {
  const n = Math.max(1, Math.floor(slots))
  let h = 0x811c9dc5
  for (let i = 0; i < teamId.length; i++) {
    h ^= teamId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % n
}

/**
 * Which workspaces this tick starts.
 *
 * The same three declines as `workspacesDueForAutoSync` — off, not ready,
 * already walking — with one addition: a team whose slot is not this minute is
 * simply not due. That is what turns a single 15-minute timer into a staggered
 * sweep with no extra timers and no burst.
 */
export function workspacesDueThisMinute(
  decision: AutoSyncDecision,
  minuteOfHour: number,
  slots: number
): string[] {
  if (!decision.enabled || !decision.ready) return []
  const busy = new Set(decision.syncingTeamIds)
  return decision.knownTeamIds.filter(
    (teamId) => !busy.has(teamId) && workspaceSlotMinutes(teamId, slots) === minuteOfHour
  )
}

export interface CatchUpDecision extends AutoSyncDecision {
  /** `lastSyncAt` per teamId. A team with no entry has never synced. */
  lastSyncAt: Record<string, string>
}

/**
 * Workspaces whose slot came and went while the app was closed.
 *
 * A laptop that slept through four slots would otherwise wait a full hour on
 * wake. Two missed slots is the bar: one can be a deliberate restart.
 */
export function autoSyncCatchUpTeamIds(
  decision: CatchUpDecision,
  intervalMinutes: number,
  now: number
): string[] {
  if (!decision.enabled || !decision.ready) return []
  const busy = new Set(decision.syncingTeamIds)
  const threshold = now - intervalMinutes * 2 * 60_000
  return decision.knownTeamIds.filter((teamId) => {
    if (busy.has(teamId)) return false
    const iso = decision.lastSyncAt[teamId]
    if (!iso) return true
    const at = Date.parse(iso)
    return !Number.isFinite(at) || at < threshold
  })
}
```

Leave `workspacesDueForAutoSync` in place — `autoSyncIntervalMs` and its existing tests still cover the clamp, and Task 17's manual path uses the same parsing.

- [ ] **Step 4: Run to verify it passes**

```bash
node node_modules/vitest/vitest.mjs run tests/unit/dashboard-scheduler.test.ts tests/unit/dashboard-ipc-contract.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/slack-dashboard.ipc.ts tests/unit/dashboard-scheduler.test.ts
git commit -m "feat(dashboard): hourly sync staggered by a stable per-workspace slot"
```

---

### Task 14: Digest summariser

**Files:**
- Create: `src/main/slack/summarizer.ts`
- Test: `tests/unit/summarizer.test.ts` (create)

**Interfaces:**
- Consumes: `ChannelSummaryPoint` from `src/shared/types.ts`; `DashboardChannel`; `MAX_MESSAGE_CHARS = 1000` from `ai-analyzer.ts`.
- Produces: `SummaryProvider`, `ChannelSummaryBody`, `AiAuthError` reuse, `OpenAiSummaryProvider`, `buildSummaryPrompt`, `parseSummaryReply`. Task 15 consumes all of them.

**Design decision — why not `/v1/batches`.** The user asked for batch. OpenAI's Batch API is half price, but it is asynchronous with a **24-hour SLA**, so a digest submitted after the 23:00 sync would appear after the next night's sync — the dashboard would permanently show yesterday's news about yesterday. Instead this batches *across channels*: one request covers every watched channel in a workspace, which cuts request count by the channel count, stays synchronous, and costs the same per token. The 24 h variant is worth revisiting only if a day-old digest is acceptable.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/summarizer.test.ts
import { describe, expect, it } from 'vitest'
import { buildSummaryPrompt, parseSummaryReply } from '../../src/main/slack/summarizer'

const CHANNELS = [
  { channelId: 'C1', channelName: 'client-acme', messages: [{ ts: '1.1', text: 'blocked on legal' }] },
  { channelId: 'C2', channelName: 'random', messages: [] }
]

describe('buildSummaryPrompt', () => {
  it('includes every channel name so the reply can be joined back by id', () => {
    const prompt = buildSummaryPrompt(CHANNELS)
    expect(prompt).toContain('client-acme')
    expect(prompt).toContain('random')
    expect(prompt).toContain('C1')
  })

  it('asks for the six point kinds by name so the parser has a closed set', () => {
    for (const kind of ['blocker', 'decision', 'deadline', 'owner', 'question', 'risk']) {
      expect(buildSummaryPrompt(CHANNELS)).toContain(kind)
    }
  })

  it('truncates a message to the shared character cap', () => {
    const long = 'x'.repeat(5000)
    const prompt = buildSummaryPrompt([{ channelId: 'C1', channelName: 'a', messages: [{ ts: '1.1', text: long }] }])
    expect(prompt).not.toContain('x'.repeat(1001))
  })
})

describe('parseSummaryReply', () => {
  it('returns one entry per requested channel, keyed by channelId', () => {
    const parsed = parseSummaryReply(
      { summaries: [{ channelId: 'C1', text: 'Blocked on legal.', points: [{ kind: 'blocker', text: 'legal review', ts: '1.1' }] }] },
      ['C1', 'C2']
    )
    expect(parsed.get('C1')?.text).toBe('Blocked on legal.')
    expect(parsed.get('C1')?.points[0]).toEqual({ kind: 'blocker', text: 'legal review', ts: '1.1' })
  })

  it('returns an empty map for a quiet channel rather than inventing one', () => {
    expect(parseSummaryReply({ summaries: [] }, ['C1']).has('C1')).toBe(false)
  })

  it('rejects a reply naming a channel that was not asked about', () => {
    const parsed = parseSummaryReply(
      { summaries: [{ channelId: 'GHOST', text: 'hi', points: [] }] },
      ['C1']
    )
    expect(parsed.size).toBe(0)
  })

  it('drops a point whose kind is not one of the six', () => {
    const parsed = parseSummaryReply(
      { summaries: [{ channelId: 'C1', text: 'x', points: [{ kind: 'vibe', text: 'bad' }] }] },
      ['C1']
    )
    expect(parsed.get('C1')?.points).toEqual([])
  })

  it('returns an empty map for a malformed reply instead of throwing', () => {
    expect(parseSummaryReply(null, ['C1']).size).toBe(0)
    expect(parseSummaryReply({ summaries: 'nope' }, ['C1']).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// src/main/slack/summarizer.ts
import { log } from '../logging'
import { MAX_MESSAGE_CHARS } from './ai-analyzer'

/** What the model is asked to produce for one channel. */
export interface ChannelSummaryBody {
  text: string
  points: Array<{ kind: SummaryPointKind; text: string; ts?: string }>
}

export type SummaryPointKind =
  | 'blocker'
  | 'decision'
  | 'deadline'
  | 'owner'
  | 'question'
  | 'risk'

export interface SummaryChannelInput {
  channelId: string
  channelName: string
  messages: Array<{ ts: string; text: string }>
}

export interface SummaryProvider {
  summarize(channels: SummaryChannelInput[]): Promise<Map<string, ChannelSummaryBody>>
}

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const SUMMARY_MODEL = 'gpt-4o-mini'
const POINT_KINDS: SummaryPointKind[] = ['blocker', 'decision', 'deadline', 'owner', 'question', 'risk']
const POINT_KIND_SET = new Set<string>(POINT_KINDS)

const SYSTEM_PROMPT =
  'You summarise Slack channels for a freelancer tracking client work. ' +
  'Reply with JSON only, no prose and no code fence, shaped as ' +
  '{"summaries":[{"channelId":"C…","text":"…","points":[{"kind":"…","text":"…","ts":"…"}]}]}. ' +
  `Each point's "kind" must be exactly one of: ${POINT_KINDS.join(', ')}. ` +
  '"text" is 2-4 sentences. Omit a channel entirely if it has no activity; ' +
  'never invent a channelId, a ts, or a fact that is not in the messages.'

export function buildSummaryPrompt(channels: SummaryChannelInput[]): string {
  const blocks = channels.map((c) => {
    const lines = c.messages
      .map((m) => `[${m.ts}] ${m.text.slice(0, MAX_MESSAGE_CHARS)}`)
      .join('\n')
    return `channelId: ${c.channelId}\nname: ${c.channelName}\nmessages:\n${lines || '(none)'}`
  })
  return blocks.join('\n\n---\n\n')
}

/**
 * Join the reply back to the channels that were asked about.
 *
 * An unrequested `channelId` is dropped rather than stored: a hallucinated id
 * would otherwise create a channel row that Slack has never heard of, and it
 * would sit in the dashboard forever looking real.
 */
export function parseSummaryReply(
  raw: unknown,
  askedChannelIds: string[]
): Map<string, ChannelSummaryBody> {
  const out = new Map<string, ChannelSummaryBody>()
  const asked = new Set(askedChannelIds)
  const list = (raw as { summaries?: unknown } | null)?.summaries
  if (!Array.isArray(list)) return out

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const channelId = typeof rec.channelId === 'string' ? rec.channelId : ''
    if (!asked.has(channelId)) continue
    const text = typeof rec.text === 'string' ? rec.text.trim() : ''
    if (text === '') continue

    const points: ChannelSummaryBody['points'] = []
    if (Array.isArray(rec.points)) {
      for (const p of rec.points) {
        if (!p || typeof p !== 'object') continue
        const pr = p as Record<string, unknown>
        if (typeof pr.kind !== 'string' || !POINT_KIND_SET.has(pr.kind)) continue
        const pt = typeof pr.text === 'string' ? pr.text.trim() : ''
        if (pt === '') continue
        points.push({
          kind: pr.kind as SummaryPointKind,
          text: pt,
          ...(typeof pr.ts === 'string' ? { ts: pr.ts } : {})
        })
      }
    }
    out.set(channelId, { text, points })
  }
  return out
}

export class OpenAiSummaryProvider implements SummaryProvider {
  private readonly apiKey: string

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey
  }

  async summarize(channels: SummaryChannelInput[]): Promise<Map<string, ChannelSummaryBody>> {
    if (channels.length === 0) return new Map()
    let payload: unknown
    try {
      const res = await fetch(OPENAI_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: SUMMARY_MODEL,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildSummaryPrompt(channels) }
          ]
        })
      })
      if (!res.ok) {
        throw new Error(`openai summary failed: ${res.status}`)
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = body.choices?.[0]?.message?.content ?? ''
      payload = JSON.parse(content)
    } catch (err) {
      // A digest that failed to generate is a degraded dashboard, not a broken
      // sync. Swallow it; yesterday's digest stays on screen.
      log.warn('dashboard: summary request failed', { error: String(err) })
      return new Map()
    }
    return parseSummaryReply(payload, channels.map((c) => c.channelId))
  }
}

/** No key means no provider — the same rule as `AiAnalyzer.isAvailable`. */
export class SummaryAnalyzer {
  private readonly provider: SummaryProvider | null

  constructor(opts: { provider?: SummaryProvider | null }) {
    this.provider = opts.provider ?? null
  }

  isAvailable(): boolean {
    return this.provider !== null
  }

  async summarize(channels: SummaryChannelInput[]): Promise<Map<string, ChannelSummaryBody>> {
    if (!this.provider) return new Map()
    return this.provider.summarize(channels)
  }
}
```

If `MAX_MESSAGE_CHARS` is not exported from `ai-analyzer.ts`, export it — do not duplicate the literal, because two caps that drift is how a message gets truncated in one place and not the other.

- [ ] **Step 4: Run to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/slack/summarizer.ts tests/unit/summarizer.test.ts src/main/slack/ai-analyzer.ts
git commit -m "feat(dashboard): daily per-channel digests, one batched request per workspace"
```

---

### Task 15: Append digests once a day

**Files:**
- Modify: `src/main/ipc/slack-dashboard.ipc.ts` (`pruneAndAnalyze`, `SlackDashboardIpcDeps`)
- Modify: `src/main/index.ts:322-338` (construct the analyzer, pass the dep)
- Test: `tests/unit/dashboard-ipc-contract.test.ts` (extend)

**Interfaces:**
- Consumes: `SummaryAnalyzer`, `SummaryChannelInput` from Task 14; `ChannelSummary` from Task 10; `SUMMARY_HISTORY_LIMIT` from Task 10.
- Produces: `summarizeWorkspace(deps, teamId, teamName, date)` — exported for testing.

- [ ] **Step 1: Write the failing tests**

```ts
it('writes at most one digest per channel per UTC day', async () => {
  const summarize = vi.fn().mockResolvedValue(
    new Map([['C1', { text: 'Blocked on legal.', points: [] }]])
  )
  await summarizeWorkspace(deps, 'T1', 'Acme', '2026-10-12')
  await summarizeWorkspace(deps, 'T1', 'Acme', '2026-10-12')
  expect(summarize).toHaveBeenCalledTimes(1)
  const ch = (await deps.dashboardStore.read()).workspaces.T1.channels.C1
  expect(ch.summaries).toHaveLength(1)
})

it('appends a new row rather than overwriting the previous day', async () => {
  const summarize = vi
    .fn()
    .mockResolvedValueOnce(new Map([['C1', { text: 'Day one.', points: [] }]]))
    .mockResolvedValueOnce(new Map([['C1', { text: 'Day two.', points: [] }]]))
  await summarizeWorkspace(deps, 'T1', 'Acme', '2026-10-11')
  await summarizeWorkspace(deps, 'T1', 'Acme', '2026-10-12')
  const ch = (await deps.dashboardStore.read()).workspaces.T1.channels.C1
  expect(ch.summaries?.map((s) => s.date)).toEqual(['2026-10-11', '2026-10-12'])
})

it('does nothing when no summary provider is configured', async () => {
  const summarize = vi.fn()
  const bare = { ...deps, summaryAnalyzer: new SummaryAnalyzer({ provider: null }) }
  await summarizeWorkspace(bare, 'T1', 'Acme', '2026-10-12')
  expect(summarize).not.toHaveBeenCalled()
})

it('never rejects — an AI failure leaves yesterday digest in place', async () => {
  const exploding = { ...deps, summaryAnalyzer: { isAvailable: () => true, summarize: vi.fn().mockRejectedValue(new Error('boom')) } }
  await expect(summarizeWorkspace(exploding, 'T1', 'Acme', '2026-10-12')).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — `summarizeWorkspace` does not exist.

- [ ] **Step 3: Implement**

Add to the dep interface and the top of the file:

```ts
import { SUMMARY_HISTORY_LIMIT } from '../slack/dashboard-store'
import { SummaryAnalyzer, type SummaryChannelInput } from '../slack/summarizer'

export interface SlackDashboardIpcDeps {
  syncEngine: SyncEngine
  dashboardStore: DashboardStore
  settingsStore: DashboardSettingsStore
  aiAnalyzer: AiAnalyzer
  summaryAnalyzer: SummaryAnalyzer
  getMainWindow: GetDashboardWindow
  /** Injectable for tests; defaults to the UTC clock. */
  now?: () => Date
}
```

```ts
/**
 * Append today's digest for every watched channel, once per day.
 *
 * Daily, not per sync: a digest is a daily artifact, and re-summarising the
 * window on every hourly cycle would both cost more and bury the history in
 * near-identical rows. The UTC day key is the idempotence guard — a second run
 * on the same day is a no-op, so a catch-up cycle and a manual click can both
 * fire without double-writing.
 */
export async function summarizeWorkspace(
  deps: SlackDashboardIpcDeps,
  teamId: string,
  teamName: string,
  date: string
): Promise<void> {
  if (!deps.summaryAnalyzer?.isAvailable()) return

  try {
    const channels = Object.values((await deps.dashboardStore.read()).workspaces[teamId]?.channels ?? {})
    // Already digested today? Skip the request entirely — this is the cost guard.
    if (channels.some((c) => c.summaries?.some((s) => s.date === date))) return

    const input: SummaryChannelInput[] = channels
      .filter((c) => c.recentMessages.length > 0)
      .map((c) => ({
        channelId: c.channelId,
        channelName: c.channelName,
        messages: c.recentMessages.map((m) => ({ ts: m.ts, text: m.text }))
      }))
    if (input.length === 0) return

    const bodies = await deps.summaryAnalyzer.summarize(input)
    if (bodies.size === 0) return

    const generatedAt = (deps.now?.() ?? new Date()).toISOString()
    await deps.dashboardStore.update((file) => {
      for (const channel of Object.values(file.workspaces[teamId]?.channels ?? {})) {
        const body = bodies.get(channel.channelId)
        if (!body) continue
        channel.summaries = channel.summaries ?? []
        if (channel.summaries.some((s) => s.date === date)) continue
        channel.summaries.push({
          date,
          text: body.text,
          points: body.points,
          generatedAt,
          model: 'gpt-4o-mini'
        })
        channel.summaries = channel.summaries.slice(-SUMMARY_HISTORY_LIMIT)
      }
    })
  } catch (err) {
    log.warn('dashboard: summary failed; digest unchanged', { teamId, error: String(err) })
  }
}
```

Call it from `pruneAndAnalyze`, after the sentiment pass, using the same `teamName` it already receives:

```ts
  try {
    await summarizeWorkspace(deps, teamId, teamName, (deps.now?.() ?? new Date()).toISOString().slice(0, 10))
  } catch {
    // summarizeWorkspace already swallows; this is belt-and-braces so a future
    // edit that throws cannot turn a summary failure into a failed sync.
  }
```

In `src/main/index.ts`, where the deps object is built:

```ts
const summaryAnalyzer = new SummaryAnalyzer({
  provider: process.env.OPENAI_API_KEY ? new OpenAiSummaryProvider({ apiKey: process.env.OPENAI_API_KEY }) : null
})
```

and add `summaryAnalyzer` to the `registerSlackDashboardIpc({...})` call.

- [ ] **Step 4: Run to verify it passes**

```bash
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
```
Expected: PASS. Existing IPC tests construct `SlackDashboardIpcDeps`; add `summaryAnalyzer: new SummaryAnalyzer({ provider: null })` to each, which also proves the absent-provider path is harmless.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/slack-dashboard.ipc.ts src/main/index.ts tests/unit/dashboard-ipc-contract.test.ts
git commit -m "feat(dashboard): append one AI digest per channel per day"
```

---

### Task 16: `set-watched-channels` channel end to end

**Files:**
- Modify: `src/shared/ipc-contract.ts` (constants + `IpcApi`)
- Modify: `src/shared/types.ts` (three payload/result types)
- Modify: `src/preload/index.ts:158-178`
- Modify: `src/main/ipc/slack-dashboard.ipc.ts` (`registerSlackDashboardIpc`, `SlackDashboardIpcDeps`)
- Modify: `src/main/index.ts:322-338` (pass `tokenSource`)
- Test: `tests/unit/dashboard-ipc-contract.test.ts` (extend — **not** a new file; see the note below)

**Interfaces:**
- Consumes: `DashboardStore.setWatchedChannels` from Task 12; `SlackDashboardIpcDeps` as extended by Task 15.
- Produces: `IpcChannels.SlackDashboardSetWatchedChannels`, `IpcChannels.SlackDashboardListChannels`, `IpcApi.slackDashboard.setWatchedChannels`, `.listChannels`. Task 17 consumes both.

> **Why no new test file.** `tests/unit/dashboard-ipc-contract.test.ts` already mocks
> `src/main/ipc/handle` into an `ipcHandlers` map and owns the only dashboard IPC
> harness. There is no `./harness` module — importing one would not resolve. Extend
> that file.

> **Two things in that file must change with the contract, or the build breaks.**
> 1. `CONTRACT_METHODS` (line ~42) is asserted with
>    `ExactSameKeys<keyof IpcApi['slackDashboard'], typeof CONTRACT_METHODS>`, so adding
>    two methods to `IpcApi` **without** adding them to this array is a compile error.
>    Add `'setWatchedChannels'` and `'listChannels'` to it.
> 2. `CHANNEL_OF_METHOD` (line ~48) is `Record<CONTRACT_METHODS[number], keyof typeof IpcChannels>`
>    and is the same kind of exhaustive record. Add both entries.

- [ ] **Step 1: Write the failing tests**

Add inside `tests/unit/dashboard-ipc-contract.test.ts`, in the block that already
covers the other `slack-dashboard:*` handlers. Use that file's existing harness
variable and its handler-invocation helper by the names they already have — read the
file first; do not introduce new names.

```ts
it('narrows the watch list', async () => {
  await invokeHandler(IpcChannels.SlackDashboardSetWatchedChannels, {
    teamId: 'T1',
    channelIds: ['C2']
  })
  expect((await harness.store.read()).workspaces.T1.watchedChannelIds).toEqual(['C2'])
})

// Review Focus: clearing the picker must widen, not stop the workspace.
it('treats an absent channelIds as "watch everything"', async () => {
  await invokeHandler(IpcChannels.SlackDashboardSetWatchedChannels, { teamId: 'T1' })
  expect((await harness.store.read()).workspaces.T1.watchedChannelIds).toBeUndefined()
})

it('rejects a payload with no teamId rather than touching every workspace', async () => {
  await expect(
    invokeHandler(IpcChannels.SlackDashboardSetWatchedChannels, {})
  ).rejects.toThrow(/teamId/)
})

it('refuses to list channels without a token, and names the workspace', async () => {
  harness.tokenSource.tryGet.mockResolvedValue(null)
  await expect(
    invokeHandler(IpcChannels.SlackDashboardListChannels, { teamId: 'T1' })
  ).rejects.toThrow(/T1/)
})

it('returns every channel for the picker, watched or not', async () => {
  harness.tokenSource.tryGet.mockResolvedValue('xoxp-test')
  // Stub the API client for this file if it is not already stubbed.
  const listed = (await invokeHandler(IpcChannels.SlackDashboardListChannels, {
    teamId: 'T1'
  })) as Array<{ channelId: string }>
  expect(listed.map((c) => c.channelId)).toEqual(expect.arrayContaining(['C1', 'C2', 'C3']))
})
```

If the harness's deps factory has no `tokenSource` field yet, add one — Task 16 makes it
a required member of `SlackDashboardIpcDeps`, along with Task 15's `summaryAnalyzer`.
Every place in that file that constructs a deps object needs both.

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — both channels unregistered.

- [ ] **Step 3: Implement the contract**

`src/shared/ipc-contract.ts`, in the `IpcChannels` const:

```ts
  SlackDashboardSetWatchedChannels: 'slack-dashboard:set-watched-channels',
  SlackDashboardListChannels: 'slack-dashboard:list-channels',
```

and in `IpcApi.slackDashboard`:

```ts
    /** Narrow or widen what this workspace reads. Omit `channelIds` to watch all. */
    setWatchedChannels: (payload: SetWatchedChannelsPayload) => Promise<void>
    /** Every channel in the workspace, watched or not — the picker's source list. */
    listChannels: (payload: WorkspaceTeamPayload) => Promise<DashboardChannelSummary[]>
```

with the payloads in `src/shared/types.ts`:

```ts
export interface SetWatchedChannelsPayload {
  teamId: string
  /** Omit to restore "watch every channel". */
  channelIds?: string[]
}

export interface WorkspaceTeamPayload {
  teamId: string
}

/** A channel the picker can offer. Not a rollup — this channel may have no data yet. */
export interface DashboardChannelSummary {
  channelId: string
  channelName: string
  isPrivate: boolean
  totalMessages: number
}
```

`src/preload/index.ts`, inside `slackDashboard`:

```ts
    setWatchedChannels: (payload: SetWatchedChannelsPayload) =>
      ipcRenderer.invoke(IpcChannels.SlackDashboardSetWatchedChannels, payload),
    listChannels: (payload: WorkspaceTeamPayload) =>
      ipcRenderer.invoke(IpcChannels.SlackDashboardListChannels, payload),
```

`src/main/ipc/slack-dashboard.ipc.ts`, inside `registerSlackDashboardIpc`:

```ts
  handleInvoke(IpcChannels.SlackDashboardSetWatchedChannels, async (payload: SetWatchedChannelsPayload) => {
    const teamId = payload?.teamId?.trim() ?? ''
    if (!teamId) throw new Error('teamId is required')
    const ids = payload.channelIds?.filter((id) => typeof id === 'string' && id !== '')
    await deps.dashboardStore.setWatchedChannels(teamId, ids && ids.length > 0 ? ids : undefined)
  })

  handleInvoke(IpcChannels.SlackDashboardListChannels, async (payload: WorkspaceTeamPayload) => {
    const teamId = payload?.teamId?.trim() ?? ''
    if (!teamId) throw new Error('teamId is required')
    const stored = (await deps.dashboardStore.read()).workspaces[teamId]
    const token = await deps.tokenSource.tryGet(stored?.profileId ?? '', teamId)
    // Name the workspace: "reconnect" is the action, and the user needs to know
    // which of thirty to reconnect.
    if (!token) throw new Error(`no stored Slack token for ${teamId} — reconnect that workspace`)
    const listed = await listChannels(token)
    const known = stored?.channels ?? {}
    return listed.map((c) => ({
      channelId: c.id,
      channelName: c.name,
      isPrivate: c.isPrivate,
      totalMessages: known[c.id]?.totalMessages ?? 0
    }))
  })
```

Add `tokenSource: TokenSource` to `SlackDashboardIpcDeps` and pass the engine's `tokenStore` from `src/main/index.ts`.

- [ ] **Step 4: Run to verify it passes**

```bash
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-contract.ts src/shared/types.ts src/preload/index.ts src/main/ipc/slack-dashboard.ipc.ts src/main/index.ts tests/unit/dashboard-ipc-contract.test.ts
git commit -m "feat(dashboard): expose the channel watch list and picker source over IPC"
```

---

### Task 17: Renderer store

**Files:**
- Create: `src/renderer/src/hooks/useDashboard.ts`
- Test: `tests/unit/dashboard-renderer-store.test.ts` (create)

**Interfaces:**
- Consumes: every `src/shared/dashboard-view.ts` export; `window.api.slackDashboard` (now 8 methods).
- Produces: `useDashboardStore`, `DashboardStoreState`. Task 18 consumes the store.

- [ ] **Step 1: Write the failing tests**

The file is a `.ts` module and vitest runs in `node`, so stub `window` before importing — the same trick `dashboard-ipc-contract.test.ts` uses to drive handlers with no Electron.

```ts
// tests/unit/dashboard-renderer-store.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSnapshot } from '../../src/shared/types'

const listeners = { progress: [] as Array<(p: unknown) => void>, reconnect: [] as Array<(p: unknown) => void> }

const api = {
  get: vi.fn(),
  syncNow: vi.fn(),
  setAutoSync: vi.fn(),
  clear: vi.fn(),
  setWatchedChannels: vi.fn(),
  listChannels: vi.fn(),
  onProgress: (cb: (p: unknown) => void) => { listeners.progress.push(cb); return () => {} },
  onReconnectNeeded: (cb: (p: unknown) => void) => { listeners.reconnect.push(cb); return () => {} }
}

vi.stubGlobal('window', { api: { slackDashboard: api } })

const { useDashboardStore } = await import('../../src/renderer/src/hooks/useDashboard')

const SNAPSHOT: DashboardSnapshot = {
  workspaces: {
    T1: {
      teamId: 'T1', teamName: 'Acme', profileId: 'p', lastSyncAt: '2026-10-12T11:00:00.000Z',
      watchedChannelIds: ['C1'],
      channels: {
        C1: {
          channelId: 'C1', channelName: 'general', isPrivate: false, lastSyncTs: '1.1',
          totalMessages: 10, dailyCounts: {}, recentMessages: [],
          sentimentScore: 0.5, completionEstimate: 0.4,
          aiConfigured: true, aiEligible: 2, aiAnalyzed: 2,
          sentimentTrend: [], dailySeries: [1, 2, 3]
        }
      }
    }
  },
  settings: { autoSync: true },
  syncingTeamIds: []
}

beforeEach(() => {
  useDashboardStore.setState({ snapshot: null, error: null, reconnectTeamIds: [], progress: null })
  api.get.mockResolvedValue(SNAPSHOT)
})

describe('useDashboardStore', () => {
  it('loads a snapshot', async () => {
    await useDashboardStore.getState().load()
    expect(useDashboardStore.getState().snapshot?.workspaces.T1.teamName).toBe('Acme')
  })

  it('records the error message rather than throwing', async () => {
    api.get.mockRejectedValue(new Error('nope'))
    await useDashboardStore.getState().load()
    expect(useDashboardStore.getState().error).toBe('nope')
  })

  it('keys syncing workspaces off syncingTeamIds, never teamName', () => {
    // Review Focus: two workspaces may share a display name.
    const { syncingTeams } = useDashboardStore.getState()
    expect(syncingTeams(SNAPSHOT.workspaces, ['T1'])).toEqual(['T1'])
    expect(
      syncingTeams({ ...SNAPSHOT.workspaces, T2: { ...SNAPSHOT.workspaces.T1, teamId: 'T2' } }, ['T1'])
    ).toEqual(['T1'])
  })

  it('sets a team reconnectable when the main process asks', () => {
    listeners.reconnect.forEach((cb) => cb({ teamId: 'T9', teamName: 'Globex' }))
    expect(useDashboardStore.getState().reconnectTeamIds).toEqual(['T9'])
  })

  it('clears the reconnect flag once the team appears in a snapshot again', async () => {
    listeners.reconnect.forEach((cb) => cb({ teamId: 'T9' }))
    await useDashboardStore.getState().load()
    expect(useDashboardStore.getState().reconnectTeamIds).toEqual([])
  })

  it('optimistically records a watch-list change and rolls back when the write fails', async () => {
    api.setWatchedChannels.mockRejectedValue(new Error('disk full'))
    await useDashboardStore.getState().toggleWatched('T1', 'C2')
    expect(useDashboardStore.getState().snapshot?.workspaces.T1.watchedChannelIds).toEqual(['C1'])
    expect(useDashboardStore.getState().error).toBe('disk full')
  })

  it('surfaces an already-syncing refusal as its own message, not a failure', async () => {
    api.syncNow.mockResolvedValue({ ok: false, teamId: 'T1', reason: 'already-syncing', message: 'busy' })
    await useDashboardStore.getState().syncNow('p', 'T1', 'Acme')
    expect(useDashboardStore.getState().error).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// src/renderer/src/hooks/useDashboard.ts
import { create } from 'zustand'
import { toggleWatched as toggleIn } from '../../../shared/dashboard-view'
import type {
  DashboardChannelSummary,
  DashboardSnapshot,
  DashboardWorkspace,
  SyncNowPayload,
  SyncNowResult,
  SyncProgressPayload
} from '../../../shared/types'

export interface DashboardStoreState {
  snapshot: DashboardSnapshot | null
  progress: SyncProgressPayload | null
  reconnectTeamIds: string[]
  error: string | null
  load: () => Promise<void>
  syncNow: (profileId: string, teamId: string, teamName: string) => Promise<SyncNowResult | null>
  toggleWatched: (teamId: string, channelId: string) => Promise<void>
  listChannels: (teamId: string) => Promise<DashboardChannelSummary[]>
  setAutoSync: (on: boolean) => Promise<void>
  onProgress: (cb: (progress: SyncProgressPayload) => void) => () => void
  onReconnectNeeded: (cb: (p: { teamId: string; teamName: string }) => void) => () => void
  /** teamIds currently walking — resolved against the snapshot's own keys. */
  syncingTeams: (
    workspaces: Record<string, DashboardWorkspace>,
    syncingTeamIds: string[]
  ) => string[]
}

export const useDashboardStore = create<DashboardStoreState>((set, get) => ({
  snapshot: null,
  progress: null,
  reconnectTeamIds: [],
  error: null,

  load: async () => {
    try {
      const snapshot = await window.api.slackDashboard.get()
      set((s) => ({
        snapshot,
        error: null,
        // A team that is back in the file has been reconnected; drop the banner.
        reconnectTeamIds: s.reconnectTeamIds.filter((id) => !(id in snapshot.workspaces))
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  syncNow: async (profileId, teamId, teamName) => {
    const payload: SyncNowPayload = { profileId, teamId, teamName }
    try {
      const result: SyncNowResult = await window.api.slackDashboard.syncNow(payload)
      if (!result.ok) {
        // 'already-syncing' is a no-op, not a failure: a spinner already says so.
        if (result.reason !== 'already-syncing') set({ error: result.message })
        return result
      }
      set({ error: null })
      await get().load()
      return result
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  toggleWatched: async (teamId, channelId) => {
    const before = get().snapshot
    if (!before) return
    const ws = before.workspaces[teamId]
    if (!ws) return
    const next = toggleIn(ws.watchedChannelIds, channelId)
    // Optimistic: the picker must feel instant. Rolled back below on failure.
    set({
      snapshot: {
        ...before,
        workspaces: { ...before.workspaces, [teamId]: { ...ws, watchedChannelIds: next } }
      },
      error: null
    })
    try {
      await window.api.slackDashboard.setWatchedChannels({ teamId, channelIds: next })
    } catch (err) {
      set({
        snapshot: before,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },

  listChannels: async (teamId) => {
    try {
      return await window.api.slackDashboard.listChannels({ teamId })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return []
    }
  },

  setAutoSync: async (on) => {
    try {
      await window.api.slackDashboard.setAutoSync(on)
      set((s) => (s.snapshot ? { snapshot: { ...s.snapshot, settings: { autoSync: on } } } : s))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  onProgress: (cb) => window.api.slackDashboard.onProgress(cb),

  onReconnectNeeded: (cb) =>
    window.api.slackDashboard.onReconnectNeeded((payload) => {
      set((s) => ({
        reconnectTeamIds: s.reconnectTeamIds.includes(payload.teamId)
          ? s.reconnectTeamIds
          : [...s.reconnectTeamIds, payload.teamId]
      }))
      cb(payload)
    }),

  syncingTeams: (workspaces, syncingTeamIds) => {
    const known = new Set(Object.keys(workspaces))
    return syncingTeamIds.filter((id) => known.has(id))
  }
}))
```

- [ ] **Step 4: Run to verify it passes**

```bash
node node_modules/vitest/vitest.mjs run tests/unit/dashboard-renderer-store.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/useDashboard.ts tests/unit/dashboard-renderer-store.test.ts
git commit -m "feat(dashboard): renderer store over the dashboard IPC surface"
```

---

### Task 18: The dashboard screen

**Files:**
- Create: `src/renderer/src/components/SlackDashboard.tsx`
- Modify: `src/renderer/src/assets/main.css`

**Interfaces:**
- Consumes: `useDashboardStore` (Task 17); `channelAiState`, `orderWorkspaces`, `effectiveWatched`, `relativeTime`, `isWatched` (Task 8).
- Produces: `SlackDashboard({ open, onClose })` — mounted by Task 19.

**No component tests.** Vitest is `include: ['tests/unit/**/*.test.ts']` in a `node` environment; there is no jsdom and no `.tsx` transform in the test include. Every decision this component makes is therefore a pure function already covered in Task 8 — the component only maps those results onto elements. Adding a `.tsx` test would require changing the vitest config, which is out of scope for this plan.

- [ ] **Step 1: Write the component**

```tsx
// src/renderer/src/components/SlackDashboard.tsx
import { useEffect, useMemo, useState } from 'react'
import {
  channelAiState,
  effectiveWatched,
  isWatched,
  orderWorkspaces,
  relativeTime,
  type AiState
} from '../../../shared/dashboard-view'
import type { DashboardChannel, DashboardChannelSummary } from '../../../shared/types'
import { useDashboardStore } from '../hooks/useDashboard'

interface SlackDashboardProps {
  open: boolean
  onClose: () => void
}

/** How each AI state reads. `degraded` is deliberately not styled as a problem. */
const AI_NOTE: Record<AiState, string | null> = {
  unavailable: 'No OPENAI_API_KEY set',
  empty: null,
  failing: 'AI labelling failed — will retry',
  degraded: 'Partially labelled',
  healthy: null
}

function Sparkline({ series }: { series: number[] }): React.JSX.Element {
  const max = Math.max(1, ...series)
  return (
    <span className="dash-spark" aria-hidden>
      {series.map((v, i) => (
        <span key={i} className="dash-spark-bar" style={{ height: `${Math.round((v / max) * 100)}%` }} />
      ))}
    </span>
  )
}

function SentimentBar({ channel }: { channel: DashboardChannel }): React.JSX.Element {
  const score = channel.sentimentScore ?? 0
  const pct = Math.round(Math.abs(score) * 50)
  return (
    <span className={`dash-sentiment ${score >= 0 ? 'is-positive' : 'is-negative'}`} title={`Sentiment ${score}`}>
      <span className="dash-sentiment-mid" />
      <span
        className="dash-sentiment-fill"
        style={score >= 0 ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }}
      />
    </span>
  )
}

export function SlackDashboard({ open, onClose }: SlackDashboardProps): React.JSX.Element | null {
  const snapshot = useDashboardStore((s) => s.snapshot)
  const progress = useDashboardStore((s) => s.progress)
  const reconnectTeamIds = useDashboardStore((s) => s.reconnectTeamIds)
  const error = useDashboardStore((s) => s.error)
  const load = useDashboardStore((s) => s.load)
  const syncNow = useDashboardStore((s) => s.syncNow)
  const toggleWatched = useDashboardStore((s) => s.toggleWatched)
  const setAutoSync = useDashboardStore((s) => s.setAutoSync)
  const onProgress = useDashboardStore((s) => s.onProgress)
  const onReconnectNeeded = useDashboardStore((s) => s.onReconnectNeeded)

  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const [pickerRows, setPickerRows] = useState<DashboardChannelSummary[]>([])

  useEffect(() => {
    if (!open) return
    void load()
    return onProgress((p) => useDashboardStore.setState({ progress: p }))
  }, [open, load, onProgress])

  useEffect(() => onReconnectNeeded(() => void load()), [onReconnectNeeded, load])

  // Re-read when the walk finishes so counts and digests reflect the last cycle.
  useEffect(() => {
    if (progress?.phase === 'done' || progress?.phase === 'error') void load()
  }, [progress?.phase, load])

  const ordered = useMemo(
    () => orderWorkspaces(snapshot?.workspaces ?? {}),
    [snapshot?.workspaces]
  )

  useEffect(() => {
    if (!pickerFor) return
    let live = true
    void useDashboardStore
      .getState()
      .listChannels(pickerFor)
      .then((rows) => {
        if (live) setPickerRows(rows)
      })
    return () => {
      live = false
    }
  }, [pickerFor])

  if (!open) return null

  return (
    <div className="dash-backdrop" role="dialog" aria-label="Slack Dashboard">
      <div className="dash-panel">
        <header className="dash-header">
          <h2>Slack Dashboard</h2>
          <label className="dash-autosync">
            <input
              type="checkbox"
              checked={snapshot?.settings.autoSync ?? false}
              onChange={(e) => void setAutoSync(e.target.checked)}
            />
            Sync hourly
          </label>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </header>

        {error ? <div className="banner error">{error}</div> : null}

        {reconnectTeamIds.length > 0 ? (
          <div className="banner warn" role="status">
            Reconnect required: {reconnectTeamIds.join(', ')} — the Slack token is gone for
            {' '}
            {reconnectTeamIds.length === 1 ? 'this workspace' : 'these workspaces'}.
          </div>
        ) : null}

        <div className="dash-body">
          {ordered.length === 0 ? (
            <p className="dash-empty">
              No workspaces yet. Connect Slack from the sidebar, then press Sync.
            </p>
          ) : null}

          {ordered.map(([teamId, ws]) => {
            const channelIds = Object.keys(ws.channels)
            const watched = new Set(effectiveWatched(ws.watchedChannelIds, channelIds))
            const syncing = (snapshot?.syncingTeamIds ?? []).includes(teamId)
            const tick =
              syncing && progress?.teamId === teamId
                ? `${progress.phase} · channel ${progress.channelIndex + 1}/${progress.channelTotal}`
                : null

            return (
              <section key={teamId} className="dash-workspace">
                <header className="dash-workspace-head">
                  <h3>{ws.teamName}</h3>
                  <span className="dash-sync-time">{relativeTime(ws.lastSyncAt, Date.now())}</span>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={syncing}
                    onClick={() => void syncNow(ws.profileId, teamId, ws.teamName)}
                  >
                    {syncing ? 'Syncing…' : 'Sync'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => setPickerFor(pickerFor === teamId ? null : teamId)}
                  >
                    Channels ({watched.size})
                  </button>
                </header>

                {tick ? <p className="dash-tick">{tick}</p> : null}

                {pickerFor === teamId ? (
                  <div className="dash-picker">
                    {pickerRows.map((row) => (
                      <label key={row.channelId} className="dash-picker-row">
                        <input
                          type="checkbox"
                          checked={isWatched(ws.watchedChannelIds, row.channelId)}
                          onChange={() => void toggleWatched(teamId, row.channelId)}
                        />
                        <span>{row.isPrivate ? '🔒 ' : '#'}{row.channelName}</span>
                        <span className="dash-picker-count">{row.totalMessages}</span>
                      </label>
                    ))}
                    <p className="dash-picker-note">
                      Unwatched channels cost no API calls. Leaving all unchecked stops this
                      workspace.
                    </p>
                  </div>
                ) : null}

                {[...watched].map((channelId) => {
                  const channel = ws.channels[channelId]
                  if (!channel) return null
                  const state = channelAiState(channel)
                  const latest = channel.summaries?.[channel.summaries.length - 1]
                  return (
                    <article key={channelId} className="dash-channel">
                      <div className="dash-channel-head">
                        <h4>
                          {channel.isPrivate ? '🔒 ' : '#'}
                          {channel.channelName}
                        </h4>
                        <span className="dash-total">{channel.totalMessages} msgs</span>
                        <SentimentBar channel={channel} />
                      </div>

                      <Sparkline series={channel.dailySeries} />

                      {/* Review Focus: a long-idle channel is idle, not broken. */}
                      {channel.totalMessages > 0 && channel.aiEligible === 0 ? (
                        <p className="dash-muted">No messages in the last 90 days.</p>
                      ) : null}
                      {AI_NOTE[state] ? <p className="dash-muted">{AI_NOTE[state]}</p> : null}

                      {latest ? (
                        <div className="dash-digest">
                          <p className="dash-digest-date">AI digest — {latest.date}</p>
                          <p className="dash-digest-text">{latest.text}</p>
                          {latest.points.length > 0 ? (
                            <ul className="dash-points">
                              {latest.points.map((point, i) => (
                                <li key={i} className={`dash-point is-${point.kind}`}>
                                  <span className="dash-point-kind">{point.kind}</span>
                                  {point.text}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  )
                })}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add the styles**

Append to `src/renderer/src/assets/main.css`. Every colour is an existing token — no literal hex in this block:

```css
/* ---------- Slack Dashboard ---------- */
.dash-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.dash-panel {
  width: min(860px, 100%);
  max-height: min(88vh, 760px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
}

.dash-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.dash-header h2 {
  margin: 0;
  font-size: 1rem;
  flex: 1;
}

.dash-autosync {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 0.8rem;
}

.dash-body {
  overflow: auto;
  padding: 14px 18px 20px;
}

.dash-empty,
.dash-muted,
.dash-tick {
  color: var(--muted);
  font-size: 0.8rem;
}

.dash-workspace {
  margin-bottom: 22px;
}

.dash-workspace-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-soft);
}

.dash-workspace-head h3 {
  margin: 0;
  flex: 1;
  font-size: 0.92rem;
}

.dash-sync-time,
.dash-total,
.dash-picker-count {
  color: var(--muted);
  font-size: 0.74rem;
  font-variant-numeric: tabular-nums;
}

.dash-picker {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: var(--surface-2);
}

.dash-picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 0.82rem;
  cursor: pointer;
}

.dash-picker-count {
  margin-left: auto;
}

.dash-picker-note {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 0.72rem;
}

.dash-channel {
  padding: 12px 0;
  border-bottom: 1px solid var(--border-soft);
}

.dash-channel-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dash-channel-head h4 {
  margin: 0;
  flex: 1;
  font-size: 0.85rem;
  font-weight: 500;
}

.dash-spark {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 26px;
  margin: 8px 0 4px;
}

.dash-spark-bar {
  flex: 1;
  min-width: 2px;
  border-radius: 1px 1px 0 0;
  background: var(--accent-soft);
}

.dash-sentiment {
  position: relative;
  width: 72px;
  height: 8px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border-soft);
  overflow: hidden;
}

.dash-sentiment-mid {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border);
}

.dash-sentiment-fill {
  position: absolute;
  top: 0;
  bottom: 0;
}

.dash-sentiment.is-positive .dash-sentiment-fill {
  background: var(--success);
}

.dash-sentiment.is-negative .dash-sentiment-fill {
  background: var(--danger);
}

.dash-digest {
  margin-top: 8px;
  padding: 10px 12px;
  border-left: 2px solid var(--accent);
  background: var(--accent-soft);
  border-radius: 0 8px 8px 0;
}

.dash-digest-date {
  margin: 0 0 4px;
  color: var(--muted);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.dash-digest-text {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.5;
}

.dash-points {
  margin: 8px 0 0;
  padding-left: 16px;
  font-size: 0.78rem;
}

.dash-point-kind {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 0.66rem;
  text-transform: uppercase;
}

.dash-point.is-blocker .dash-point-kind {
  color: var(--danger);
}

.dash-point.is-deadline .dash-point-kind {
  color: var(--accent);
}

.banner.warn {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--text);
  font-size: 0.85rem;
}
```

- [ ] **Step 3: Verify it compiles**

```bash
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
node node_modules/eslint/bin/eslint.js .
```
Expected: clean. React hooks rules will flag the `useEffect` that calls `useDashboardStore.setState` if the dependency array is wrong — fix the deps, not the rule.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/SlackDashboard.tsx src/renderer/src/assets/main.css
git commit -m "feat(dashboard): the dashboard screen — rollups, sparklines and digests"
```

---

### Task 19: Sidebar entry and mount

**Files:**
- Modify: `src/renderer/src/components/ProfileSidebar.tsx` (props at 22-49; JSX after line 428)
- Modify: `src/renderer/src/App.tsx` (state ~71; `showEmbed` ~296; `<main>` ~804-826; overlays ~829-906; keyboard ~573-611)
- Modify: `src/renderer/src/assets/main.css` (one rule)

**Interfaces:**
- Consumes: `SlackDashboard` (Task 18).
- Produces: `ProfileSidebarProps.onOpenDashboard: () => void`; ⌘D.

- [ ] **Step 1: Wire the sidebar prop and entry**

In `src/renderer/src/components/ProfileSidebar.tsx`, add to `ProfileSidebarProps`:

```ts
  onOpenDashboard: () => void
```

Add a local glyph next to `PinGlyph`, matching that component's shape exactly:

```tsx
function DashboardGlyph(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.5 19.5h17M6 16V9.5M10 16V5.5M14 16v-4M18 16V7.5"
      />
    </svg>
  )
}
```

Insert between the Google block and `<ul className="nav-tree">` (after line 428):

```tsx
      <div className="sidebar-nav-actions">
        <button
          type="button"
          className="nav-app-select"
          onClick={onOpenDashboard}
          title="Slack activity across every connected workspace"
        >
          <DashboardGlyph />
          <span className="nav-app-label">Slack Dashboard</span>
        </button>
      </div>
```

- [ ] **Step 2: Mount in App.tsx**

State, beside the other overlay booleans:

```tsx
  const [dashboardOpen, setDashboardOpen] = useState(false)
```

Negate it in `showEmbed` — the native `WebContentsView` paints above the renderer, so without this the dashboard is invisible behind the embed:

```tsx
  const showEmbed = Boolean(
    adminAuthenticated &&
    activeProfile &&
    activeAppId &&
    !browserAuthBusy &&
    !locked &&
    !settingsOpen &&
    !cmdkOpen &&
    !dashboardOpen &&
    !showOnboarding
  )
```

Keyboard, in the ⌘ block and the Escape ladder:

```tsx
      if (meta && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setDashboardOpen((o) => !o)
        return
      }
```

```tsx
      if (e.key === 'Escape') {
        if (dashboardOpen) {
          setDashboardOpen(false)
          return
        }
        if (settingsOpen) {
```

Mount beside the other overlays, using the same derived-flag composition:

```tsx
      <SlackDashboard open={dashboardOpen && !locked} onClose={() => setDashboardOpen(false)} />
```

and pass down:

```tsx
        onOpenDashboard={() => setDashboardOpen(true)}
```

- [ ] **Step 3: One CSS rule**

```css
.sidebar-nav-actions {
  padding: var(--nav-pad-y) 8px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: var(--nav-gap);
}
```

- [ ] **Step 4: Verify**

```bash
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
node node_modules/eslint/bin/eslint.js .
node node_modules/vitest/vitest.mjs run
```
Expected: clean.

- [ ] **Step 5: Launch and eyeball it**

```bash
node node_modules/electron-vite/bin/electron-vite.js dev
```

Check by hand, in this order: the sidebar entry appears; ⌘D opens the panel; the panel is not painted over by the Slack embed; Escape closes it; ⌘D toggles; the button is absent from a locked app.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/ProfileSidebar.tsx src/renderer/src/assets/main.css
git commit -m "feat(dashboard): sidebar entry, ⌘D shortcut and full-pane mount"
```

---

### Task 20: ADR, ticket closure, whole-branch verification

**Files:**
- Create: `docs/adr/0007-slack-dashboard-sync-model.md`
- Modify: `.scratch/slack-dashboard/issues/08-dashboard-ui.md`, `09-adr-and-tickets.md` (add 10–13)
- Create: `.scratch/slack-dashboard/issues/10-watch-list.md`, `11-scheduler.md`, `12-digests.md`, `13-trends.md`

- [ ] **Step 1: Write ADR 0007**

`docs/adr/0007-slack-dashboard-sync-model.md` must record, with the reason beside each:

1. **Status** Accepted · **Date** 2026-10-12
2. **Context** — 30 client workspaces, hourly, one token each
3. **Rate limits are per workspace, not per account** — the load-bearing fact; 45 watched channels across 30 workspaces is ~2.5 % of the available budget
4. **User tokens, not bot tokens** — only `xoxp-` reads public channels the user is not in, and every private channel they are a member of
5. **Scopes frozen at six** — `reactions:read` / `pins:read` declined; scopes are irreversible per token
6. **Hourly, staggered by a stable slot** — FNV-1a of `teamId`, one timer, no bursts
7. **Batch means one request per workspace, not `/v1/batches`** — the Batch API's 24 h SLA would leave the digest permanently a day stale
8. **Digests are daily and append-only** — the day key is the idempotence guard; overwriting would destroy the history that is the point
9. **Derived fields are never persisted** — trend, series and AI counts are computed at read time
10. **Known limitation** — on a brand-new workspace every channel has `totalMessages: 0`, so the first auto-pick is alphabetical, not volume-ranked. The operator overrides it in the picker.
11. **Known limitation** — the app is a desktop process; hourly sync needs the machine awake. The cursor makes a resumed cycle lossless, so sleep costs latency, not data.

- [ ] **Step 2: Write the four tickets**

Each in the shape of the existing nine: title, `ready-for-agent` → `resolved`, the test that pins it, and the commit that landed it.

- [ ] **Step 3: Run the full verification set**

```bash
node node_modules/eslint/bin/eslint.js .
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
node node_modules/vitest/vitest.mjs run
```
Record the test count. Anything other than all-green means the branch is not done.

- [ ] **Step 4: Confirm the scope freeze held**

```bash
grep -A8 'const USER_SCOPES' src/main/slack/oauth-flow.ts
git log --oneline master..HEAD -- src/main/slack/oauth-flow.ts
```
Expected: six scopes, and a clean diff that adds nothing.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0007-slack-dashboard-sync-model.md .scratch/slack-dashboard/
git commit -m "docs(dashboard): ADR 0007 and ticket closure for the watch list, scheduler and digests"
```

---

## Handoff to testing with real tokens

Implementation is not complete until it has run against a real workspace. Once Tasks 8–20 land:

1. Fill `.env` with `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI`, `OPENAI_API_KEY`.
2. **Start with 1–3 workspaces.** Connect each, press Sync once by hand, and confirm the walk completes before letting the hourly driver take over.
3. Confirm the tier empirically — call `conversations.history` five times in a minute and count 429s.
4. Only then connect the remaining workspaces.
5. Watch the first digest land the next day, and check it against the channel by hand — a summary that is confidently wrong is worse than no summary, and the first one is the cheapest moment to notice.

**Before this goes to a client:** written authorisation from each client's organisation (Slack's API ToS requires it from the organisation, not the individual), and a rotation of `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET`, both of which were pasted into a chat log.