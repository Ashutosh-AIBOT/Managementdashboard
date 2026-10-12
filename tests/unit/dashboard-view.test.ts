import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  channelAiState,
  dailySeries,
  effectiveWatched,
  isWatched,
  orderWorkspaces,
  relativeTime,
  selectWatchedChannels,
  sentimentTrend,
  toggleWatched,
  utcDay
} from '../../src/shared/dashboard-view'
import type {
  DashboardChannel,
  DashboardMessage,
  Sentiment,
  WorkspaceRollup
} from '../../src/shared/types'

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

function message(ts: string, sentiment?: Sentiment): DashboardMessage {
  return { ts, text: 'x', ...(sentiment ? { sentiment } : {}) }
}

describe('utcDay', () => {
  it('keys by UTC, not local time', () => {
    expect(utcDay('1791811200.000100')).toBe('2026-10-12')
  })

  it('degrades to an empty key for a ts it cannot decode, rather than throwing', () => {
    expect(utcDay('abc')).toBe('')
    // `Number('')` is 0, so without an explicit guard this mints a real-looking 1970 day.
    expect(utcDay('')).toBe('')
    expect(utcDay('   ')).toBe('')
  })

  it('degrades instead of throwing when the instant falls outside the Date range', () => {
    // 1e15 s is a finite 1e18 ms, so a finite check alone would let it through to `toISOString`.
    expect(utcDay('1e15')).toBe('')
    expect(utcDay('-1e15')).toBe('')
    expect(utcDay('1e308')).toBe('') // overflows to Infinity on the multiply
  })

  it('degrades on a year that ISO cannot spell in four digits', () => {
    // In `Date` range, but `toISOString()` switches to `+275760-09-13`, whose
    // first 10 characters are not a `YYYY-MM-DD` key.
    expect(utcDay('8640000000000')).toBe('')
    expect(utcDay('-8640000000000')).toBe('')
    expect(utcDay('253402300800')).toBe('') // year 10000
  })

  it('still decodes an instant at the edge of a four-digit year', () => {
    expect(utcDay('253402300799.999')).toBe('9999-12-31') // last ms of year 9999
    expect(utcDay('-62167219200')).toBe('0000-01-01') // first ms of year 0000
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
  // `sentimentTrend` reads `Date.now()` for its window cutoff, so the clock is
  // frozen: without this the fixtures silently fall out of the 90-day window
  // and the tests start failing on a date rather than on a behaviour.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('groups labelled messages into UTC days', () => {
    const trend = sentimentTrend([
      message('1791811200.000100', 'positive'), // 2026-10-12T13:20:00Z
      message('1791811260.000200', 'negative'), // 2026-10-12T13:21:00Z
      message('1791714000.000300', 'neutral') // 2026-10-11T10:20:00Z
    ])
    // The 2026-10-12 bucket is a real two-message mean (+1 and -1), not a single point.
    expect(trend).toEqual([
      { date: '2026-10-11', score: 0, count: 1 },
      { date: '2026-10-12', score: 0, count: 2 }
    ])
  })

  it('omits a day whose only message is unlabelled rather than scoring it', () => {
    const trend = sentimentTrend([
      message('1791811200.000100', 'positive'), // 2026-10-12, labelled
      message('1791465600.000400') // 2026-10-08, no label — inside the window
    ])
    // Without the `!m.sentiment` guard the unlabelled day scores NaN and shows up here.
    expect(trend.map((p) => p.date)).toEqual(['2026-10-12'])
  })

  it('averages a lopsided day instead of summing it', () => {
    const trend = sentimentTrend([
      message('1791638400.000100', 'positive'), // 2026-10-10T13:20:00Z
      message('1791638460.000100', 'positive'),
      message('1791638520.000100', 'positive'),
      message('1791638580.000100', 'negative')
    ])
    // +3 and -1 is a sum of 2; only the division makes it 0.5.
    expect(trend).toEqual([{ date: '2026-10-10', score: 0.5, count: 4 }])
  })

  it('rounds a repeating mean to three decimals', () => {
    const trend = sentimentTrend([
      message('1791552000.000100', 'positive'), // 2026-10-09T13:20:00Z
      message('1791552060.000100', 'positive'),
      message('1791552120.000100', 'negative')
    ])
    // +2 and -1 over 3 messages is 0.333…, not 0.333.
    expect(trend).toEqual([{ date: '2026-10-09', score: 0.333, count: 3 }])
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

  it('copies rather than aliasing the caller list on that back-compat path', () => {
    const all = ['C01', 'C02']
    const effective = effectiveWatched(undefined, all)
    expect(effective).not.toBe(all)
    effective.push('C99')
    expect(all).toEqual(['C01', 'C02'])
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

  it('reports a channel watched while the list is still absent', () => {
    expect(isWatched(undefined, 'C01')).toBe(true)
  })

  it('answers from the narrowed list once the operator has narrowed it', () => {
    expect(isWatched(['C01'], 'C01')).toBe(true)
    expect(isWatched(['C01'], 'C02')).toBe(false)
    expect(isWatched([], 'C01')).toBe(false)
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
