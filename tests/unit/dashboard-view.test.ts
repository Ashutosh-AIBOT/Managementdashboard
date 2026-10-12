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
    expect(utcDay('1791811200.000100')).toBe('2026-10-12')
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
    expect(trend).toHaveLength(2)
    expect(trend[0]).toEqual({ date: '2026-10-11', score: 0, count: 1 })
  })

  it('omits days with no labelled messages instead of emitting zero-score points', () => {
    const trend = sentimentTrend([message('1791811200.000100', 'positive')], 30)
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
