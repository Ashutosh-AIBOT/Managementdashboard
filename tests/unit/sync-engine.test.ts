import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlackChannelSummary, SlackMessageSummary } from '../../src/shared/types'
import { log } from '../../src/main/logging'
import { DashboardStore } from '../../src/main/slack/dashboard-store'
import { RateLimitError } from '../../src/main/slack/rate-limiter'
import { SlackApiError } from '../../src/main/slack/types'
import {
  ReconnectRequiredError,
  SyncEngine,
  SyncInProgressError,
  type SyncProgress,
  type TokenSource
} from '../../src/main/slack/sync-engine'

/**
 * `listChannels` / `listMessages` are mocked at the module boundary, so the walk
 * itself is exercised for real while Slack's network is not. Everything below the
 * client — cursors, per-channel commits, the store's own dedupe and retention
 * guards — is the genuine `DashboardStore` on a tmp path, not a stub that cannot fail.
 */
const { listChannelsMock, listMessagesMock } = vi.hoisted(() => ({
  listChannelsMock: vi.fn(),
  listMessagesMock: vi.fn()
}))

vi.mock('../../src/main/slack/slack-api-client', () => ({
  listChannels: listChannelsMock,
  listMessages: listMessagesMock
}))

const TEAM = { profileId: 'p1', teamId: 'T1', teamName: 'Acme' }
/** Deliberately the same display name as TEAM — a tick keyed on it is ambiguous. */
const TEAM_TWIN = { profileId: 'p2', teamId: 'T2', teamName: 'Acme' }

function channel(id: string, over: Partial<SlackChannelSummary> = {}): SlackChannelSummary {
  return { id, name: `chan-${id}`, isPrivate: false, ...over }
}

function message(ts: string, text = 'hello'): SlackMessageSummary {
  return { ts, user: 'U1', text }
}

function tokenSource(token: string | null): TokenSource {
  return { tryGet: async () => token }
}

describe('SyncEngine', () => {
  let dir: string
  let store: DashboardStore
  let progress: SyncProgress[]
  let warn: ReturnType<typeof vi.spyOn>

  function build(token: string | null = 'xoxp-test'): SyncEngine {
    return new SyncEngine({
      tokenStore: tokenSource(token),
      dashboardStore: store,
      onProgress: (p) => progress.push(p)
    })
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slack-dashboard-sync-'))
    store = new DashboardStore({ filePath: join(dir, 'dashboard.json') })
    progress = []
    warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    listChannelsMock.mockReset()
    listMessagesMock.mockReset()
    listChannelsMock.mockResolvedValue([])
    listMessagesMock.mockResolvedValue([])
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  /** Channels the store now holds for the team under test. */
  async function channelsOnDisk(): Promise<Record<string, { lastSyncTs?: string }>> {
    const file = await store.read()
    return file.workspaces.T1?.channels ?? {}
  }

  // --- Failure mode 1: Slack unreachable mid-sync ------------------------------

  it('keeps partial progress and leaves the failing channel unsynced', async () => {
    listChannelsMock.mockResolvedValue([channel('C1'), channel('C2'), channel('C3')])
    listMessagesMock
      .mockResolvedValueOnce([message('1700000001.000000')])
      .mockRejectedValueOnce(new Error('fetch failed: ECONNRESET'))
      .mockResolvedValue([message('1700000002.000000')])

    const engine = build()
    await expect(engine.syncWorkspace(TEAM)).rejects.toThrow('ECONNRESET')

    const stored = await channelsOnDisk()
    // C1 committed before C2 was attempted.
    expect(stored.C1?.lastSyncTs).toBe('1700000001.000000')
    // C2 threw, so no transaction ever ran for it — no cursor means the next sync
    // refetches C2 from scratch instead of skipping it as "already done".
    expect(stored.C2).toBeUndefined()
    // C3 was never reached; a failed walk stops rather than skipping the tail.
    expect(stored.C3).toBeUndefined()

    // The engine is not wedged by the failure.
    expect(engine.isRunning()).toBe(false)
  })

  it('reports the failure on the error phase with the channel it died on', async () => {
    listChannelsMock.mockResolvedValue([channel('C1'), channel('C2')])
    listMessagesMock.mockRejectedValueOnce(new Error('fetch failed'))

    await expect(build().syncWorkspace(TEAM)).rejects.toThrow('fetch failed')

    const last = progress.at(-1)
    expect(last?.phase).toBe('error')
    expect(last?.channelIndex).toBe(0)
    expect(last?.channelTotal).toBe(2)
    expect(last?.message).toContain('fetch failed')
  })

  // --- Failure mode 2: rate limit ---------------------------------------------

  it('surfaces the backoff without waiting on it', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    listMessagesMock.mockRejectedValue(
      new RateLimitError(30, 'Slack rate limited: conversations.history')
    )

    const engine = build()
    const failure = await engine.syncWorkspace(TEAM).catch((err: unknown) => err)

    // The backoff surfaces as a RateLimitError, not flattened into a generic
    // failure, and `retryAfterSeconds` is intact for the caller's retry policy.
    expect(failure).toBeInstanceOf(RateLimitError)
    expect((failure as RateLimitError).retryAfterSeconds).toBe(30)
    // Nothing is logged, nothing is awaited: the walk is already dead, so the
    // engine hands the number back instead of sitting on it. This resolves in
    // microseconds — had it slept, this test would have blown the 5s timeout.
    expect(engine.isRunning()).toBe(false)
  })

  it('accepts a second sync immediately after a rate-limited walk', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    listMessagesMock
      .mockRejectedValueOnce(new RateLimitError(86_400, 'Slack rate limited'))
      .mockResolvedValue([message('1700000001.000000')])

    const engine = build()
    await expect(engine.syncWorkspace(TEAM)).rejects.toBeInstanceOf(RateLimitError)

    // No 60s grace period, no backoff wait: the very next call is accepted and
    // runs to completion on real timers with nothing faked.
    expect(engine.isSyncing('T1')).toBe(false)
    await expect(engine.syncWorkspace(TEAM)).resolves.toMatchObject({ channelsSynced: 1 })
  })

  it('releases the workspace slot even when the rate limit is absurd', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    listMessagesMock.mockRejectedValue(new RateLimitError(86_400, 'Slack rate limited'))

    const engine = build()
    await expect(engine.syncWorkspace(TEAM)).rejects.toBeInstanceOf(RateLimitError)

    // An hour-long `retry_after` must not translate into an hour-long lock.
    expect(engine.isRunning()).toBe(false)
    expect(engine.isSyncing('T1')).toBe(false)
    await expect(engine.syncWorkspace(TEAM)).rejects.toBeInstanceOf(RateLimitError)
  })

  // --- Failure mode 3: token revoked ------------------------------------------

  it('turns invalid_auth into a catchable ReconnectRequiredError', async () => {
    listChannelsMock.mockRejectedValue(new SlackApiError('invalid_auth', 'conversations.list'))

    const engine = build()
    const failure = await engine.syncWorkspace(TEAM).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(ReconnectRequiredError)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as ReconnectRequiredError).teamId).toBe('T1')
    expect((failure as ReconnectRequiredError).message).toContain('reconnect required')
    expect(progress.at(-1)?.message).toContain('reconnect required')
    expect(engine.isRunning()).toBe(false)
  })

  it('asks for a reconnect when no token is stored at all', async () => {
    const engine = build(null)
    await expect(engine.syncWorkspace(TEAM)).rejects.toBeInstanceOf(ReconnectRequiredError)
    expect(listChannelsMock).not.toHaveBeenCalled()
  })

  it('turns token_revoked into a reconnect too, not a generic failure', async () => {
    // Slack's Errors table for conversations.history lists token_revoked as
    // "Authentication token is for a deleted user or workspace or the app has
    // been removed when using a user token" — the same dead-token condition as
    // invalid_auth, and only a reconnect can fix it.
    listChannelsMock.mockRejectedValue(new SlackApiError('token_revoked', 'conversations.list'))

    const failure = await build()
      .syncWorkspace(TEAM)
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(ReconnectRequiredError)
    expect((failure as ReconnectRequiredError).teamId).toBe('T1')
  })

  it('leaves a non-auth Slack error as itself, not a reconnect prompt', async () => {
    listChannelsMock.mockRejectedValue(new SlackApiError('channel_not_found', 'conversations.list'))

    const failure = await build()
      .syncWorkspace(TEAM)
      .catch((err: unknown) => err)
    expect(failure).not.toBeInstanceOf(ReconnectRequiredError)
    expect(failure).toBeInstanceOf(SlackApiError)
  })

  it('maps invalid_auth raised mid-walk, after earlier channels committed', async () => {
    listChannelsMock.mockResolvedValue([channel('C1'), channel('C2')])
    listMessagesMock
      .mockResolvedValueOnce([message('1700000001.000000')])
      .mockRejectedValueOnce(new SlackApiError('invalid_auth', 'conversations.history'))

    await expect(build().syncWorkspace(TEAM)).rejects.toBeInstanceOf(ReconnectRequiredError)
    expect((await channelsOnDisk()).C1?.lastSyncTs).toBe('1700000001.000000')
  })

  // --- Failure mode 4: 200+ channels ------------------------------------------

  it('emits channelIndex / channelTotal across a 205-channel workspace', async () => {
    const many = Array.from({ length: 205 }, (_, i) => channel(`C${i}`))
    listChannelsMock.mockResolvedValue(many)
    listMessagesMock.mockResolvedValue([message('1700000001.000000')])

    const result = await build().syncWorkspace(TEAM)

    expect(result.channelsSynced).toBe(205)
    expect(result.messagesRead).toBe(205)

    const ticks = progress.filter((p) => p.phase === 'reading-messages')
    expect(ticks).toHaveLength(205)
    // "channel N of M" needs a total the UI can divide by, on every single tick —
    // and an index that moves, or the bar looks frozen on a big workspace.
    expect(ticks.every((p) => p.channelTotal === 205)).toBe(true)
    expect(ticks.map((p) => p.channelIndex)).toEqual(Array.from({ length: 205 }, (_, i) => i))
    expect(ticks.every((p) => p.teamName === 'Acme')).toBe(true)

    const done = progress.at(-1)
    expect(done?.phase).toBe('done')
    expect(done?.channelIndex).toBe(205)
    expect(done?.channelTotal).toBe(205)
    expect(done?.messageCount).toBe(205)
  })

  // --- Failure mode 5: two syncs at once --------------------------------------

  /** A `listMessages` that parks every call until the returned `release()` is called. */
  function gatedMessages(): { release: () => void } {
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    listMessagesMock.mockImplementation(async () => {
      await gate
      return [message('1700000001.000000')]
    })
    return { release: () => open() }
  }

  it('rejects the second sync of the same workspace rather than doubling it', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    const { release } = gatedMessages()

    const engine = build()
    const first = engine.syncWorkspace(TEAM)
    try {
      await vi.waitFor(() => expect(listMessagesMock).toHaveBeenCalledTimes(1))
      expect(engine.isSyncing('T1')).toBe(true)

      await expect(engine.syncWorkspace(TEAM)).rejects.toBeInstanceOf(SyncInProgressError)
      // Refused before any extra work: still exactly one channel fetch in flight.
      expect(listMessagesMock).toHaveBeenCalledTimes(1)
    } finally {
      release()
    }
    await first

    expect(engine.isRunning()).toBe(false)
    // One walk, so the channel is counted exactly once.
    const stored = await store.read()
    expect(stored.workspaces.T1.channels.C1.totalMessages).toBe(1)
  })

  it('names the busy workspace on the refusal, never an idle one', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    const { release } = gatedMessages()

    const engine = build()
    const first = engine.syncWorkspace(TEAM)
    try {
      await vi.waitFor(() => expect(listMessagesMock).toHaveBeenCalledTimes(1))
      // The refusal carries the workspace that is genuinely mid-walk, which the
      // per-team guard makes identical to the refused one by construction.
      const failure = await engine.syncWorkspace(TEAM).catch((err: unknown) => err)
      expect((failure as SyncInProgressError).teamId).toBe('T1')
      expect((failure as Error).message).toContain('T1')
    } finally {
      release()
    }
    await first
  })

  it('lets a different workspace sync while another one is mid-walk', async () => {
    listChannelsMock.mockImplementation(async (token: string) =>
      token === 'xoxp-test' ? [channel('C1')] : [channel('C9')]
    )
    // Only C1 parks; the second workspace runs straight through.
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    listMessagesMock.mockImplementation(async (_token: string, channelId: string) => {
      if (channelId === 'C1') await gate
      return [message('1700000001.000000')]
    })

    const engine = build()
    // A second engine, so this covers store isolation rather than the per-team
    // guard: each engine keeps its own `inFlight`, so no lock is shared at all.
    const other = new SyncEngine({ tokenStore: tokenSource('xoxp-other'), dashboardStore: store })
    const t1 = engine.syncWorkspace(TEAM)
    try {
      await vi.waitFor(() => expect(listMessagesMock).toHaveBeenCalledTimes(1))
      expect(engine.isSyncing('T1')).toBe(true)

      // T2 is a different workspace: it must not be refused by T1's walk.
      await expect(
        other.syncWorkspace({ profileId: 'p2', teamId: 'T2', teamName: 'Globex' })
      ).resolves.toMatchObject({ teamId: 'T2', channelsSynced: 1 })
      // T1 was genuinely still in flight throughout.
      expect(engine.isSyncing('T1')).toBe(true)
    } finally {
      open()
    }
    await t1

    // Both landed, each in its own rollup, neither crowding the other out.
    const file = await store.read()
    expect(file.workspaces.T1.channels.C1.totalMessages).toBe(1)
    expect(file.workspaces.T2.channels.C9.totalMessages).toBe(1)
    expect(file.workspaces.T2.teamName).toBe('Globex')
  })

  it('lets a different workspace sync on the *same* engine, mid-walk', async () => {
    // One engine, one store, two workspaces at once. The token is keyed by team
    // so each walk lands on its own channel and only T1 parks.
    const perTeam: TokenSource = {
      tryGet: async (_profileId, teamId) => (teamId === 'T1' ? 'xoxp-t1' : 'xoxp-t2')
    }
    listChannelsMock.mockImplementation(async (token: string) =>
      token === 'xoxp-t1' ? [channel('C1')] : [channel('C9')]
    )
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    listMessagesMock.mockImplementation(async (_token: string, channelId: string) => {
      if (channelId === 'C1') await gate
      return [message('1700000001.000000')]
    })

    // A single global in-flight flag would refuse T2 here; the per-team guard is
    // the only thing that makes this legal.
    const engine = new SyncEngine({ tokenStore: perTeam, dashboardStore: store })
    const t1 = engine.syncWorkspace(TEAM)
    try {
      await vi.waitFor(() => expect(listMessagesMock).toHaveBeenCalledTimes(1))

      await expect(
        engine.syncWorkspace({ profileId: 'p2', teamId: 'T2', teamName: 'Globex' })
      ).resolves.toMatchObject({ teamId: 'T2', channelsSynced: 1 })
      expect(engine.isSyncing('T1')).toBe(true)
      expect(engine.isRunning()).toBe(true)
    } finally {
      open()
    }
    await t1

    expect(engine.isRunning()).toBe(false)
    const file = await store.read()
    expect(file.workspaces.T1.channels.C1.totalMessages).toBe(1)
    expect(file.workspaces.T2.channels.C9.totalMessages).toBe(1)
  })

  it('frees only the finished workspace slot', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    listMessagesMock.mockResolvedValue([message('1700000001.000000')])

    const engine = build()
    const other = new SyncEngine({ tokenStore: tokenSource('xoxp-other'), dashboardStore: store })
    await other.syncWorkspace({ profileId: 'p2', teamId: 'T2', teamName: 'Globex' })
    expect(engine.isSyncing('T2')).toBe(false)
    // A different team's walk finishing must not, and did not, disturb T1.
    await engine.syncWorkspace(TEAM)
    await expect(
      other.syncWorkspace({ profileId: 'p2', teamId: 'T2', teamName: 'Globex' })
    ).resolves.toMatchObject({ teamId: 'T2' })
  })

  it('accepts a new sync once the first one finishes', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    listMessagesMock.mockResolvedValue([message('1700000001.000000')])

    const engine = build()
    await engine.syncWorkspace(TEAM)
    await expect(engine.syncWorkspace(TEAM)).resolves.toMatchObject({ channelsSynced: 1 })
  })

  // --- Failure mode 6: incremental correctness ---------------------------------

  it('requests nothing before the cursor on a first sync', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    listMessagesMock.mockResolvedValue([message('1700000001.000000')])

    await build().syncWorkspace(TEAM)

    expect(listMessagesMock).toHaveBeenCalledWith('xoxp-test', 'C1', 200, undefined)
  })

  it('threads the stored lastSyncTs through as oldest on the next sync', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    listMessagesMock
      .mockResolvedValueOnce([message('1700000001.000000')])
      .mockResolvedValueOnce([message('1700000002.000000')])

    const engine = build()
    await engine.syncWorkspace(TEAM)
    await engine.syncWorkspace(TEAM)

    // Second pass asks Slack for what came after the first pass's cursor.
    expect(listMessagesMock.mock.calls[1]).toEqual(['xoxp-test', 'C1', 200, '1700000001.000000'])
    // And the store's own cursor guard refuses the replay at the boundary, so the
    // totals cannot inflate even though Slack's `oldest` is inclusive.
    const stored = await store.read()
    expect(stored.workspaces.T1.channels.C1.totalMessages).toBe(2)
    expect(stored.workspaces.T1.channels.C1.lastSyncTs).toBe('1700000002.000000')
  })

  it('does not double-count when Slack replays a message below the cursor', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    listMessagesMock
      .mockResolvedValueOnce([message('1700000001.000000')])
      .mockResolvedValueOnce([message('1700000001.000000'), message('1700000000.000000')])

    const engine = build()
    await engine.syncWorkspace(TEAM)
    const result = await engine.syncWorkspace(TEAM)

    const replayed = (await store.read()).workspaces.T1.channels.C1
    expect(replayed.totalMessages).toBe(1)
    expect(replayed.dailyCounts).toHaveProperty('2023-11-14', 1)
    // The cursor never moves backwards to accommodate a replay.
    expect(replayed.lastSyncTs).toBe('1700000001.000000')
    expect(result.messagesRead).toBe(2)
  })

  // --- Store wiring ------------------------------------------------------------

  it('records the workspace name and profile even with no channels', async () => {
    listChannelsMock.mockResolvedValue([])

    const result = await build().syncWorkspace(TEAM)

    expect(result).toEqual({ teamId: 'T1', messagesRead: 0, channelsSynced: 0 })
    const file = await store.read()
    expect(file.workspaces.T1.teamName).toBe('Acme')
    expect(file.workspaces.T1.profileId).toBe('p1')
  })

  it('carries channel name and privacy into the store', async () => {
    listChannelsMock.mockResolvedValue([channel('C1', { name: 'general', isPrivate: true })])
    listMessagesMock.mockResolvedValue([message('1700000001.000000')])

    await build().syncWorkspace(TEAM)

    const stored = (await store.read()).workspaces.T1.channels.C1
    expect(stored.channelName).toBe('general')
    expect(stored.isPrivate).toBe(true)
  })

  it('walks channels one at a time, never interleaving fetches', async () => {
    listChannelsMock.mockResolvedValue([channel('C1'), channel('C2'), channel('C3')])
    let inFlight = 0
    let maxInFlight = 0
    listMessagesMock.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return [message('1700000001.000000')]
    })

    await build().syncWorkspace(TEAM)

    expect(maxInFlight).toBe(1)
    expect(listMessagesMock.mock.calls.map((c) => c[1])).toEqual(['C1', 'C2', 'C3'])
  })

  it('keeps walking when a progress listener throws, and says so in the log', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    listMessagesMock.mockResolvedValue([message('1700000001.000000')])
    const engine = new SyncEngine({
      tokenStore: tokenSource('xoxp-test'),
      dashboardStore: store,
      onProgress: () => {
        throw new Error('renderer exploded')
      }
    })

    await expect(engine.syncWorkspace(TEAM)).resolves.toMatchObject({ channelsSynced: 1 })
    expect((await channelsOnDisk()).C1?.lastSyncTs).toBe('1700000001.000000')
    // A silently swallowed throw would make a permanently broken renderer
    // callback indistinguishable from a working one.
    expect(warn).toHaveBeenCalled()
    const [text, meta] = warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(text).toContain('progress listener threw')
    expect(meta).toMatchObject({ teamName: 'Acme', phase: 'listing-channels' })
    expect(String(meta.error)).toContain('renderer exploded')
  })

  it('resolves without a progress listener at all', async () => {
    listChannelsMock.mockResolvedValue([channel('C1')])
    listMessagesMock.mockResolvedValue([message('1700000001.000000')])
    const engine = new SyncEngine({ tokenStore: tokenSource('xoxp-test'), dashboardStore: store })

    await expect(engine.syncWorkspace(TEAM)).resolves.toMatchObject({ messagesRead: 1 })
    expect(warn).not.toHaveBeenCalled()
  })

  // --- Failure classification ---------------------------------------------------

  it('widens a non-Error rejection so callers always get an Error', async () => {
    // A client that rejects with a bare string would otherwise hand the caller a
    // string, where `.message` is undefined and the error progress tick is blank.
    listChannelsMock.mockRejectedValue('boom')

    const failure = await build()
      .syncWorkspace(TEAM)
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('boom')
    expect(progress.at(-1)?.message).toBe('boom')
    expect(progress.at(-1)?.phase).toBe('error')
  })

  it('frees the workspace slot when a non-Error rejection is widened', async () => {
    listChannelsMock.mockRejectedValueOnce('boom').mockResolvedValue([])

    const engine = build()
    await expect(engine.syncWorkspace(TEAM)).rejects.toThrow('boom')
    expect(engine.isRunning()).toBe(false)
    await expect(engine.syncWorkspace(TEAM)).resolves.toMatchObject({ channelsSynced: 0 })
  })

  // --- Progress identity --------------------------------------------------------

  it('tags every emitted payload with the workspace it came from', async () => {
    listChannelsMock.mockResolvedValue([channel('C1'), channel('C2')])
    listMessagesMock.mockResolvedValue([message('1700000001.000000')])

    await build().syncWorkspace(TEAM)

    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((p) => p.teamId === 'T1')).toBe(true)
    expect(progress.every((p) => p.teamName === 'Acme')).toBe(true)
  })

  it('tags the error payload too, not just the happy path', async () => {
    listChannelsMock.mockRejectedValue(new SlackApiError('invalid_auth', 'conversations.list'))

    await expect(build().syncWorkspace(TEAM)).rejects.toBeInstanceOf(ReconnectRequiredError)

    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((p) => p.teamId === 'T1')).toBe(true)
  })

  it('names the team on every tick when two workspaces interleave', async () => {
    // One engine, two teams, and deliberately the SAME display name — a listener
    // keying on teamName cannot tell these two walks apart.
    const perTeam: TokenSource = {
      tryGet: async (_profileId, teamId) => (teamId === 'T1' ? 'xoxp-t1' : 'xoxp-t2')
    }
    listChannelsMock.mockImplementation(async (token: string) =>
      token === 'xoxp-t1' ? [channel('C1'), channel('C2')] : [channel('C9')]
    )
    // T1 parks on its second channel so T2's ticks land inside T1's span.
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    listMessagesMock.mockImplementation(async (_token: string, channelId: string) => {
      if (channelId === 'C2') await gate
      return [message('1700000001.000000')]
    })

    const engine = new SyncEngine({
      tokenStore: perTeam,
      dashboardStore: store,
      onProgress: (p) => progress.push(p)
    })
    const t1 = engine.syncWorkspace(TEAM)
    try {
      await vi.waitFor(() =>
        expect(progress.some((p) => p.teamId === 'T1' && p.channelIndex === 1)).toBe(true)
      )
      await engine.syncWorkspace(TEAM_TWIN)
    } finally {
      open()
    }
    await t1

    // Genuinely interleaved: T2's ticks are sandwiched between T1's.
    const firstT2 = progress.findIndex((p) => p.teamId === 'T2')
    const lastT2 = progress.map((p) => p.teamId).lastIndexOf('T2')
    const firstT1After = progress.findIndex((p, i) => i > lastT2 && p.teamId === 'T1')
    expect(firstT2).toBeGreaterThan(-1)
    expect(lastT2).toBeGreaterThan(firstT2)
    expect(firstT1After).toBeGreaterThan(lastT2)
    // Both display names are identical, so teamId is the only thing that separates them.
    expect(new Set(progress.map((p) => p.teamName))).toEqual(new Set(['Acme']))
    expect(progress.every((p) => p.teamId === 'T1' || p.teamId === 'T2')).toBe(true)
    // And each team's own tick sequence is intact — no foreign tick inside a run.
    for (const team of ['T1', 'T2']) {
      const mine = progress.filter((p) => p.teamId === team)
      expect(mine.at(-1)?.phase).toBe('done')
      expect(mine.map((p) => p.phase)).toEqual([
        'listing-channels',
        ...mine.slice(1, -1).map(() => 'reading-messages'),
        'done'
      ])
    }
  })

  // --- Rate-limit visibility ----------------------------------------------------

  it('reports the pending request while a rate-limited call is backing off', async () => {
    // Stands in for `withRetry`'s internal setTimeout: the call is outstanding and
    // the engine is parked inside it, so no further tick can arrive.
    listChannelsMock.mockResolvedValue([channel('C1')])
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    listMessagesMock.mockImplementation(async () => {
      await gate
      return [message('1700000001.000000')]
    })

    const engine = build()
    const walk = engine.syncWorkspace(TEAM)
    try {
      await vi.waitFor(() =>
        expect(progress.some((p) => p.phase === 'reading-messages')).toBe(true)
      )

      // The UI's three liveness facts during the wait: the workspace is still
      // claimed, the last tick names the request being waited on, and that tick
      // names the workspace too.
      expect(engine.isSyncing('T1')).toBe(true)
      const pending = progress.at(-1)
      expect(pending?.phase).toBe('reading-messages')
      expect(pending?.channelIndex).toBe(0)
      expect(pending?.channelTotal).toBe(1)
      expect(pending?.teamId).toBe('T1')
    } finally {
      open()
    }
    await walk

    // The wait ended normally — it was a backoff, not a wedge.
    expect(engine.isSyncing('T1')).toBe(false)
    expect(progress.at(-1)?.phase).toBe('done')
  })
})
