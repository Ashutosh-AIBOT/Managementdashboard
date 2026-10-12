import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels, type IpcApi } from '../../src/shared/ipc-contract'
import type { DashboardSnapshot, SyncProgressPayload } from '../../src/shared/types'
import { AiAnalyzer, type AiMessageResult, type AiProvider } from '../../src/main/slack/ai-analyzer'
import { DashboardStore } from '../../src/main/slack/dashboard-store'
import {
  ReconnectRequiredError,
  SyncInProgressError,
  type SyncEngine,
  type SyncProgress
} from '../../src/main/slack/sync-engine'
import {
  DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
  autoSyncIntervalMs,
  registerSlackDashboardIpc,
  runDashboardSync,
  workspacesDueForAutoSync,
  type DashboardEventTarget,
  type SlackDashboardIpcDeps
} from '../../src/main/ipc/slack-dashboard.ipc'

/**
 * `handle.ts` is the only thing in this module's import graph that touches
 * Electron — every dependency the handlers use arrives through the `deps`
 * object. Stubbing the registration helper captures the handlers so they can be
 * invoked directly, with no Electron runtime and no behavioural fakery inside
 * the code under test. `electron` itself is never mocked.
 */
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (payload: unknown) => Promise<unknown>>()
}))

vi.mock('../../src/main/ipc/handle', () => ({
  handleInvoke: (channel: string, handler: (payload: unknown) => Promise<unknown>): void => {
    ipcHandlers.set(channel, handler)
  }
}))

/** The six methods the contract declares. A change here is a contract change. */
const CONTRACT_METHODS: Array<keyof IpcApi['slackDashboard']> = [
  'get',
  'syncNow',
  'setAutoSync',
  'clear',
  'onProgress',
  'onReconnectNeeded'
]

const CHANNEL_OF_METHOD: Record<(typeof CONTRACT_METHODS)[number], keyof typeof IpcChannels> = {
  get: 'SlackDashboardGet',
  syncNow: 'SlackDashboardSyncNow',
  setAutoSync: 'SlackDashboardSetAutoSync',
  clear: 'SlackDashboardClear',
  onProgress: 'SlackDashboardProgress',
  onReconnectNeeded: 'SlackDashboardReconnectNeeded'
}

/**
 * `true` only when `A` and `B` have the same keys in both directions; `never`
 * otherwise, which makes `return true` a compile error.
 *
 * Key equality rather than assignability on purpose: `SyncProgress` is an alias
 * of `SyncProgressPayload` today, so an assignability check would be satisfied by
 * the alias itself and would prove nothing if someone split them again. Comparing
 * `keyof` both ways survives that split.
 */
type ExactSameKeys<A, B> = [Exclude<keyof A, keyof B>] extends [never]
  ? [Exclude<keyof B, keyof A>] extends [never]
    ? true
    : never
  : never

/** Called below, so the conditional in the return type must be resolved. */
function progressShapesMatch(): ExactSameKeys<SyncProgress, SyncProgressPayload> {
  return true
}

function invoke(channel: keyof typeof IpcChannels, payload?: unknown): Promise<unknown> {
  const handler = ipcHandlers.get(IpcChannels[channel])
  if (!handler) throw new Error(`no handler registered for ${IpcChannels[channel]}`)
  return handler(payload)
}

/**
 * Index of the `}` that closes the `{` at `start`, by brace counting.
 *
 * Scanning to the next column-zero `}` was correct only because `slackDashboard`
 * happened to be the last property of `api`; adding one after it would have
 * silently truncated the block and made the assertion pass on a namespace that
 * no longer matched. String literals are skipped so a `}` inside one cannot
 * unbalance the count.
 */
function braceBlockEnd(source: string, start: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('unbalanced braces in the preload namespace')
}

/** Start offset of a top-level method's own line inside the preload namespace. */
function methodIndexOf(block: string, method: string): number {
  const index = block.search(new RegExp(`^ {4}${method}\\s*[:(]`, 'm'))
  if (index < 0) throw new Error(`preload does not declare ${method}`)
  return index
}

const NOW_MS = Date.UTC(2026, 0, 15)
/** `ts` is `seconds.fraction`; this one sits inside the retention window. */
const RECENT_TS = String(NOW_MS / 1000 + 0.001)

interface Harness {
  deps: SlackDashboardIpcDeps
  sent: Array<{ channel: string; payload: unknown }>
  store: DashboardStore
}

describe('dashboard IPC contract', () => {
  let dir: string
  let harness: Harness

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slack-dashboard-ipc-'))
    ipcHandlers.clear()
    harness = buildHarness({ provider: null })
    registerSlackDashboardIpc(harness.deps)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps every channel string unique across IpcChannels', () => {
    const values = Object.values(IpcChannels)
    const duplicates = values.filter((value, i) => values.indexOf(value) !== i)
    expect(duplicates).toEqual([])
    expect(new Set(values).size).toBe(values.length)
  })

  /**
   * The drift check for `SyncProgressPayload`, in a position the compiler is
   * forced to resolve.
   *
   * The previous version asserted equality with a conditional type in an
   * *exported type alias* and nothing else. That was inert: an unused type alias
   * is never evaluated, so reverting the engine to its own separate declaration
   * — and adding a field to one side only — both still compiled clean. This one
   * is a function that is called, with the conditional in its *return type*, so
   * `tsc` must resolve it and a mismatch becomes a compile error. Two keys on one
   * side only is the specific drift that matters: the renderer would read a field
   * the engine never sends.
   */
  it('gives the engine tick and the wire payload exactly the same keys', () => {
    expect(progressShapesMatch()).toBe(true)

    // And at the value level, so the claim is also checked at runtime.
    const tick: SyncProgress = {
      phase: 'reading-messages',
      teamId: 'T1',
      teamName: 'Acme',
      channelIndex: 0,
      channelTotal: 3,
      messageCount: 10
    }
    const payload: SyncProgressPayload = tick
    const backAgain: SyncProgress = payload

    expect(backAgain).toEqual(tick)
    expect(Object.keys(payload).sort()).toEqual(
      ['channelIndex', 'channelTotal', 'messageCount', 'phase', 'teamId', 'teamName'].sort()
    )
  })

  it('keeps every phase the engine can emit in the shared union', () => {
    // `'analyzing'` is emitted by the IPC pipeline, not the walk, so nothing else
    // would notice if it fell out of the shared union.
    const phases: SyncProgressPayload['phase'][] = [
      'idle',
      'listing-channels',
      'reading-messages',
      'analyzing',
      'done',
      'error'
    ]
    const tick: SyncProgress = {
      phase: phases[3],
      teamId: 'T1',
      teamName: 'Acme',
      channelIndex: 1,
      channelTotal: 2,
      messageCount: 0
    }
    expect(tick.phase).toBe('analyzing')
  })

  it('names the six dashboard channels exactly once each', () => {
    expect(Object.values(IpcChannels).filter((c) => c.startsWith('slack-dashboard:'))).toEqual([
      'slack-dashboard:get',
      'slack-dashboard:sync-now',
      'slack-dashboard:progress',
      'slack-dashboard:set-auto-sync',
      'slack-dashboard:clear',
      'slack-dashboard:reconnect-needed'
    ])
  })

  it('registers a handler for every channel the preload can reach', () => {
    for (const method of CONTRACT_METHODS) {
      const channel = IpcChannels[CHANNEL_OF_METHOD[method]]
      if (method === 'onProgress' || method === 'onReconnectNeeded') continue
      expect(ipcHandlers.has(channel), `${method} -> ${channel}`).toBe(true)
    }
  })

  it('exposes exactly the methods the contract declares through the preload', async () => {
    const source = await readFile(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const start = source.indexOf('  slackDashboard: {')
    expect(start).toBeGreaterThan(-1)
    const block = source.slice(start, braceBlockEnd(source, start))

    const declared: string[] = []
    for (const line of block.split('\n')) {
      // Four spaces is the namespace's own indentation; nested lines are deeper.
      const match = /^ {4}([A-Za-z]\w*)\s*[:(]/.exec(line)
      if (match) declared.push(match[1])
    }
    expect(declared).toEqual(CONTRACT_METHODS)

    // And the namespace reaches exactly those six channels and no others.
    // (Each listener names its channel twice — `on` and `removeListener` — so
    // this compares distinct names rather than occurrence order.)
    const referenced = new Set(
      [...block.matchAll(/IpcChannels\.(\w+)/g)].map(
        (m) => IpcChannels[m[1] as keyof typeof IpcChannels]
      )
    )
    expect(referenced).toEqual(
      new Set(CONTRACT_METHODS.map((method) => IpcChannels[CHANNEL_OF_METHOD[method]]))
    )
    // The first channel each method names is the one it invokes.
    for (const method of CONTRACT_METHODS) {
      const first = /IpcChannels\.(\w+)/.exec(block.slice(methodIndexOf(block, method)))
      expect(first?.[1]).toBe(CHANNEL_OF_METHOD[method])
    }
  })

  it('reports aiConfigured false and does not throw when no API key is set', async () => {
    // A store with real messages in it, so `aiEligible` is genuinely non-zero:
    // the point is that "no key" is readable *without* looking like "failing".
    await harness.store.recordMessages({
      teamId: 'T1',
      channelId: 'C1',
      channelName: 'general',
      isPrivate: false,
      messages: [
        { ts: RECENT_TS, user: 'U1', text: 'shipped it' },
        { ts: String(Number(RECENT_TS) + 1), user: 'U1', text: '' }
      ],
      syncedAt: new Date(NOW_MS).toISOString()
    })

    const snapshot = (await invoke('SlackDashboardGet')) as DashboardSnapshot
    const channel = snapshot.workspaces.T1.channels.C1

    expect(channel.aiConfigured).toBe(false)
    // Whitespace-only text is not analysable, so it never counts as eligible.
    expect(channel.aiEligible).toBe(1)
    expect(channel.aiAnalyzed).toBe(0)
    expect(channel.recentMessages).toHaveLength(2)
  })

  it('keys workspaces on teamId, never on a shared display name', async () => {
    await seedWorkspace(harness, 'T1', 'Acme')
    await seedWorkspace(harness, 'T2', 'Acme')
    stubSyncEngine(harness, { syncing: new Set(['T2']) })

    const snapshot = (await invoke('SlackDashboardGet')) as DashboardSnapshot

    expect(Object.keys(snapshot.workspaces).sort()).toEqual(['T1', 'T2'])
    expect(snapshot.syncingTeamIds).toEqual(['T2'])
  })
})

describe('dashboard sync-now', () => {
  let dir: string
  let harness: Harness

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slack-dashboard-ipc-sync-'))
    ipcHandlers.clear()
    harness = buildHarness({ provider: null })
    registerSlackDashboardIpc(harness.deps)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('invokes pruneOldMessages after a successful sync', async () => {
    const prune = vi.spyOn(harness.store, 'pruneOldMessages')
    const order: string[] = []
    prune.mockImplementation(async () => {
      order.push('prune')
      return 0
    })
    stubSyncEngine(harness, {
      syncWorkspace: async (input) => {
        order.push('sync')
        expect(prune).not.toHaveBeenCalled()
        return { teamId: input.teamId, messagesRead: 3, channelsSynced: 1 }
      }
    })

    const result = (await invoke('SlackDashboardSyncNow', {
      profileId: 'p1',
      teamId: 'T1'
    })) as { ok: boolean; pruned: number }

    expect(result.ok).toBe(true)
    expect(prune).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['sync', 'prune'])
  })

  it('still prunes when the store has a real retention backlog', async () => {
    const old = String((NOW_MS - 200 * 24 * 3600 * 1000) / 1000 + 0.001)
    await harness.store.recordMessages({
      teamId: 'T1',
      channelId: 'C1',
      channelName: 'general',
      isPrivate: false,
      messages: [
        { ts: old, user: 'U1', text: 'ancient' },
        { ts: RECENT_TS, user: 'U1', text: 'current' }
      ],
      syncedAt: new Date(NOW_MS).toISOString()
    })
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    stubSyncEngine(harness, {})

    try {
      const result = (await invoke('SlackDashboardSyncNow', {
        profileId: 'p1',
        teamId: 'T1'
      })) as { ok: boolean; pruned: number }

      expect(result.pruned).toBe(1)
      const file = await harness.store.read()
      expect(file.workspaces.T1.channels.C1.recentMessages.map((m) => m.text)).toEqual(['current'])
      // Aggregates are lifetime facts and must survive the prune.
      expect(file.workspaces.T1.channels.C1.totalMessages).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a failed sync without pruning, so the walk can be retried', async () => {
    const prune = vi.spyOn(harness.store, 'pruneOldMessages')
    stubSyncEngine(harness, {
      syncWorkspace: async () => {
        throw new Error('slack exploded')
      }
    })

    const result = (await invoke('SlackDashboardSyncNow', {
      profileId: 'p1',
      teamId: 'T1'
    })) as { ok: boolean; reason: string; message: string }

    expect(result).toMatchObject({ ok: false, reason: 'failed', message: 'slack exploded' })
    expect(prune).not.toHaveBeenCalled()
  })

  it('distinguishes a dead token from a busy workspace', async () => {
    stubSyncEngine(harness, {
      syncWorkspace: async (input) => {
        throw new ReconnectRequiredError(input.teamId)
      }
    })

    const result = (await invoke('SlackDashboardSyncNow', {
      profileId: 'p1',
      teamId: 'T1'
    })) as { ok: boolean; reason: string }

    expect(result.reason).toBe('reconnect-required')
    expect(harness.sent).toContainEqual({
      channel: IpcChannels.SlackDashboardReconnectNeeded,
      payload: { teamId: 'T1', teamName: 'T1' }
    })

    harness.sent.length = 0
    stubSyncEngine(harness, {
      syncWorkspace: async (input) => {
        throw new SyncInProgressError(input.teamId)
      }
    })
    const busy = (await invoke('SlackDashboardSyncNow', {
      profileId: 'p1',
      teamId: 'T1'
    })) as { ok: boolean; reason: string }

    // A busy workspace is not a reconnect problem and must not prompt for one.
    expect(busy.reason).toBe('already-syncing')
    expect(harness.sent).toEqual([])
  })

  it('prefers the stored workspace name over one supplied by the renderer', async () => {
    await harness.store.upsertWorkspace({ teamId: 'T1', teamName: 'Acme', profileId: 'p1' })
    const seen: Array<{ teamId: string; teamName: string; profileId: string }> = []
    stubSyncEngine(harness, {
      syncWorkspace: async (input) => {
        seen.push(input)
        return { teamId: input.teamId, messagesRead: 0, channelsSynced: 0 }
      }
    })

    await invoke('SlackDashboardSyncNow', { profileId: 'p1', teamId: 'T1', teamName: 'Acm' })

    expect(seen[0].teamName).toBe('Acme')
  })

  it('labels the window it kept and folds the labels into the rollups', async () => {
    const labelled = buildHarness({
      provider: {
        analyze: async (messages) => {
          const out = new Map<string, AiMessageResult>()
          for (const m of messages) {
            out.set(m.ts, { sentiment: 'positive', score: 0.5, completionHint: 'done' })
          }
          return out
        }
      },
      dir: await mkdtemp(join(tmpdir(), 'slack-dashboard-ipc-ai-'))
    })
    registerSlackDashboardIpc(labelled.deps)
    await labelled.store.recordMessages({
      teamId: 'T1',
      channelId: 'C1',
      channelName: 'general',
      isPrivate: false,
      messages: [{ ts: RECENT_TS, user: 'U1', text: 'shipped it' }],
      syncedAt: new Date(NOW_MS).toISOString()
    })
    stubSyncEngine(labelled, {})
    const prune = vi.spyOn(labelled.store, 'pruneOldMessages').mockResolvedValue(0)

    await invoke('SlackDashboardSyncNow', { profileId: 'p1', teamId: 'T1' })

    const file = await labelled.store.read()
    expect(file.workspaces.T1.channels.C1.recentMessages[0].sentiment).toBe('positive')
    expect(file.workspaces.T1.channels.C1.sentimentScore).toBe(0.5)
    expect(file.workspaces.T1.channels.C1.completionEstimate).toBe(1)

    // Re-read: labels now count, so the channel reads healthy rather than failing.
    const snapshot = (await invoke('SlackDashboardGet')) as DashboardSnapshot
    expect(snapshot.workspaces.T1.channels.C1).toMatchObject({
      aiConfigured: true,
      aiEligible: 1,
      aiAnalyzed: 1
    })
    expect(prune).toHaveBeenCalledTimes(1)
  })

  /**
   * A complete provider failure must not leave the previous run's labels in
   * place. If it does, `aiAnalyzed` keeps equalling `aiEligible` and the
   * dashboard renders week-old sentiment as a fresh, healthy analysis.
   */
  it('clears stale labels when the provider stops returning results', async () => {
    // The prune inside the pipeline is real here, and its cutoff is "now", so the
    // clock is pinned or a fixed RECENT_TS would age out mid-test.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    let healthy = true
    const flaky = buildHarness({
      provider: {
        analyze: async (messages) => {
          if (!healthy) throw new Error('provider is down')
          const out = new Map<string, AiMessageResult>()
          for (const m of messages) {
            out.set(m.ts, { sentiment: 'positive', score: 0.5 })
          }
          return out
        }
      },
      dir: await mkdtemp(join(tmpdir(), 'slack-dashboard-ipc-stale-'))
    })
    registerSlackDashboardIpc(flaky.deps)
    await flaky.store.recordMessages({
      teamId: 'T1',
      channelId: 'C1',
      channelName: 'general',
      isPrivate: false,
      messages: [{ ts: RECENT_TS, user: 'U1', text: 'shipped it' }],
      syncedAt: new Date(NOW_MS).toISOString()
    })
    stubSyncEngine(flaky, {})

    await invoke('SlackDashboardSyncNow', { profileId: 'p1', teamId: 'T1' })
    const afterGood = (await invoke('SlackDashboardGet')) as DashboardSnapshot
    expect(afterGood.workspaces.T1.channels.C1).toMatchObject({
      aiEligible: 1,
      aiAnalyzed: 1
    })

    healthy = false
    await invoke('SlackDashboardSyncNow', { profileId: 'p1', teamId: 'T1' })

    const file = await flaky.store.read()
    expect(file.workspaces.T1.channels.C1.recentMessages[0].sentiment).toBeUndefined()

    // Reported as un-analysed, not as a stale success.
    const afterBad = (await invoke('SlackDashboardGet')) as DashboardSnapshot
    expect(afterBad.workspaces.T1.channels.C1).toMatchObject({
      aiConfigured: true,
      aiEligible: 1,
      aiAnalyzed: 0
    })
    vi.useRealTimers()
  })

  it('divides the channel rollups by eligible, not by labelled', async () => {
    // Two analysable messages, one labelled: over `labelled` both metrics would
    // round to 1 and the partial result would read as a perfect analysis.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const partial = buildHarness({
      provider: {
        analyze: async (messages) => {
          const first = messages[0]
          return new Map([[first.ts, { sentiment: 'positive', score: 1, completionHint: 'ok' }]])
        }
      },
      dir: await mkdtemp(join(tmpdir(), 'slack-dashboard-ipc-partial-'))
    })
    registerSlackDashboardIpc(partial.deps)
    const base = Number(RECENT_TS)
    await partial.store.recordMessages({
      teamId: 'T1',
      channelId: 'C1',
      channelName: 'general',
      isPrivate: false,
      messages: [
        { ts: RECENT_TS, user: 'U1', text: 'shipped it' },
        { ts: String(base + 1), user: 'U1', text: 'still going' }
      ],
      syncedAt: new Date(NOW_MS).toISOString()
    })
    stubSyncEngine(partial, {})

    await invoke('SlackDashboardSyncNow', { profileId: 'p1', teamId: 'T1' })

    const channel = (await partial.store.read()).workspaces.T1.channels.C1
    expect(channel.sentimentScore).toBe(0.5)
    expect(channel.completionEstimate).toBe(0.5)
    vi.useRealTimers()
  })

  it('emits the analyzing phase and holds the lock through prune and analysis', async () => {
    const phases: string[] = []
    let syncingDuringPrune: boolean | null = null
    const observed = buildHarness({
      provider: {
        analyze: async (messages) =>
          new Map(messages.map((m) => [m.ts, { sentiment: 'neutral', score: 0 }]))
      },
      dir: await mkdtemp(join(tmpdir(), 'slack-dashboard-ipc-phase-'))
    })
    registerSlackDashboardIpc(observed.deps)
    await observed.store.recordMessages({
      teamId: 'T1',
      channelId: 'C1',
      channelName: 'general',
      isPrivate: false,
      messages: [{ ts: RECENT_TS, user: 'U1', text: 'hello' }],
      syncedAt: new Date(NOW_MS).toISOString()
    })
    // A real `Set`, so the stub's `isSyncing` reflects the lock the pipeline holds.
    const busy = new Set<string>()
    stubSyncEngine(observed, {
      syncing: busy,
      emitProgress: (progress) => {
        phases.push(progress.phase)
        if (progress.phase === 'analyzing') {
          syncingDuringPrune = busy.has(progress.teamId)
        }
      }
    })
    vi.spyOn(observed.store, 'pruneOldMessages').mockImplementation(async () => {
      syncingDuringPrune = busy.has('T1')
      return 0
    })

    await invoke('SlackDashboardSyncNow', { profileId: 'p1', teamId: 'T1' })

    expect(phases).toContain('analyzing')
    // The lock must still be held during prune and analysis, not just the walk.
    expect(syncingDuringPrune).toBe(true)
    expect(busy.has('T1')).toBe(false)
  })

  it('refuses a second sync while the first pipeline still holds the lock', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const overlapping = buildHarness({ provider: null })
    registerSlackDashboardIpc(overlapping.deps)
    await seedWorkspace(overlapping, 'T1', 'Acme')
    stubSyncEngine(overlapping, {
      syncWorkspace: async (input) => {
        await gate
        return { teamId: input.teamId, messagesRead: 0, channelsSynced: 0 }
      }
    })
    vi.spyOn(overlapping.store, 'pruneOldMessages').mockImplementation(async () =>
      gate.then(() => 0)
    )

    const first = invoke('SlackDashboardSyncNow', { profileId: 'p1', teamId: 'T1' })
    // The walk has finished; prune is blocked inside the same lock hold.
    await Promise.resolve()
    const second = (await invoke('SlackDashboardSyncNow', {
      profileId: 'p1',
      teamId: 'T1'
    })) as { ok: boolean; reason: string }

    expect(second).toMatchObject({ ok: false, reason: 'already-syncing' })

    release()
    expect(((await first) as { ok: boolean }).ok).toBe(true)
  })

  it('leaves a workspace with no channels alone and does not throw', async () => {
    const empty = buildHarness({
      provider: { analyze: async () => new Map() },
      dir: await mkdtemp(join(tmpdir(), 'slack-dashboard-ipc-empty-'))
    })
    registerSlackDashboardIpc(empty.deps)
    // A workspace with zero channels: registered, but nothing to analyse.
    await empty.store.upsertWorkspace({ teamId: 'T1', teamName: 'Acme', profileId: 'p1' })
    stubSyncEngine(empty, {})

    await expect(
      invoke('SlackDashboardSyncNow', { profileId: 'p1', teamId: 'T1' })
    ).resolves.toMatchObject({ ok: true })
    expect((await empty.store.read()).workspaces.T1.channels).toEqual({})
  })

  it('does not throw when the workspace is absent from the store entirely', async () => {
    const absent = buildHarness({
      provider: { analyze: async () => new Map() },
      dir: await mkdtemp(join(tmpdir(), 'slack-dashboard-ipc-absent-'))
    })
    registerSlackDashboardIpc(absent.deps)
    stubSyncEngine(absent, {})

    // The stub records nothing, so the analysis pass reads a workspace that was
    // never written — the shape a walk that returned zero channels produces.
    await expect(
      invoke('SlackDashboardSyncNow', { profileId: 'p1', teamId: 'T-missing' })
    ).resolves.toMatchObject({ ok: true })
  })

  it('never sends a provider the whole file when no key is configured', async () => {
    const provider = { analyze: vi.fn() }
    const offline = buildHarness({ provider })
    registerSlackDashboardIpc(offline.deps)
    await offline.store.recordMessages({
      teamId: 'T1',
      channelId: 'C1',
      channelName: 'general',
      isPrivate: false,
      messages: [{ ts: RECENT_TS, user: 'U1', text: 'shipped it' }],
      syncedAt: new Date(NOW_MS).toISOString()
    })
    stubSyncEngine(offline, {})

    await invoke('SlackDashboardSyncNow', { profileId: 'p1', teamId: 'T1' })

    expect(provider.analyze).not.toHaveBeenCalled()
  })
})

describe('dashboard settings and clear', () => {
  let dir: string
  let harness: Harness

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slack-dashboard-ipc-set-'))
    ipcHandlers.clear()
    harness = buildHarness({ provider: null })
    registerSlackDashboardIpc(harness.deps)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('persists auto-sync and reports it back in the snapshot', async () => {
    const snapshotBefore = (await invoke('SlackDashboardGet')) as DashboardSnapshot
    expect(snapshotBefore.settings).toEqual({ autoSync: false })

    const settings = (await invoke('SlackDashboardSetAutoSync', true)) as { autoSync: boolean }
    expect(settings).toEqual({ autoSync: true })

    const snapshotAfter = (await invoke('SlackDashboardGet')) as DashboardSnapshot
    expect(snapshotAfter.settings).toEqual({ autoSync: true })
  })

  it('clears one workspace when scoped and all of them when not', async () => {
    await seedWorkspace(harness, 'T1', 'Acme')
    await seedWorkspace(harness, 'T2', 'Globex')

    await invoke('SlackDashboardClear', { teamId: 'T1' })
    let file = await harness.store.read()
    expect(Object.keys(file.workspaces)).toEqual(['T2'])

    await invoke('SlackDashboardClear')
    file = await harness.store.read()
    expect(file.workspaces).toEqual({})
  })

  it('rejects a malformed auto-sync payload rather than switching it off', async () => {
    // Silently coercing to `false` would disable a preference the user turned on,
    // with no error anywhere and nothing to notice it by.
    for (const bad of [undefined, null, 'true', 0, 1, {}, []]) {
      await expect(invoke('SlackDashboardSetAutoSync', bad)).rejects.toThrow(/boolean/)
    }
    // The stored preference is untouched by a rejected call.
    expect((await invoke('SlackDashboardGet')) as DashboardSnapshot).toMatchObject({
      settings: { autoSync: false }
    })
  })

  it('refuses to clear a workspace that is mid-walk', async () => {
    await seedWorkspace(harness, 'T1', 'Acme')
    const syncing = new Set<string>(['T1'])
    stubSyncEngine(harness, { syncing })

    // Clearing underneath a walk lets the walk's next `recordMessages` re-create
    // the workspace, so the user's clear silently un-does itself.
    await expect(invoke('SlackDashboardClear', { teamId: 'T1' })).rejects.toThrow(/syncing/)
    expect(Object.keys((await harness.store.read()).workspaces)).toEqual(['T1'])

    // An unscoped clear would hit the same walk, so it is refused too.
    await expect(invoke('SlackDashboardClear')).rejects.toThrow(/syncing/)

    syncing.clear()
    await invoke('SlackDashboardClear', { teamId: 'T1' })
    expect((await harness.store.read()).workspaces).toEqual({})
  })
})

describe('auto-sync driver', () => {
  it('does nothing unless the user asked for it', () => {
    expect(
      workspacesDueForAutoSync({
        enabled: false,
        ready: true,
        syncingTeamIds: [],
        knownTeamIds: ['T1', 'T2']
      })
    ).toEqual([])
  })

  it('does nothing before Electron is ready', () => {
    // A timer firing before `whenReady` would read `userData` before it resolves.
    expect(
      workspacesDueForAutoSync({
        enabled: true,
        ready: false,
        syncingTeamIds: [],
        knownTeamIds: ['T1']
      })
    ).toEqual([])
  })

  it('syncs every known workspace when enabled, ready and idle', () => {
    expect(
      workspacesDueForAutoSync({
        enabled: true,
        ready: true,
        syncingTeamIds: [],
        knownTeamIds: ['T1', 'T2', 'T3']
      })
    ).toEqual(['T1', 'T2', 'T3'])
  })

  it('skips only the workspaces already walking', () => {
    // Per workspace, not global: one rate-limited workspace must not stop the
    // others from refreshing.
    expect(
      workspacesDueForAutoSync({
        enabled: true,
        ready: true,
        syncingTeamIds: ['T2'],
        knownTeamIds: ['T1', 'T2', 'T3']
      })
    ).toEqual(['T1', 'T3'])
  })

  it('keys on teamId, so two workspaces sharing a display name both refresh', () => {
    expect(
      workspacesDueForAutoSync({
        enabled: true,
        ready: true,
        syncingTeamIds: ['T1'],
        knownTeamIds: ['T1', 'T2']
      })
    ).toEqual(['T2'])
  })

  it('starts with nothing known to sync', () => {
    expect(
      workspacesDueForAutoSync({
        enabled: true,
        ready: true,
        syncingTeamIds: [],
        knownTeamIds: []
      })
    ).toEqual([])
  })

  it('defaults to 15 minutes and clamps a bad override', () => {
    expect(autoSyncIntervalMs(undefined)).toBe(15 * 60_000)
    expect(autoSyncIntervalMs('')).toBe(15 * 60_000)
    expect(autoSyncIntervalMs('nonsense')).toBe(15 * 60_000)
    expect(autoSyncIntervalMs('0')).toBe(15 * 60_000)
    expect(DEFAULT_AUTO_SYNC_INTERVAL_MINUTES).toBe(15)

    expect(autoSyncIntervalMs('5')).toBe(5 * 60_000)
    // Nonsense falls back to the default rather than clamping to the floor, which
    // would be the most expensive reading of a typo against a rate-limited API.
    expect(autoSyncIntervalMs('-5')).toBe(15 * 60_000)
    expect(autoSyncIntervalMs('99999')).toBe(1440 * 60_000)
    expect(autoSyncIntervalMs('2.6')).toBe(3 * 60_000)
    // Rounds before clamping, so a sub-minute value cannot become a 0ms interval.
    expect(autoSyncIntervalMs('0.4')).toBe(1 * 60_000)
  })

  it('runs an automatic sync through the same pipeline as a manual one', async () => {
    const auto = buildHarness({
      provider: { analyze: async () => new Map() },
      dir: await mkdtemp(join(tmpdir(), 'slack-dashboard-ipc-auto-'))
    })
    const walked: string[] = []
    await seedWorkspace(auto, 'T1', 'Acme')
    stubSyncEngine(auto, {
      syncWorkspace: async (input) => {
        walked.push(input.teamId)
        return { teamId: input.teamId, messagesRead: 1, channelsSynced: 1 }
      }
    })
    const prune = vi.spyOn(auto.store, 'pruneOldMessages').mockResolvedValue(0)

    const result = await runDashboardSync(auto.deps, { profileId: 'p1', teamId: 'T1' })

    expect(walked).toEqual(['T1'])
    // Same pipeline: the follow-up ran, so the retention window is still enforced
    // on a sync nobody clicked.
    expect(prune).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, teamId: 'T1' })
  })
})

/* ------------------------------------------------------------------ */

interface StubOptions {
  syncWorkspace?: (input: {
    profileId: string
    teamId: string
    teamName: string
  }) => Promise<{ teamId: string; messagesRead: number; channelsSynced: number }>
  /** Seeds `isSyncing`, for cases that need a workspace busy before any walk. */
  syncing?: Set<string>
  emitProgress?: (progress: SyncProgress) => void
}

/**
 * A stand-in for the engine that reproduces the one behaviour the pipeline
 * depends on: the workspace is locked for the whole of `walk` *and* `followUp`,
 * and a second call while that is true is refused. The real `SyncEngine` is
 * covered by `sync-engine.test.ts`; what matters here is that this stub cannot
 * pass by being more permissive than the real thing.
 */
function stubSyncEngine(harness: Harness, opts: StubOptions): void {
  const syncing = opts.syncing ?? new Set<string>()
  const walk =
    opts.syncWorkspace ?? (async (input) => ({ ...input, messagesRead: 0, channelsSynced: 0 }))
  harness.deps.syncEngine = {
    syncWorkspace: walk,
    syncWorkspaceWithFollowUp: async (
      input: { profileId: string; teamId: string; teamName: string },
      followUp: (result: {
        teamId: string
        messagesRead: number
        channelsSynced: number
      }) => Promise<unknown>
    ) => {
      if (syncing.has(input.teamId)) {
        throw new SyncInProgressError(input.teamId)
      }
      syncing.add(input.teamId)
      try {
        return await followUp(await walk(input))
      } finally {
        syncing.delete(input.teamId)
      }
    },
    emitProgress: opts.emitProgress ?? ((): void => undefined),
    isSyncing: (teamId: string) => syncing.has(teamId)
  } as unknown as SyncEngine
}

/** The genuine store on a tmp path — a stub could not fail the way a real one does. */
function buildHarness(opts: { provider: AiProvider | null; dir?: string }): Harness {
  const filePath = join(opts.dir ?? tmpdir(), `dashboard-${randomSuffix()}.json`)
  const store = new DashboardStore({ filePath })
  const sent: Array<{ channel: string; payload: unknown }> = []
  const window: DashboardEventTarget = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) }
  }
  let autoSync = false

  return {
    store,
    sent,
    deps: {
      syncEngine: {
        syncWorkspace: async () => ({ teamId: '', messagesRead: 0, channelsSynced: 0 }),
        isSyncing: () => false
      } as unknown as SyncEngine,
      dashboardStore: store,
      settingsStore: {
        get: async () => ({ autoSync }),
        set: async (patch) => {
          autoSync = patch.autoSync === true
          return { autoSync }
        }
      },
      aiAnalyzer: new AiAnalyzer({ provider: opts.provider }),
      getMainWindow: () => window
    }
  }
}

let seq = 0
function randomSuffix(): string {
  seq += 1
  return `${process.pid}-${seq}`
}

async function seedWorkspace(harness: Harness, teamId: string, teamName: string): Promise<void> {
  await harness.store.upsertWorkspace({ teamId, teamName, profileId: 'p1' })
  await harness.store.recordMessages({
    teamId,
    channelId: 'C1',
    channelName: 'general',
    isPrivate: false,
    messages: [{ ts: RECENT_TS, user: 'U1', text: 'hello' }],
    syncedAt: new Date(NOW_MS).toISOString()
  })
}
