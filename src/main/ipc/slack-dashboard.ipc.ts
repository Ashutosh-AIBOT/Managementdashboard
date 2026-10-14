import { IpcChannels } from '../../shared/ipc-contract'
import { TREND_DAYS } from '../../shared/types'
import type {
  ClearDashboardPayload,
  DashboardChannel,
  DashboardSettings,
  DashboardSnapshot,
  DashboardWorkspace,
  ReconnectNeededPayload,
  SyncNowPayload,
  SyncNowResult
} from '../../shared/types'
import { dailySeries, sentimentTrend } from '../../shared/dashboard-view'
import type { AiAnalyzer, AiMessageResult } from '../slack/ai-analyzer'
import type { DashboardStore } from '../slack/dashboard-store'
import { ReconnectRequiredError, SyncInProgressError, type SyncEngine } from '../slack/sync-engine'
import { log } from '../logging'
import { handleInvoke } from './handle'

/**
 * The dashboard's main-process surface.
 *
 * Electron-free on purpose, for the same reason `sync-engine.ts` is: this
 * module imports only *types* from Electron-touching code, declares the window
 * structurally below, and never names `electron`. That is what lets the contract
 * test drive the registered handlers with no Electron runtime.
 */

/** Just enough of `BrowserWindow` to send an event. */
export interface DashboardEventTarget {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

export type GetDashboardWindow = () => DashboardEventTarget | null

/** The narrow settings slice the dashboard needs. `AppSettingsStore` backs it. */
export interface DashboardSettingsStore {
  get(): Promise<DashboardSettings>
  set(patch: Partial<DashboardSettings>): Promise<DashboardSettings>
}

export interface SlackDashboardIpcDeps {
  syncEngine: SyncEngine
  dashboardStore: DashboardStore
  settingsStore: DashboardSettingsStore
  aiAnalyzer: AiAnalyzer
  getMainWindow: GetDashboardWindow
}

/** `sentimentScore` and `completionEstimate` are per-channel rollups of the labels. */
interface ChannelAiOutcome {
  byTs: Map<string, AiMessageResult>
  eligible: number
}

export function registerSlackDashboardIpc(deps: SlackDashboardIpcDeps): void {
  handleInvoke(IpcChannels.SlackDashboardGet, async () => buildSnapshot(deps))

  handleInvoke(IpcChannels.SlackDashboardSyncNow, async (payload: SyncNowPayload) => {
    return runDashboardSync(deps, payload)
  })

  handleInvoke(IpcChannels.SlackDashboardSetAutoSync, async (autoSync: boolean) => {
    // Coercing a malformed payload to `false` would silently switch the user's
    // preference off. A boolean is the only thing this channel accepts, so
    // anything else is a caller bug and is reported as one.
    if (typeof autoSync !== 'boolean') {
      throw new Error('slack-dashboard:set-auto-sync expects a boolean')
    }
    return deps.settingsStore.set({ autoSync })
  })

  handleInvoke(IpcChannels.SlackDashboardClear, async (payload?: ClearDashboardPayload) => {
    const teamId = payload?.teamId?.trim()
    const file = await deps.dashboardStore.read()
    // A walk in flight is mid-`recordMessages`: clearing underneath it lets the
    // walk re-create the workspace on its next channel, so the user's "clear"
    // silently un-does itself. Refuse instead of pretending to succeed.
    const busy = Object.keys(file.workspaces).filter((id) => deps.syncEngine.isSyncing(id))
    if (busy.length > 0) {
      throw new Error(
        `cannot clear while ${busy.length} workspace(s) are syncing: ${busy.join(', ')}`
      )
    }
    // No event: the caller is the renderer that asked, and it re-reads with
    // `slack-dashboard:get` once this resolves. A broadcast would be a second
    // path for the same update with no second consumer to justify it.
    await deps.dashboardStore.update((draft) => {
      if (!teamId) {
        draft.workspaces = {}
        return
      }
      delete draft.workspaces[teamId]
    })
  })
}

/**
 * One walk, then the two things that must follow it.
 *
 * The refusals are returned rather than thrown so the renderer's two journeys
 * stay distinguishable: `reconnect-required` means the token is gone and only a
 * reconnect helps, `already-syncing` means the workspace is genuinely busy and
 * the caller should wait. Everything else is `failed`, and the walk's own error
 * text rides along.
 *
 * A `ReconnectRequiredError` also fires the `reconnect-needed` event, because
 * the sidebar may be showing a workspace nobody has clicked "sync" on yet.
 *
 * Exported so the automatic driver runs the identical pipeline as a manual sync
 * rather than a second, slightly different copy of it. A duplicate would be free
 * to prune without analysing, or to skip the workspace-lock, and the two paths
 * would drift silently.
 */
export async function runDashboardSync(
  deps: SlackDashboardIpcDeps,
  payload: SyncNowPayload
): Promise<SyncNowResult> {
  const send = (channel: string, value: unknown): void => {
    const win = deps.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, value)
    }
  }
  const teamId = payload?.teamId?.trim() ?? ''
  if (!teamId) {
    return { ok: false, teamId, reason: 'failed', message: 'teamId is required' }
  }

  const stored = (await deps.dashboardStore.read()).workspaces[teamId]
  // The stored name wins over the payload's so a renderer typo cannot rename a
  // team; a workspace that only has the seeded `teamId` as its name takes the
  // payload's, which is how a first sync gets a real one.
  const teamName =
    stored && stored.teamName !== teamId ? stored.teamName : payload.teamName?.trim() || teamId
  const profileId = payload.profileId?.trim() || stored?.profileId || ''

  // The lock is taken by `syncWorkspaceWithFollowUp` and held until `followUp`
  // returns, so prune and analysis run under it. `isSyncing(teamId)` therefore
  // stays true for the whole pipeline, `syncingTeamIds` reports it honestly, and
  // a second sync of the same workspace is refused rather than racing this one.
  //
  // The follow-up returns the whole result rather than assigning to an outer
  // variable, so the success path cannot read a value the compiler must assume
  // was never written.
  let completed: SyncNowResult
  try {
    completed = await deps.syncEngine.syncWorkspaceWithFollowUp(
      { profileId, teamId, teamName },
      async (walked): Promise<SyncNowResult> => {
        const pruned = await pruneAndAnalyze(deps, walked.teamId, teamName)
        return { ok: true, ...walked, pruned }
      }
    )
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      const body: ReconnectNeededPayload = { teamId, teamName }
      send(IpcChannels.SlackDashboardReconnectNeeded, body)
      return { ok: false, teamId, reason: 'reconnect-required', message: err.message }
    }
    if (err instanceof SyncInProgressError) {
      return { ok: false, teamId, reason: 'already-syncing', message: err.message }
    }
    return {
      ok: false,
      teamId,
      reason: 'failed',
      message: err instanceof Error ? err.message : String(err)
    }
  }

  // `pruneAndAnalyze` never rejects, so reaching here means the walk itself is
  // the only thing that can have failed and the walk's own writes are what they
  // would have been on a partial failure.
  return completed
}

/**
 * Enforce the 90-day window, then label what is left in it.
 *
 * Prune first so only text the dashboard can still display is sent to the model
 * — pruning after would pay to label messages that are about to be discarded.
 * Aggregate counts and cursors are untouched by either step.
 *
 * Every step here is best-effort. An AI problem is a degraded dashboard, not a
 * broken sync, so nothing in this function may reject into `runSync`.
 */
async function pruneAndAnalyze(
  deps: SlackDashboardIpcDeps,
  teamId: string,
  teamName: string
): Promise<number> {
  let pruned = 0
  try {
    pruned = await deps.dashboardStore.pruneOldMessages()
    if (pruned > 0) {
      log.info('dashboard: pruned messages past retention', { pruned })
    }
  } catch (err) {
    log.warn('dashboard: prune failed; retention window will grow', { error: String(err) })
  }

  // No provider means every eligible message would come back unlabelled, which
  // is a no-op write on the whole file. Skip it rather than pay for it.
  if (!deps.aiAnalyzer.isAvailable()) {
    return pruned
  }

  try {
    await analyzeWorkspace(deps, teamId, teamName)
  } catch (err) {
    log.warn('dashboard: AI labelling failed; rendering without AI sections', {
      teamId,
      error: String(err)
    })
  }
  return pruned
}

/**
 * Label one workspace's channels and fold the labels back into the rollups.
 *
 * Per channel rather than workspace-wide, because `aiEligible` / `aiAnalyzed`
 * are reported per channel and a budget spent on one channel's messages must not
 * be what makes another channel read as "nothing to analyse".
 *
 * ## Labels are replaced, never merged
 *
 * A message whose label is *missing* from this round has its stored `sentiment`
 * and `completionHint` deleted. That is the difference between "analysed and
 * found neutral" and "not analysed at all", and conflating them is the whole
 * failure the three-field contract exists to prevent: when a provider starts
 * failing, a merge would leave last week's labels in place, the snapshot would
 * report `aiAnalyzed === aiEligible`, and the dashboard would render stale
 * sentiment as a fresh, healthy analysis — forever, since nothing would look
 * wrong enough to retry.
 */
async function analyzeWorkspace(
  deps: SlackDashboardIpcDeps,
  teamId: string,
  teamName: string
): Promise<void> {
  const channels = Object.values(
    (await deps.dashboardStore.read()).workspaces[teamId]?.channels ?? {}
  )

  const outcomes = new Map<string, ChannelAiOutcome>()
  let messagesConsidered = 0
  for (const [index, channel] of channels.entries()) {
    // Same filter `AiAnalyzer.analyzeBatch` applies, so `eligible` computed here
    // and the one it reports always mean the same thing.
    const input = channel.recentMessages
      .filter((m) => m.text.trim() !== '')
      .map((m) => ({ ts: m.ts, text: m.text }))
    const batch = await deps.aiAnalyzer.analyzeBatch(input)
    outcomes.set(channel.channelId, { byTs: batch.results, eligible: batch.eligible })
    messagesConsidered += input.length
    // The engine owns the progress stream but cannot report a phase it does not
    // run, so the walk would sit on 'done' for the whole of the slowest phase.
    deps.syncEngine.emitProgress({
      phase: 'analyzing',
      teamId,
      teamName,
      channelIndex: index + 1,
      channelTotal: channels.length,
      messageCount: messagesConsidered
    })
  }

  if (outcomes.size === 0) {
    return
  }

  await deps.dashboardStore.update((file) => {
    for (const channel of Object.values(file.workspaces[teamId]?.channels ?? {})) {
      const outcome = outcomes.get(channel.channelId)
      if (!outcome) continue

      let scoreSum = 0
      let hints = 0
      for (const message of channel.recentMessages) {
        const label = outcome.byTs.get(message.ts)
        if (label) {
          message.sentiment = label.sentiment
          scoreSum += label.score
          if (label.completionHint) {
            message.completionHint = label.completionHint
            hints += 1
          } else {
            delete message.completionHint
          }
        } else {
          // Absent from this round's results: analysed before, not now.
          delete message.sentiment
          delete message.completionHint
        }
      }

      if (outcome.eligible === 0) continue
      // Divide by `eligible`, not `labelled`. A batch that labelled 1 of 2
      // messages must not read as a perfect score on both metrics; over
      // `labelled` it would round to 1 and 1 and look exactly like a complete
      // analysis. Over `eligible` the partial result stays partial.
      channel.sentimentScore = round3(scoreSum / outcome.eligible)
      channel.completionEstimate = round3(hints / outcome.eligible)
    }
  })
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Read the whole dashboard and derive everything the UI must not have to guess.
 *
 * Every derived field — the three AI counts, the trend and the series — is
 * counted from the stored window rather than persisted. `aiConfigured` is a
 * configuration fact from the analyzer, `aiEligible` is the number of messages
 * that still have text, `aiAnalyzed` is how many of those carry a label.
 * Recomputing them per read means a snapshot can never disagree with the file it
 * came from, and no second copy of the truth exists to drift. The same holds for
 * the series: both windows are fixed at `TREND_DAYS` so the renderer can index
 * into them by offset without carrying its own clock.
 */
async function buildSnapshot(deps: SlackDashboardIpcDeps): Promise<DashboardSnapshot> {
  const [file, settings] = await Promise.all([deps.dashboardStore.read(), deps.settingsStore.get()])
  const aiConfigured = deps.aiAnalyzer.isAvailable()

  const workspaces: Record<string, DashboardWorkspace> = {}
  for (const [teamId, workspace] of Object.entries(file.workspaces)) {
    const channels: Record<string, DashboardChannel> = {}
    for (const [channelId, channel] of Object.entries(workspace.channels)) {
      let aiEligible = 0
      let aiAnalyzed = 0
      for (const message of channel.recentMessages) {
        if (message.text.trim() === '') continue
        aiEligible += 1
        if (message.sentiment) aiAnalyzed += 1
      }
      channels[channelId] = {
        ...channel,
        aiConfigured,
        aiEligible,
        aiAnalyzed,
        // Spread after the channel so a derived field can never be shadowed by
        // a stale one that happens to be sitting in the file.
        sentimentTrend: sentimentTrend(channel.recentMessages, TREND_DAYS),
        dailySeries: dailySeries(channel.dailyCounts, TREND_DAYS)
      }
    }
    workspaces[teamId] = { ...workspace, channels }
  }

  return {
    workspaces,
    settings,
    // Keyed by teamId: two workspaces are free to share a display name, and a
    // name-keyed spinner would light up on the wrong one.
    syncingTeamIds: Object.keys(workspaces).filter((teamId) => deps.syncEngine.isSyncing(teamId))
  }
}

/* ------------------------------------------------------------------ *
 * Auto-sync
 *
 * The driver is a pure decision plus a thin timer, so the part that can be
 * wrong (which workspaces to start) is testable without Electron and without
 * waiting fifteen minutes.
 * ------------------------------------------------------------------ */

/**
 * How long between automatic cycles.
 *
 * Slack Tier 2 allows ~3 requests per minute. A cycle costs one
 * `conversations.list` plus one `conversations.history` per channel, so a
 * workspace with N channels spends N+1 of them. At the default 15 minutes a
 * cycle may spend 15 requests, leaving most of the tier's budget for the walk
 * itself; the engine's own `withRetry` absorbs the rest. A 200-channel
 * workspace therefore completes a cycle in roughly 70 minutes at Tier 2, which
 * is the honest cost of walking that many channels on a free Slack plan and is
 * why the default is minutes rather than seconds.
 *
 * Override with `DASHBOARD_AUTO_SYNC_MINUTES`. Clamped to 1..1440 so a typo
 * cannot spin the timer or silently disable the feature by setting 0.
 */
export const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 15

export function autoSyncIntervalMs(raw: string | undefined): number {
  const parsed = Number(raw)
  // A non-positive or unparseable value means no interval was chosen, so it falls
  // back to the default rather than clamping down to the one-minute floor: `-5`
  // is a typo, and the floor is the most expensive possible reading of a typo
  // against a rate-limited API.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUTO_SYNC_INTERVAL_MINUTES * 60_000
  }
  // Round *before* clamping: `0.4` rounds to 0, and a zero-length interval would
  // spin the timer on every tick of the event loop.
  return Math.min(1440, Math.max(1, Math.round(parsed))) * 60_000
}

/** Everything the decision reads. Plain data so it can be tested directly. */
export interface AutoSyncDecision {
  /** Whether the user turned automatic syncing on. Default off. */
  enabled: boolean
  /** `app.isReady()`. Electron before `whenReady` has no usable paths or windows. */
  ready: boolean
  /** teamIds with a walk already in flight. */
  syncingTeamIds: readonly string[]
  /** teamIds the store knows about. */
  knownTeamIds: readonly string[]
}

/**
 * Which workspaces this cycle should start, or `[]` for no cycle at all.
 *
 * Three ways to decline, each for a different reason: the user has not asked for
 * it (default off, so the app never spends a Slack token the user did not offer),
 * Electron is not ready yet (a timer that fires before `whenReady` would read
 * `userData` before it is resolvable), and the workspace is already walking
 * (starting a second walk would double the rate-limit cost and race the progress
 * ticks). Declining the busy case is per workspace, not global: one rate-limited
 * workspace must not stop the others from refreshing.
 */
export function workspacesDueForAutoSync(decision: AutoSyncDecision): string[] {
  if (!decision.enabled || !decision.ready) return []
  const busy = new Set(decision.syncingTeamIds)
  return decision.knownTeamIds.filter((teamId) => !busy.has(teamId))
}
