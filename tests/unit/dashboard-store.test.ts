import { readFileSync } from 'fs'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DASHBOARD_VERSION,
  DashboardStore,
  MESSAGE_RETENTION_DAYS,
  defaultDashboardPath
} from '../../src/main/slack/dashboard-store'

const NOW = new Date('2026-03-01T00:00:00.000Z')

const DAY_MS = 24 * 60 * 60 * 1000

/** Slack `ts` is Unix seconds with a fractional part; keep that shape. */
function tsAt(date: Date): string {
  return (date.getTime() / 1000).toFixed(6)
}

/** `seconds` separates messages that land on the same day — same day is not same ts. */
function at(daysBack: number, seconds = 0): Date {
  return new Date(NOW.getTime() - daysBack * DAY_MS + seconds * 1000)
}

function msg(date: Date, text: string, user?: string): { ts: string; user?: string; text: string } {
  return { ts: tsAt(date), ...(user ? { user } : {}), text }
}

describe('DashboardStore', () => {
  let dir: string
  let store: DashboardStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'slack-dashboard-dashboard-'))
    store = new DashboardStore({ filePath: join(dir, 'dashboard.json') })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('exposes a stable version and retention window', () => {
    expect(DASHBOARD_VERSION).toBe(1)
    expect(MESSAGE_RETENTION_DAYS).toBe(90)
  })

  it('builds dashboard.json inside userData', () => {
    expect(defaultDashboardPath('/tmp/userdata')).toBe('/tmp/userdata/dashboard.json')
  })

  describe('reading', () => {
    it('returns an empty file when the file does not exist', async () => {
      const file = await store.read()
      expect(file).toEqual({ version: DASHBOARD_VERSION, workspaces: {} })
    })

    it('rethrows errors that are not ENOENT', async () => {
      // A directory at the file path: readFile fails with EISDIR, not ENOENT.
      await mkdir(join(dir, 'dashboard.json'), { recursive: true })
      await expect(store.read()).rejects.toMatchObject({ code: 'EISDIR' })
    })

    it('resets to empty when the file holds corrupt JSON', async () => {
      await writeFile(join(dir, 'dashboard.json'), '{"version":1,"workspaces":', 'utf8')
      const file = await store.read()
      expect(file.workspaces).toEqual({})
    })

    it('recovers from a corrupt file by rewriting it on the next write', async () => {
      await writeFile(join(dir, 'dashboard.json'), 'not json at all', 'utf8')
      await store.upsertWorkspace({ teamId: 'T1', teamName: 'Acme', profileId: 'p1' })
      const raw = await readFile(join(dir, 'dashboard.json'), 'utf8')
      expect(() => JSON.parse(raw)).not.toThrow()
      expect((await store.read()).workspaces.T1.teamName).toBe('Acme')
    })

    it('parks an unparseable file instead of destroying it', async () => {
      // A lifetime aggregate that a failed write truncated to garbage.
      await writeFile(join(dir, 'dashboard.json'), '{"version":1,"workspaces":{"T', 'utf8')

      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(1), 'after the corruption')],
        syncedAt: NOW.toISOString()
      })

      const parked = (await readdir(dir)).filter((f) => f.includes('.corrupt-'))
      expect(parked).toHaveLength(1)
      // The bytes that were on disk are still recoverable.
      expect(await readFile(join(dir, parked[0]), 'utf8')).toBe('{"version":1,"workspaces":{"T')
      expect((await store.read()).workspaces.T1.channels.C1.recentMessages).toHaveLength(1)
    })

    it('parks the unparseable file even when update() is the caller', async () => {
      await writeFile(join(dir, 'dashboard.json'), '}{', 'utf8')
      await store.update((file) => {
        file.workspaces.T1 = {
          teamId: 'T1',
          teamName: 'Acme',
          profileId: 'p1',
          lastSyncAt: NOW.toISOString(),
          channels: {}
        }
      })
      const parked = (await readdir(dir)).filter((f) => f.includes('.corrupt-'))
      expect(parked).toHaveLength(1)
      expect(await readFile(join(dir, parked[0]), 'utf8')).toBe('}{')
    })
  })

  describe('workspaces', () => {
    it('upserts a workspace, keeping the first teamName when the later one is blank', async () => {
      await store.upsertWorkspace({ teamId: 'T1', teamName: 'Acme', profileId: 'p1' })
      await store.upsertWorkspace({ teamId: 'T1', teamName: '  ', profileId: 'p2' })
      const ws = (await store.read()).workspaces.T1
      expect(ws.teamName).toBe('Acme')
      expect(ws.profileId).toBe('p2')
      expect(Object.keys((await store.read()).workspaces)).toEqual(['T1'])
    })
  })

  describe('recordMessages', () => {
    it('accumulates aggregates across two syncs', async () => {
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(3, 10), 'one')],
        syncedAt: NOW.toISOString()
      })
      const rollup = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(1, 20), 'two'), msg(at(1, 30), 'three'), msg(at(1, 40), 'four')],
        syncedAt: NOW.toISOString()
      })

      expect(rollup.totalMessages).toBe(4)
      expect(rollup.dailyCounts[toDay(at(3))]).toBe(1)
      expect(rollup.dailyCounts[toDay(at(1))]).toBe(3)
      expect(rollup.recentMessages).toHaveLength(4)
      expect(rollup.channelName).toBe('general')
      expect(rollup.isPrivate).toBe(false)
    })

    it('advances lastSyncTs to the newest ts and never rewinds it', async () => {
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(5), 'older')],
        syncedAt: NOW.toISOString()
      })
      const newer = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(1), 'newer')],
        syncedAt: NOW.toISOString()
      })
      expect(newer.lastSyncTs).toBe(tsAt(at(1)))

      // An out-of-order page arriving late must not rewind the incremental cursor.
      const rewound = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(9), 'late')],
        syncedAt: NOW.toISOString()
      })
      expect(rewound.lastSyncTs).toBe(tsAt(at(1)))
      // The late page is below the cursor, so it was covered by an earlier sync
      // and must not be counted a second time.
      expect(rewound.totalMessages).toBe(2)
    })

    it('repairs a stored non-numeric cursor instead of trusting it', async () => {
      // A hand-edited or foreign-written file can leave garbage in the cursor.
      await writeFile(
        join(dir, 'dashboard.json'),
        JSON.stringify({
          version: 1,
          workspaces: {
            T1: {
              teamName: 'Acme',
              profileId: 'p1',
              lastSyncAt: NOW.toISOString(),
              channels: {
                C1: {
                  channelName: 'general',
                  isPrivate: false,
                  lastSyncTs: 'zzz',
                  totalMessages: 3,
                  dailyCounts: {},
                  recentMessages: []
                }
              }
            }
          }
        }),
        'utf8'
      )

      const rollup = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(1), 'real')],
        syncedAt: NOW.toISOString()
      })

      // 'zzz' > every digit, so a string fallback would keep the bad cursor and
      // strand every subsequent message.
      expect(rollup.lastSyncTs).toBe(tsAt(at(1)))
      expect(rollup.totalMessages).toBe(4)
    })

    it('never lets a non-numeric ts become the incremental cursor', async () => {
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [
          { ts: tsAt(at(1)), text: 'real' },
          { ts: 'zzz', text: 'not a timestamp' }
        ],
        syncedAt: NOW.toISOString()
      })
      // 'zzz' sorts above every digit, so a string-comparison fallback would
      // wedge lastSyncTs and make every later message look already-seen.
      expect((await store.read()).workspaces.T1.channels.C1.lastSyncTs).toBe(tsAt(at(1)))
    })

    it('does not aggregate a non-numeric ts', async () => {
      const rollup = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [
          { ts: tsAt(at(1)), text: 'real' },
          { ts: 'zzz', text: 'not a timestamp' }
        ],
        syncedAt: NOW.toISOString()
      })

      // Kept for display, but never counted — it cannot be deduped after a prune.
      expect(rollup.recentMessages).toHaveLength(2)
      expect(rollup.totalMessages).toBe(1)
      expect(Object.keys(rollup.dailyCounts)).toEqual([toDay(at(1))])
    })

    it('does not double-count a message synced twice', async () => {
      const messages = [msg(at(2), 'hello', 'U1')]
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages,
        syncedAt: NOW.toISOString()
      })
      const again = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages,
        syncedAt: NOW.toISOString()
      })

      expect(again.totalMessages).toBe(1)
      expect(again.recentMessages).toHaveLength(1)
      expect(again.dailyCounts[toDay(at(2))]).toBe(1)
    })

    it('counts a repeated ts inside one batch once', async () => {
      const rollup = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(2), 'first'), msg(at(2), 'duplicate ts, different text')],
        syncedAt: NOW.toISOString()
      })
      expect(rollup.totalMessages).toBe(1)
      expect(rollup.recentMessages).toHaveLength(1)
      expect(rollup.recentMessages[0]?.text).toBe('first')
    })

    it('keeps separate channels apart and survives a restart', async () => {
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(2), 'in general')],
        syncedAt: NOW.toISOString()
      })
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C2',
        channelName: 'random',
        isPrivate: true,
        messages: [msg(at(2), 'in random')],
        syncedAt: NOW.toISOString()
      })

      const reopened = new DashboardStore({ filePath: join(dir, 'dashboard.json') })
      const channels = (await reopened.read()).workspaces.T1.channels
      expect(Object.keys(channels).sort()).toEqual(['C1', 'C2'])
      expect(channels.C2.isPrivate).toBe(true)
      expect(channels.C1.totalMessages).toBe(1)
      expect(channels.C2.totalMessages).toBe(1)
    })

    it('does not double-count a message whose text pruning has already dropped', async () => {
      const ancient = at(MESSAGE_RETENTION_DAYS + 5)
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(ancient, 'quiet channel, one message')],
        syncedAt: NOW.toISOString()
      })
      // The channel then goes silent long enough that the text is pruned while
      // the cursor and the lifetime aggregates survive.
      expect(await store.pruneOldMessages(NOW)).toBe(1)

      const afterResync = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(ancient, 'quiet channel, one message')],
        syncedAt: NOW.toISOString()
      })

      expect(afterResync.totalMessages).toBe(1)
      expect(afterResync.dailyCounts[toDay(ancient)]).toBe(1)
      expect((await store.read()).workspaces.T1.channels.C1.totalMessages).toBe(1)
    })

    it('still counts a message older than the cursor on its first sync', async () => {
      const old = at(10)
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(old, 'older'), msg(at(1), 'newer')],
        syncedAt: NOW.toISOString()
      })
      // Slack pages newest-first, so an older ts arriving after a newer one in
      // the same batch is new data and must not be mistaken for a replay.
      expect((await store.read()).workspaces.T1.channels.C1.totalMessages).toBe(2)
    })

    it('persists a zero-message first sync', async () => {
      const rollup = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [],
        syncedAt: NOW.toISOString()
      })
      expect(rollup.totalMessages).toBe(0)

      const reopened = new DashboardStore({ filePath: join(dir, 'dashboard.json') })
      const channels = (await reopened.read()).workspaces.T1.channels
      expect(channels.C1.channelName).toBe('general')
      expect(channels.C1.totalMessages).toBe(0)
      expect((await reopened.read()).workspaces.T1.lastSyncAt).toBe(NOW.toISOString())
    })

    it('advances lastSyncAt on a sync that brings no new messages', async () => {
      const earlier = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString()
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(1), 'only')],
        syncedAt: earlier
      })
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [],
        syncedAt: NOW.toISOString()
      })

      const reopened = new DashboardStore({ filePath: join(dir, 'dashboard.json') })
      expect((await reopened.read()).workspaces.T1.lastSyncAt).toBe(NOW.toISOString())
    })

    it('keeps a private channel private when a later sync claims it is public', async () => {
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'secrets',
        isPrivate: true,
        messages: [msg(at(1), 'quiet')],
        syncedAt: NOW.toISOString()
      })
      const rollup = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'secrets',
        isPrivate: false,
        messages: [],
        syncedAt: NOW.toISOString()
      })

      expect(rollup.isPrivate).toBe(true)
      expect((await store.read()).workspaces.T1.channels.C1.isPrivate).toBe(true)
    })

    it('does not hand out a live reference into stored state', async () => {
      const rollup = await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(1), 'original')],
        syncedAt: NOW.toISOString()
      })
      // Mutating what we were handed must not reach the store.
      rollup.totalMessages = 999
      rollup.recentMessages.push({ ts: '1.000000', text: 'injected' })

      // Guard, not a regression test: every transaction re-parses the file, so
      // this holds even without structuredClone. It is here to fail loudly if a
      // future cache is added and turns the returned object back into a view.
      const stored = (await store.read()).workspaces.T1.channels.C1
      expect(stored.totalMessages).toBe(1)
      expect(stored.recentMessages.map((m) => m.text)).toEqual(['original'])
    })

    it('survives two store instances writing the same path', async () => {
      const other = new DashboardStore({ filePath: join(dir, 'dashboard.json') })
      await Promise.all([
        store.recordMessages({
          teamId: 'T1',
          channelId: 'C1',
          channelName: 'general',
          isPrivate: false,
          messages: [msg(at(2), 'from a')],
          syncedAt: NOW.toISOString()
        }),
        other.recordMessages({
          teamId: 'T2',
          channelId: 'C9',
          channelName: 'random',
          isPrivate: false,
          messages: [msg(at(2), 'from b')],
          syncedAt: NOW.toISOString()
        })
      ])

      // Separate instances have separate queues, so last-writer-wins is the
      // honest guarantee. What must hold is that the tmp rename never ENOENTs
      // and the file stays one valid, non-truncated document.
      const raw = readFileSync(join(dir, 'dashboard.json'), 'utf8')
      expect(() => JSON.parse(raw)).not.toThrow()
      const workspaces = (await store.read()).workspaces
      expect(Object.keys(workspaces).length).toBeGreaterThanOrEqual(1)
      const [winner] = Object.values(workspaces)
      expect(
        winner.channels.C1?.recentMessages[0]?.text ?? winner.channels.C9?.recentMessages[0]?.text
      ).toMatch(/^from [ab]$/)
      // No stray tmp file left behind by a failed rename.
      expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
    })

    it('serialises concurrent writes so no record is lost', async () => {
      await Promise.all([
        store.recordMessages({
          teamId: 'T1',
          channelId: 'C1',
          channelName: 'general',
          isPrivate: false,
          messages: [msg(at(2), 'a')],
          syncedAt: NOW.toISOString()
        }),
        store.recordMessages({
          teamId: 'T1',
          channelId: 'C1',
          channelName: 'general',
          isPrivate: false,
          messages: [msg(at(1), 'b')],
          syncedAt: NOW.toISOString()
        }),
        store.recordMessages({
          teamId: 'T1',
          channelId: 'C2',
          channelName: 'random',
          isPrivate: false,
          messages: [msg(at(1), 'c')],
          syncedAt: NOW.toISOString()
        })
      ])

      const channels = (await store.read()).workspaces.T1.channels
      expect(channels.C1.totalMessages).toBe(2)
      expect(channels.C1.recentMessages).toHaveLength(2)
      expect(channels.C2.totalMessages).toBe(1)
    })
  })

  describe('pruneOldMessages', () => {
    it('drops messages past the retention window but preserves the aggregates', async () => {
      const old = at(MESSAGE_RETENTION_DAYS + 1)
      const fresh = at(1)
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(old, 'ancient'), msg(fresh, 'recent')],
        syncedAt: NOW.toISOString()
      })

      const removed = await store.pruneOldMessages(NOW)

      expect(removed).toBe(1)
      const channel = (await store.read()).workspaces.T1.channels.C1
      expect(channel.recentMessages.map((m) => m.text)).toEqual(['recent'])
      expect(channel.totalMessages).toBe(2)
      expect(channel.dailyCounts[toDay(old)]).toBe(1)
      expect(channel.dailyCounts[toDay(fresh)]).toBe(1)
      expect(channel.lastSyncTs).toBe(tsAt(fresh))
    })

    it('defaults now to the current time when no argument is passed', async () => {
      const stale = new Date(Date.now() - (MESSAGE_RETENTION_DAYS + 5) * DAY_MS)
      const fresh = new Date(Date.now() - 60 * 1000)
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(stale, 'ancient'), msg(fresh, 'recent')],
        syncedAt: NOW.toISOString()
      })

      // No argument — this is the code path main/index.ts will actually take.
      expect(await store.pruneOldMessages()).toBe(1)
      const channel = (await store.read()).workspaces.T1.channels.C1
      expect(channel.recentMessages.map((m) => m.text)).toEqual(['recent'])
      expect(channel.totalMessages).toBe(2)
    })

    it('keeps a message sitting exactly on the retention boundary', async () => {
      const boundary = at(MESSAGE_RETENTION_DAYS)
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(boundary, 'edge')],
        syncedAt: NOW.toISOString()
      })
      expect(await store.pruneOldMessages(NOW)).toBe(0)
      expect((await store.read()).workspaces.T1.channels.C1.recentMessages).toHaveLength(1)
    })

    it('returns 0 and leaves the file byte-identical when there is nothing to prune', async () => {
      await store.recordMessages({
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        isPrivate: false,
        messages: [msg(at(1), 'recent')],
        syncedAt: NOW.toISOString()
      })
      const before = await readFile(join(dir, 'dashboard.json'), 'utf8')

      expect(await store.pruneOldMessages(NOW)).toBe(0)

      // `changed: false` is what keeps this from rewriting, so the contract is
      // pinned on the bytes rather than on read() output — read() would return
      // the same object whether or not a write happened.
      expect(await readFile(join(dir, 'dashboard.json'), 'utf8')).toBe(before)
      expect((await store.read()).workspaces.T1.channels.C1.totalMessages).toBe(1)
    })

    it('leaves the file byte-identical when pruning an empty store', async () => {
      await store.upsertWorkspace({ teamId: 'T1', teamName: 'Acme', profileId: 'p1' })
      const before = await readFile(join(dir, 'dashboard.json'), 'utf8')

      expect(await store.pruneOldMessages(NOW)).toBe(0)
      expect(await readFile(join(dir, 'dashboard.json'), 'utf8')).toBe(before)
    })
  })

  describe('update', () => {
    it('returns a detached copy, not the live stored state', async () => {
      await store.upsertWorkspace({ teamId: 'T1', teamName: 'Acme', profileId: 'p1' })
      const updated = await store.update((file) => {
        file.workspaces.T1.teamName = 'mutated by the callback'
      })
      updated.workspaces.T1.teamName = 'mutated after the fact'

      // Guard, not a regression test — update() persists before returning, so
      // this holds without the clone too. It fails if a cache ever makes the
      // returned file a live view.
      expect((await store.read()).workspaces.T1.teamName).toBe('mutated by the callback')
    })

    it('persists an arbitrary mutation', async () => {
      await store.upsertWorkspace({ teamId: 'T1', teamName: 'Acme', profileId: 'p1' })
      const updated = await store.update((file) => {
        file.workspaces.T1.channels.C9 = {
          channelId: 'C9',
          channelName: 'ops',
          isPrivate: false,
          lastSyncTs: '1.000000',
          totalMessages: 7,
          dailyCounts: { '2026-02-28': 7 },
          recentMessages: [{ ts: '1.000000', text: 'manual' }]
        }
      })
      expect(updated.workspaces.T1.channels.C9.totalMessages).toBe(7)

      const reopened = new DashboardStore({ filePath: join(dir, 'dashboard.json') })
      expect((await reopened.read()).workspaces.T1.channels.C9.channelName).toBe('ops')
    })
  })
})

function toDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}
