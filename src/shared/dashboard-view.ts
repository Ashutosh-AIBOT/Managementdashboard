/**
 * Every dashboard decision that is a pure function of its inputs.
 *
 * It lives here, in `shared`, rather than in the component because vitest is
 * configured for `.test.ts` under `tests/unit` in a `node` environment — there
 * is no jsdom and no `.tsx` in the include, so a React component cannot be
 * tested at all. Keeping the decisions pure is what makes them testable; main,
 * preload and renderer all import from this file.
 *
 * Imports only types: no Electron, no React, no store, no Node built-in.
 */

import type { DashboardChannel, DashboardMessage, Sentiment, WorkspaceRollup } from './types'

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
/** Keyed by the shared `Sentiment` union so adding a label breaks here at compile time. */
const SENTIMENT_SCORE: Record<Sentiment, number> = {
  positive: 1,
  neutral: 0,
  negative: -1
}

/**
 * The ±8.64e15 ms window `Date` accepts. Past it `toISOString()` throws rather
 * than returning anything, which is why this is checked and not assumed.
 */
const MAX_TIME_MS = 8.64e15

/**
 * UTC day key for a Slack `ts` (seconds with a fractional part).
 *
 * **Returns a `YYYY-MM-DD` key or `''`, and never throws** — the whole contract
 * in one line, because Task 9 buckets straight off this key. `''` is the
 * degradation rather than a `toISOString()` of whatever came in:
 *
 * - `Number('')` is 0, so an absent `ts` would mint a confident `1970-01-01`.
 * - A finite `ts` can still overflow `Date` (`1e15` s is `1e18` ms), and
 *   `toISOString()` raises on that rather than saturating.
 * - A `ts` inside `Date`'s range but past year 9999 makes `toISOString()` emit
 *   the expanded form (`+275760-09-13T…`), whose first 10 characters are not a
 *   day key at all.
 *
 * An empty key cannot collide with a real bucket, so a bad value reads as an
 * absent day instead of a plausible-looking wrong one.
 */
export function utcDay(ts: string): string {
  const ms = Number(ts) * 1000
  if (ts.trim() === '' || !Number.isFinite(ms) || Math.abs(ms) > MAX_TIME_MS) return ''
  const day = new Date(ms).toISOString().slice(0, 10)
  // A leading sign is `toISOString()`'s expanded-year marker: `+275760-09`, not `YYYY-MM-DD`.
  return day.startsWith('+') || day.startsWith('-') ? '' : day
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
    a.teamName === b.teamName
      ? a.teamId < b.teamId
        ? -1
        : 1
      : a.teamName.localeCompare(b.teamName)
  )
}

/**
 * Is this one channel watched? An absent list means "everything", the same
 * back-compat rule `effectiveWatched` applies — a row must not read as
 * unwatched just because the operator has not narrowed the list yet.
 */
export function isWatched(ids: string[] | undefined, channelId: string): boolean {
  return ids === undefined || ids.includes(channelId)
}

/**
 * An absent list means "everything", which is how pre-v2 workspaces keep syncing.
 *
 * Always a fresh array, on that path too: callers persist the result straight
 * into renderer state, so handing back the caller's own array would let a later
 * in-place edit mutate it without notifying anything.
 */
export function effectiveWatched(ids: string[] | undefined, allChannelIds: string[]): string[] {
  if (ids === undefined) return [...allChannelIds]
  const known = new Set(allChannelIds)
  return ids.filter((id) => known.has(id))
}

/**
 * Returns a new list; the input array is left alone because callers persist the
 * result straight into renderer state, where an in-place edit would not notify
 * anything.
 */
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

/**
 * Compact sync-age label. `never` and `just now` are deliberately distinct:
 * one means no sync has ever happened, the other means the elapsed time is
 * below the resolution the label has.
 */
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
