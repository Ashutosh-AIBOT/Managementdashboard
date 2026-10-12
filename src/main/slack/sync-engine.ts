import type { SyncProgressPayload } from '../../shared/types'
import type { DashboardStore } from './dashboard-store'
import { listChannels, listMessages } from './slack-api-client'
import { SlackApiError } from './types'
import { log } from '../logging'

/**
 * Workspace -> channels -> messages, one request at a time.
 *
 * Electron-free like `chrome-resolution.ts`: the token source is declared
 * structurally below rather than importing `TokenStore`, because `token-store.ts`
 * pulls `safeStorage` from `electron` at module load and that would make every
 * test in this file need an Electron runtime. The real `TokenStore` satisfies
 * `TokenSource` structurally, so callers pass it unchanged.
 */

/**
 * The only thing this engine needs from `token-store.ts`. Structurally
 * satisfied by the real `TokenStore` — never import the class here.
 */
export interface TokenSource {
  tryGet(profileId: string, teamId: string): Promise<string | null>
}

/**
 * One tick from a walk in progress.
 *
 * Walks of different workspaces run concurrently and all share this one
 * callback, so every payload names the workspace it came from. Key a listener on
 * `teamId`, never on `teamName` — two workspaces are free to share a display name.
 *
 * Ticks are emitted around Slack requests, not continuously. If a request is rate
 * limited, `withRetry` backs off inside the client — up to three waits of 60s —
 * and nothing arrives during that time. The silence is expected, not a hang:
 * `isSyncing(teamId)` stays true throughout, and the last tick received names the
 * request being waited on.
 *
 * ## This is an alias, not a second declaration
 *
 * `SyncProgressPayload` in `src/shared/types.ts` is the single declaration of the
 * wire shape, because `src/shared` may not depend on `src/main` and the renderer
 * can only import from `src/shared`. An earlier version declared both and asserted
 * they stayed identical with a conditional type — which turned out to be inert: a
 * mutation that drifted the two shapes still compiled clean, because an unused
 * exported type alias is never evaluated. Aliasing makes the drift unrepresentable
 * instead of merely checked for, so nothing here can fall out of step.
 */
export type SyncProgress = SyncProgressPayload

export type SyncPhase = SyncProgressPayload['phase']

export interface SyncResult {
  teamId: string
  /** Messages Slack returned this run. The store may still dedupe some. */
  messagesRead: number
  /** Channels written this run; less than the total when the walk failed part way. */
  channelsSynced: number
}

/** The token is gone, not the sync. Distinct so the UI can offer "Reconnect". */
export class ReconnectRequiredError extends Error {
  constructor(
    public readonly teamId: string,
    message?: string
  ) {
    super(message ?? `Slack token for workspace ${teamId} is no longer valid; reconnect required`)
    this.name = 'ReconnectRequiredError'
  }
}

/**
 * A second walk of the *same* workspace was refused. Distinct workspaces never
 * raise it — they sync independently.
 *
 * `teamId` is the workspace that is genuinely busy. The guard is keyed by
 * `teamId`, so the busy workspace and the refused one are the same id by
 * construction; the field can never name a workspace that is idle.
 */
export class SyncInProgressError extends Error {
  constructor(public readonly teamId: string) {
    super(`A sync is already running for workspace ${teamId}`)
    this.name = 'SyncInProgressError'
  }
}

/**
 * Slack's documented codes for a dead stored token, from the Errors table at
 * https://api.slack.com/methods/conversations.history (the same two appear for
 * `conversations.list`):
 *
 * - `invalid_auth` — "Some aspect of authentication cannot be validated. Either
 *   the provided token is invalid or the request originates from an IP address
 *   disallowed from making the request."
 * - `token_revoked` — "Authentication token is for a deleted user or workspace
 *   or the app has been removed when using a user token."
 *
 * `token_revoked` is unambiguous: the token is dead. `invalid_auth` is Slack's
 * catch-all for auth failing and its second documented cause is a blocked IP
 * rather than a bad token, so it is not proof the token is dead — but it is still
 * the user's only available remedy, and no other code in this file offers one.
 * Every other Slack error is a failure of this sync, not of the connection, and
 * must not send the user to the reconnect flow.
 */
const INVALID_AUTH_CODES = new Set(['invalid_auth', 'token_revoked'])

/** Per-channel page size for the history walk. Matches `listMessages`' own default. */
const HISTORY_PAGE_LIMIT = 200

export interface SyncEngineOptions {
  /** Real `TokenStore` at runtime, a plain stub under test. */
  tokenStore: TokenSource
  dashboardStore: DashboardStore
  onProgress?: (progress: SyncProgress) => void
}

export interface SyncWorkspaceInput {
  profileId: string
  teamId: string
  teamName: string
}

export class SyncEngine {
  private readonly tokenStore: TokenSource
  private readonly dashboardStore: DashboardStore
  private readonly onProgress: ((progress: SyncProgress) => void) | undefined
  /**
   * One walk per workspace, tracked by `teamId`.
   *
   * Per workspace, not per engine: workspaces are independent, so serialising
   * them against each other would refuse work for no reason. Two walks of the
   * *same* workspace are the thing that must not happen — they would burn twice
   * the rate-limit budget against Slack and race their progress ticks into an
   * incoherent UI. (They still could not double-count: the store dedupes by ts.)
   */
  private readonly inFlight = new Map<string, number>()

  constructor(opts: SyncEngineOptions) {
    this.tokenStore = opts.tokenStore
    this.dashboardStore = opts.dashboardStore
    this.onProgress = opts.onProgress
  }

  /** True while any workspace is mid-walk. Use `isSyncing` to ask about one. */
  isRunning(): boolean {
    return this.inFlight.size > 0
  }

  /** True while *this* workspace is mid-walk — the question a sidebar actually asks. */
  isSyncing(teamId: string): boolean {
    return (this.inFlight.get(teamId) ?? 0) > 0
  }

  /** Hold one workspace's lock for the whole of `fn`. Not re-entrant by design. */
  private async withWorkspaceLock<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
    this.inFlight.set(teamId, (this.inFlight.get(teamId) ?? 0) + 1)
    try {
      return await fn()
    } finally {
      const depth = (this.inFlight.get(teamId) ?? 1) - 1
      if (depth <= 0) {
        this.inFlight.delete(teamId)
      } else {
        this.inFlight.set(teamId, depth)
      }
    }
  }

  /**
   * Emit a tick on the same stream the walk uses.
   *
   * Public because a caller running extra phases after the walk — AI analysis is
   * one — must report them through the one listener the renderer subscribed to.
   * A second stream would leave the UI showing the walk's last phase for as long
   * as the work after it lasted.
   */
  emitProgress(progress: SyncProgress): void {
    this.emit(progress)
  }

  /**
   * Walk one workspace and fold every channel into the store.
   *
   * Progress is durable per channel: each `recordMessages` transaction commits
   * before the next channel is fetched, so an error thrown from anywhere in the
   * walk leaves the channels already done on disk and the failing channel
   * untouched — no cursor written, so the next run refetches it from where the
   * last successful sync left off.
   *
   * ## Rate limiting: this method holds the workspace's lock through the backoff
   *
   * Decision, recorded so the next reader does not re-open it. `listChannels` and
   * `listMessages` each route through `withRetry`, which sleeps on a real timer —
   * up to three waits of up to 60s — *inside* this call, while `inFlight` still
   * holds `teamId`. A rate-limited workspace can therefore look busy for minutes.
   * That is deliberate:
   *
   * - Retrying a workspace Slack has just rate limited is pointless. Releasing the
   *   lock mid-walk would let a second walk of the *same* workspace start, walk into
   *   the same limit, and spend another three waits. It would make things worse.
   * - Round 1 removed the engine's *own* backoff sleep for the same reason. What is
   *   left is Task 1's bounded client-level retry, not the engine stalling.
   * - The lock is per team, so the blast radius of one rate-limited workspace is
   *   one workspace. Before round 1 it was every workspace on the engine.
   *
   * The engine cannot emit a tick during the wait — it is blocked inside the client,
   * and surfacing the backoff properly would mean changing `withRetry`'s signature in
   * Task 1. The wait is therefore visible as *absence*: no ticks, `isSyncing(teamId)`
   * still true, and the last tick naming the request being waited on. That contract is
   * documented on `SyncProgress` and pinned by
   * `reports the pending request while a rate-limited call is backing off`.
   *
   * ## The engine itself never waits
   *
   * A `RateLimitError` is raised only after `withRetry` has spent every attempt, so
   * there is nothing left to wait *for*; the error carrying `retryAfterSeconds` goes
   * straight back to the caller, which owns the retry schedule. Sleeping on it here
   * would delay that error by up to a minute and turn a definitive failure into
   * something that looks hung.
   */
  async syncWorkspace(input: SyncWorkspaceInput): Promise<SyncResult> {
    return this.syncWorkspaceWithFollowUp(input, async (result) => result)
  }

  /**
   * Walk one workspace, holding its lock until `followUp` has also finished.
   *
   * The lock stops two walks of the same workspace racing each other. Work that
   * *follows* the walk - pruning, AI analysis - is part of the same operation:
   * it reads and writes the same rows the walk just committed, and releasing the
   * lock at the end of the walk alone left the longest phase unguarded, with
   * `isSyncing(teamId)` reporting false and a second walk free to start
   * underneath it.
   *
   * `followUp` therefore runs inside the lock, and decides its own failure
   * handling: an error it throws propagates out of here exactly as a walk error
   * does, because only the caller knows whether that makes the whole operation a
   * failure - by this point the walk's own writes are already durable.
   */
  async syncWorkspaceWithFollowUp<T>(
    input: SyncWorkspaceInput,
    followUp: (result: SyncResult) => Promise<T>
  ): Promise<T> {
    // Check and set are adjacent statements with no `await` between them, so a
    // second caller cannot slip in between them under run-to-completion.
    if (this.isSyncing(input.teamId)) {
      throw new SyncInProgressError(input.teamId)
    }
    return this.withWorkspaceLock(input.teamId, async () => {
      const result = await this.walk(input)
      return followUp(result)
    })
  }

  private async walk(input: SyncWorkspaceInput): Promise<SyncResult> {
    const progress = { teamId: input.teamId, teamName: input.teamName }
    let channelIndex = 0
    let channelTotal = 0
    let messagesRead = 0
    let channelsSynced = 0

    try {
      const token = await this.tokenStore.tryGet(input.profileId, input.teamId)
      if (!token) {
        throw new ReconnectRequiredError(input.teamId)
      }

      // A new workspace is seeded with teamName = teamId and no profileId, and
      // this is the only place that knows either. Doing it up front also
      // registers a workspace that turns out to have zero channels.
      await this.dashboardStore.upsertWorkspace({
        teamId: input.teamId,
        teamName: input.teamName,
        profileId: input.profileId
      })

      this.emit({
        ...progress,
        phase: 'listing-channels',
        channelIndex: 0,
        channelTotal: 0,
        messageCount: 0
      })
      const channels = await listChannels(token)
      channelTotal = channels.length
      const cursors = await this.loadCursors(input.teamId)

      for (const [index, channel] of channels.entries()) {
        channelIndex = index
        this.emit({
          ...progress,
          phase: 'reading-messages',
          channelIndex: index,
          channelTotal,
          messageCount: messagesRead
        })
        // Serial by construction: one channel in flight, cursor-paged inside.
        const messages = await listMessages(
          token,
          channel.id,
          HISTORY_PAGE_LIMIT,
          cursors.get(channel.id)
        )
        const rollup = await this.dashboardStore.recordMessages({
          teamId: input.teamId,
          channelId: channel.id,
          channelName: channel.name,
          isPrivate: channel.isPrivate,
          messages,
          syncedAt: new Date().toISOString()
        })
        // The store already refused anything at or below the old cursor, so the
        // advanced one comes off its return value rather than a second read.
        cursors.set(channel.id, rollup.lastSyncTs)
        messagesRead += messages.length
        channelsSynced += 1
      }

      this.emit({
        ...progress,
        phase: 'done',
        channelIndex: channelTotal,
        channelTotal,
        messageCount: messagesRead
      })
      return { teamId: input.teamId, messagesRead, channelsSynced }
    } catch (err) {
      const failure = this.classify(err, input.teamId)
      this.emit({
        ...progress,
        phase: 'error',
        channelIndex,
        channelTotal,
        messageCount: messagesRead,
        message: failure.message
      })
      throw failure
    }
    // No lock release here. The lock belongs to `syncWorkspaceWithFollowUp`, and
    // it is held until `followUp` finishes too — releasing it here left prune and
    // analysis unguarded. That block also made it unconditional, which matters:
    // a failed walk must not wedge the workspace, or the UI could never retry it
    // and that dashboard would look permanently stuck.
  }

  /**
   * One read before the loop, not one per channel. `DashboardStore` re-parses the
   * whole file on every call, so reading per channel would make a 200-channel
   * workspace pay 200 full parses for cursors already in hand.
   */
  private async loadCursors(teamId: string): Promise<Map<string, string | undefined>> {
    const stored = (await this.dashboardStore.read()).workspaces[teamId]?.channels ?? {}
    const cursors = new Map<string, string | undefined>()
    for (const [channelId, channel] of Object.entries(stored)) {
      cursors.set(channelId, channel.lastSyncTs)
    }
    return cursors
  }

  /**
   * Map a transport failure onto the error the caller should act on.
   *
   * Only the two codes in `INVALID_AUTH_CODES` — `invalid_auth` and
   * `token_revoked` — become `ReconnectRequiredError`. Everything else, including
   * `RateLimitError`, is returned unchanged so the caller can read `retryAfterSeconds`
   * off it, and so a generic `catch` still works while the store holds whatever the
   * walk had already committed.
   *
   * A non-`Error` rejection is widened rather than thrown raw: `throw 'boom'` from a
   * client would otherwise reach the caller as a string, where `.message` reads
   * `undefined` and the error-phase progress tick would carry no text at all.
   */
  private classify(err: unknown, teamId: string): Error {
    if (err instanceof SlackApiError && INVALID_AUTH_CODES.has(err.slackError)) {
      return new ReconnectRequiredError(
        teamId,
        `Slack rejected the stored token for ${teamId} (${err.slackError}); reconnect required`
      )
    }
    return err instanceof Error ? err : new Error(String(err))
  }

  /** The UI is not load-bearing: a listener that throws must not abort the walk. */
  private emit(progress: SyncProgress): void {
    try {
      this.onProgress?.(progress)
    } catch (err) {
      // Swallowing silently would make a permanently broken renderer callback look
      // exactly like a working one, so say so in the log the user can send us.
      log.warn('sync progress listener threw; walk continues', {
        teamId: progress.teamId,
        teamName: progress.teamName,
        phase: progress.phase,
        error: String(err)
      })
    }
  }
}
