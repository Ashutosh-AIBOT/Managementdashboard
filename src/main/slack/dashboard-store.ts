import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type {
  ChannelRollup,
  DashboardFile,
  DashboardMessage,
  WorkspaceRollup
} from '../../shared/types'

/**
 * Aliases, not declarations. The dashboard data model is declared once in
 * src/shared/types.ts; re-exported so `from './dashboard-store'` call sites keep
 * working without every consumer needing a second import.
 */
export type {
  ChannelRollup,
  DashboardFile,
  DashboardMessage,
  Sentiment,
  WorkspaceRollup
} from '../../shared/types'

export const DASHBOARD_VERSION = 1

/** How much message *text* we keep. Aggregates are lifetime and never pruned. */
export const MESSAGE_RETENTION_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

export interface DashboardStoreOptions {
  filePath: string
}

/** Slack `ts` is `"seconds.fraction"`; NaN when the string is not a timestamp. */
function tsToMs(ts: string): number {
  return Math.floor(Number(ts) * 1000)
}

/**
 * Only a numeric `ts` can be deduped against the cursor once pruning has dropped
 * the text. A non-numeric one is still shown, but never aggregated — counting it
 * would guarantee inflation on the next sync after a prune.
 */
function isCountable(ts: string): boolean {
  return Number.isFinite(tsToMs(ts))
}

/** UTC so a daily chart does not shift shape with the viewer's timezone. */
function dayKey(ts: string): string | null {
  const ms = tsToMs(ts)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null
}

/** Unparseable ts sort last, so one cannot masquerade as the newest message. */
function byTs(a: DashboardMessage, b: DashboardMessage): number {
  const left = tsToMs(a.ts)
  const right = tsToMs(b.ts)
  if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : a.ts.localeCompare(b.ts)
  if (!Number.isFinite(right)) return -1
  return left - right
}

/** A ts we cannot parse cannot be proven old, so it stays in the window. */
function isWithinRetention(ts: string, cutoffMs: number): boolean {
  const ms = tsToMs(ts)
  return !Number.isFinite(ms) || ms >= cutoffMs
}

/** A ts at or below the cursor was already counted, even if its text was pruned. */
function isBeyondCursor(ts: string, cursor: string | undefined): boolean {
  if (!cursor) return false
  const next = tsToMs(ts)
  const prev = tsToMs(cursor)
  if (!Number.isFinite(next) || !Number.isFinite(prev)) return false
  return next <= prev
}

function isNewerThan(ts: string, current: string): boolean {
  const next = tsToMs(ts)
  const prev = tsToMs(current)
  if (!Number.isFinite(next)) return false
  if (!Number.isFinite(prev)) return true
  return next > prev
}

/** ISO-8601 UTC strings order correctly with a plain comparison. */
function laterOf(current: string, candidate: string): string {
  return candidate > current ? candidate : current
}

function nonEmptyString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeMessage(raw: unknown): DashboardMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as {
    ts?: unknown
    user?: unknown
    text?: unknown
    sentiment?: unknown
    completionHint?: unknown
  }
  const ts = nonEmptyString(rec.ts).trim()
  if (!ts) return null
  const sentiment =
    rec.sentiment === 'positive' || rec.sentiment === 'neutral' || rec.sentiment === 'negative'
      ? rec.sentiment
      : undefined
  return {
    ts,
    ...(nonEmptyString(rec.user) ? { user: nonEmptyString(rec.user) } : {}),
    text: typeof rec.text === 'string' ? rec.text : '',
    // AI fields are written by a later sync stage; carrying them through a
    // read/write cycle keeps an unrelated save from erasing the analysis.
    ...(sentiment ? { sentiment } : {}),
    ...(nonEmptyString(rec.completionHint)
      ? { completionHint: nonEmptyString(rec.completionHint) }
      : {})
  }
}

function normalizeChannel(raw: unknown, channelId: string): ChannelRollup | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as {
    channelName?: unknown
    isPrivate?: unknown
    lastSyncTs?: unknown
    totalMessages?: unknown
    dailyCounts?: unknown
    recentMessages?: unknown
    sentimentScore?: unknown
    completionEstimate?: unknown
  }

  const dailyCounts: Record<string, number> = {}
  if (rec.dailyCounts && typeof rec.dailyCounts === 'object') {
    for (const [day, count] of Object.entries(rec.dailyCounts as Record<string, unknown>)) {
      const value = finiteNumber(count)
      if (value !== undefined && value > 0) dailyCounts[day] = Math.round(value)
    }
  }

  const recentMessages = Array.isArray(rec.recentMessages)
    ? rec.recentMessages.map(normalizeMessage).filter((m): m is DashboardMessage => m !== null)
    : []

  const total = finiteNumber(rec.totalMessages)
  const sentimentScore = finiteNumber(rec.sentimentScore)
  const completionEstimate = finiteNumber(rec.completionEstimate)
  return {
    channelId,
    channelName: nonEmptyString(rec.channelName, channelId),
    isPrivate: rec.isPrivate === true,
    ...(nonEmptyString(rec.lastSyncTs) ? { lastSyncTs: nonEmptyString(rec.lastSyncTs) } : {}),
    totalMessages: total !== undefined && total > 0 ? Math.round(total) : 0,
    dailyCounts,
    recentMessages,
    ...(sentimentScore !== undefined ? { sentimentScore } : {}),
    ...(completionEstimate !== undefined ? { completionEstimate } : {})
  }
}

function normalizeWorkspace(raw: unknown, teamId: string): WorkspaceRollup | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as {
    teamName?: unknown
    profileId?: unknown
    lastSyncAt?: unknown
    channels?: unknown
  }
  const channels: Record<string, ChannelRollup> = {}
  if (rec.channels && typeof rec.channels === 'object') {
    for (const [channelId, value] of Object.entries(rec.channels as Record<string, unknown>)) {
      const channel = normalizeChannel(value, channelId)
      if (channel) channels[channelId] = channel
    }
  }
  return {
    teamId,
    teamName: nonEmptyString(rec.teamName, teamId),
    profileId: typeof rec.profileId === 'string' ? rec.profileId : '',
    lastSyncAt: typeof rec.lastSyncAt === 'string' ? rec.lastSyncAt : '',
    channels
  }
}

function emptyFile(): DashboardFile {
  return { version: DASHBOARD_VERSION, workspaces: {} }
}

/** There is no migration path yet, so an unknown shape degrades to what parses. */
function normalizeFile(parsed: unknown): DashboardFile {
  const rec = parsed as { workspaces?: unknown } | null
  const source =
    rec && typeof rec === 'object' && rec.workspaces && typeof rec.workspaces === 'object'
      ? (rec.workspaces as Record<string, unknown>)
      : {}
  const workspaces: Record<string, WorkspaceRollup> = {}
  for (const [teamId, value] of Object.entries(source)) {
    const workspace = normalizeWorkspace(value, teamId)
    if (workspace) workspaces[teamId] = workspace
  }
  return { version: DASHBOARD_VERSION, workspaces }
}

function ensureWorkspace(file: DashboardFile, teamId: string): WorkspaceRollup {
  const existing = file.workspaces[teamId]
  if (existing) {
    existing.channels = existing.channels ?? {}
    return existing
  }
  const created: WorkspaceRollup = {
    teamId,
    // recordMessages carries no teamName/profileId; upsertWorkspace fills them in.
    teamName: teamId,
    profileId: '',
    lastSyncAt: '',
    channels: {}
  }
  file.workspaces[teamId] = created
  return created
}

function ensureChannel(
  workspace: WorkspaceRollup,
  channelId: string,
  channelName: string,
  isPrivate: boolean
): ChannelRollup {
  const existing = workspace.channels[channelId]
  if (existing) {
    if (channelName.trim()) existing.channelName = channelName.trim()
    // Private is sticky: Slack converts public → private but never the reverse,
    // so honouring a `false` here would let a stale sync relabel a private
    // channel as public.
    if (isPrivate) existing.isPrivate = true
    return existing
  }
  const created: ChannelRollup = {
    channelId,
    channelName: channelName.trim() || channelId,
    isPrivate,
    totalMessages: 0,
    dailyCounts: {},
    recentMessages: []
  }
  workspace.channels[channelId] = created
  return created
}

export class DashboardStore {
  private readonly filePath: string
  /**
   * Serialises every read-modify-write, not just the writes. Concurrent
   * `writeFile` races corrupt the file, and a read-modify-write that is not
   * queued drops whichever record lost the race.
   */
  private chain: Promise<unknown> = Promise.resolve()
  /** Set when the last read found unparseable JSON — see persist(). */
  private corrupt = false

  constructor(options: DashboardStoreOptions) {
    this.filePath = options.filePath
  }

  async read(): Promise<DashboardFile> {
    return this.load()
  }

  /** Mutate the file under the write queue and persist whatever the callback left. */
  async update(fn: (file: DashboardFile) => void): Promise<DashboardFile> {
    return this.transact((file) => {
      fn(file)
      // Detached copy: the caller must not hold a live reference into state that
      // a later transaction is free to mutate.
      return { result: structuredClone(file), changed: true }
    })
  }

  async upsertWorkspace(input: {
    teamId: string
    teamName: string
    profileId: string
  }): Promise<void> {
    const teamId = input.teamId.trim()
    if (!teamId) {
      throw new Error('teamId is required')
    }
    const teamName = input.teamName.trim()
    const profileId = input.profileId.trim()
    await this.transact((file) => {
      const workspace = ensureWorkspace(file, teamId)
      const nextName = teamName || workspace.teamName || teamId
      const nextProfile = profileId || workspace.profileId
      if (nextName === workspace.teamName && nextProfile === workspace.profileId) {
        return { result: undefined, changed: false }
      }
      workspace.teamName = nextName
      workspace.profileId = nextProfile
      return { result: undefined, changed: true }
    })
  }

  /**
   * Fold one channel sync into the aggregates. Additive, not a replace.
   *
   * A `ts` is counted once and only once. Two independent guards: the in-memory
   * `seen` set catches a repeat inside this batch or still inside the retention
   * window, and the cursor rejects anything at or below `lastSyncTs` — the only
   * guard that survives pruning, since a channel idle past 90 days comes back
   * with an empty window but an intact cursor.
   */
  async recordMessages(input: {
    teamId: string
    channelId: string
    channelName: string
    isPrivate: boolean
    messages: Array<{ ts: string; user?: string; text: string }>
    syncedAt: string
  }): Promise<ChannelRollup> {
    const teamId = input.teamId.trim()
    const channelId = input.channelId.trim()
    if (!teamId) {
      throw new Error('teamId is required')
    }
    if (!channelId) {
      throw new Error('channelId is required')
    }

    return this.transact((file) => {
      const existed = Boolean(file.workspaces[teamId]?.channels[channelId])
      const workspace = ensureWorkspace(file, teamId)
      const channel = ensureChannel(workspace, channelId, input.channelName, input.isPrivate)
      const seen = new Set(channel.recentMessages.map((m) => m.ts))
      // Snapshot before the loop: within one batch an older message can still be
      // new, so the cursor must not move underneath the comparison.
      const cursorAtStart = channel.lastSyncTs
      let added = 0

      for (const message of input.messages) {
        const ts = nonEmptyString(message.ts).trim()
        if (!ts || seen.has(ts)) {
          continue
        }
        seen.add(ts)
        // Already counted on an earlier sync whose text pruning has since
        // dropped. Never advance the cursor backwards to accommodate it.
        if (isBeyondCursor(ts, cursorAtStart)) {
          continue
        }
        channel.recentMessages.push({
          ts,
          ...(nonEmptyString(message.user) ? { user: message.user } : {}),
          text: typeof message.text === 'string' ? message.text : ''
        })
        // A ts we cannot order cannot be deduped after a prune, so it is shown
        // but never aggregated rather than guaranteed to inflate later.
        if (isCountable(ts)) {
          const day = dayKey(ts)
          if (day) {
            channel.dailyCounts[day] = (channel.dailyCounts[day] ?? 0) + 1
          }
          if (!channel.lastSyncTs || isNewerThan(ts, channel.lastSyncTs)) {
            channel.lastSyncTs = ts
          }
          added += 1
        }
      }

      channel.recentMessages.sort(byTs)
      channel.totalMessages += added
      const previousSyncAt = workspace.lastSyncAt
      workspace.lastSyncAt = laterOf(previousSyncAt, input.syncedAt)
      // `added > 0` alone was the wrong gate: it discarded the workspace and
      // channel creation and the lastSyncAt bump that this same transaction had
      // already made in memory, so a zero-message sync persisted nothing at all.
      const changed = added > 0 || !existed || workspace.lastSyncAt !== previousSyncAt
      return { result: structuredClone(channel), changed }
    })
  }

  /** Drop message text past the retention window. Aggregates are lifetime facts. */
  async pruneOldMessages(now: Date = new Date()): Promise<number> {
    const cutoff = now.getTime() - MESSAGE_RETENTION_DAYS * DAY_MS
    return this.transact((file) => {
      let removed = 0
      for (const workspace of Object.values(file.workspaces)) {
        for (const channel of Object.values(workspace.channels)) {
          channel.recentMessages = channel.recentMessages.filter((m) => {
            if (isWithinRetention(m.ts, cutoff)) return true
            removed += 1
            return false
          })
          // totalMessages and dailyCounts deliberately left untouched.
        }
      }
      return { result: removed, changed: removed > 0 }
    })
  }

  private async transact<T>(
    fn: (file: DashboardFile) => { result: T; changed: boolean }
  ): Promise<T> {
    return this.run(async () => {
      const file = await this.load()
      const { result, changed } = fn(file)
      if (changed) {
        await this.persist(file)
      }
      return result
    })
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    // A rejected write must not poison the queue for every later call.
    this.chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async load(): Promise<DashboardFile> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      // First run — nothing on disk yet. Anything else (EACCES, EISDIR) is a
      // real fault and must surface rather than look like an empty dashboard.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyFile()
      }
      throw err
    }
    try {
      const parsed = normalizeFile(JSON.parse(raw))
      this.corrupt = false
      return parsed
    } catch {
      // Truncated or hand-edited JSON must not wedge the app: hand back empty
      // state so the UI renders, and record that the bytes on disk are bad so
      // persist() parks them instead of overwriting them.
      this.corrupt = true
      return emptyFile()
    }
  }

  private async persist(file: DashboardFile): Promise<void> {
    const payload = `${JSON.stringify(file, null, 2)}\n`
    await fs.mkdir(dirname(this.filePath), { recursive: true })
    if (this.corrupt) {
      // Lifetime aggregates are not recoverable from a resync alone. Park the
      // unparseable file next to it so nothing is destroyed before we write.
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      try {
        await fs.rename(this.filePath, backup)
      } catch (err) {
        // Already gone, or not renameable — the upcoming write is what matters.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      this.corrupt = false
    }
    // Unique per write, not per process: two stores on one path would otherwise
    // pick the same tmp name and the second rename would fail ENOENT.
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${writeSeq++}.tmp`
    await fs.writeFile(tmp, payload, 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}

/** Module scope, so the counter is shared by every store instance. */
let writeSeq = 0

export function defaultDashboardPath(userDataPath: string): string {
  return join(userDataPath, 'dashboard.json')
}
