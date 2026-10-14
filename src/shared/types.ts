/**
 * Multi-app profile model: each profile hosts Slack + Teams + WhatsApp sessions.
 * Browser cookies live in persist:profile-<id>-<appId> partitions.
 */

export type AppId = 'slack' | 'teams' | 'whatsapp'

export const APP_IDS: readonly AppId[] = ['slack', 'teams', 'whatsapp'] as const

/** Slack browser-session login phases (Google → Slack SSO). */
export type SlackSessionStatus =
  'not-signed-in' | 'signing-in-google' | 'signing-in-slack' | 'signed-in'

/** Teams browser-session login phases (Microsoft identity). */
export type TeamsSessionStatus = 'not-signed-in' | 'signing-in' | 'signed-in'

/** WhatsApp Web login phases (QR link on phone). */
export type WhatsAppSessionStatus = 'not-signed-in' | 'signing-in' | 'signed-in'

export type AppSessionStatus = SlackSessionStatus | TeamsSessionStatus | WhatsAppSessionStatus

/** @deprecated Use SlackSessionStatus / AppSessionStatus — kept for migration helpers. */
export type ProfileSessionStatus = SlackSessionStatus

/** Workspace/org this app session can open (synced / captured). */
export interface AvailableWorkspace {
  teamId: string
  teamName: string
  openUrl: string
  teamDomain?: string
  lastSeenAt: string
  /** Last Slack channel/DM title seen in this workspace (sidebar + recents). */
  lastChannelName?: string
}

/** Pinned subset of availableWorkspaces — quick switcher only. */
export interface PinnedWorkspace {
  teamId: string
  teamName: string
  openUrl: string
  teamDomain?: string
}

/** Candidate scraped from an embed before id is confirmed. */
export interface DiscoveredWorkspace {
  teamId: string | null
  teamName: string
  openUrl: string
  teamDomain?: string
}

export interface AppSession {
  sessionStatus: AppSessionStatus
  availableWorkspaces: AvailableWorkspace[]
  pinnedWorkspaces: PinnedWorkspace[]
}

export interface ProfileApps {
  slack: AppSession
  teams: AppSession
  whatsapp: AppSession
}

export interface Profile {
  id: string
  displayName: string
  /** Optional friendly label; UI prefers this over displayName (email). */
  customName?: string
  createdAt: string
  avatarColor: string
  /** Optional photo URL (e.g. captured after Google/Slack sign-in). */
  avatarUrl?: string
  /** Lower sorts first; missing treated as large. */
  sortOrder?: number
  /** When true, skip tray/desktop notifications for this profile. */
  muted?: boolean
  /**
   * Google account cookies ready (Chrome password + 2SV).
   * App logins (Slack/Teams) happen separately after the user picks an app.
   */
  googleAuthStatus: 'not-signed-in' | 'signing-in' | 'signed-in'
  apps: ProfileApps
}

export function profileDisplayLabel(profile: Profile): string {
  const custom = profile.customName?.trim()
  return custom || profile.displayName
}

export interface ProfileSessionStatusPayload {
  profileId: string
  appId: AppId
  sessionStatus: AppSessionStatus
}

export interface SlackWorkspaceLink {
  profileId: string
  teamId: string
  teamName: string
  teamDomain: string
  connectedAt: string
  scopes: string[]
}

export interface SlackChannelSummary {
  id: string
  name: string
  isPrivate: boolean
  topic?: string
  memberCount?: number
}

export interface SlackMessageSummary {
  ts: string
  user?: string
  text: string
}

/**
 * Canonical home for the Slack Dashboard persistence model — the shape of
 * userData/dashboard.json. `src/main/slack/dashboard-store.ts` imports these and
 * re-exports them as aliases; do NOT declare them again there or in the IPC
 * layer. Two same-named interfaces are structurally identical, so TypeScript
 * never complains and the wrong one silently wins.
 *
 * The version / retention constants live in `dashboard-store.ts` — import them
 * from there rather than redeclaring.
 */
export type Sentiment = 'positive' | 'neutral' | 'negative'

export interface DashboardMessage {
  ts: string
  user?: string
  text: string
  sentiment?: Sentiment
  completionHint?: string
}

export interface ChannelRollup {
  channelId: string
  channelName: string
  isPrivate: boolean
  /** Incremental cursor: the newest ts this channel has ever been synced to. */
  lastSyncTs?: string
  /** Lifetime count. Pruning message text must never touch it. */
  totalMessages: number
  /** Lifetime per-day counts, keyed by UTC `YYYY-MM-DD`. */
  dailyCounts: Record<string, number>
  /** The 90-day window. The only field pruning is allowed to shrink. */
  recentMessages: DashboardMessage[]
  sentimentScore?: number
  completionEstimate?: number
}

export interface WorkspaceRollup {
  teamId: string
  teamName: string
  profileId: string
  lastSyncAt: string
  channels: Record<string, ChannelRollup>
}

export interface DashboardFile {
  version: number
  workspaces: Record<string, WorkspaceRollup>
}

/* ------------------------------------------------------------------ *
 * What the renderer reads. Not what we persist.
 *
 * Everything below is derived at read time in
 * `src/main/ipc/slack-dashboard.ipc.ts` and never written back to
 * dashboard.json. Keeping the AI counts out of `ChannelRollup` is why they
 * cannot go stale: they are recomputed from the stored window on every read,
 * so there is no second copy of the truth to disagree with it.
 * ------------------------------------------------------------------ */

/**
 * The three fields that separate "no key", "nothing to analyse" and "failing".
 *
 * One `aiAvailable` boolean cannot express all three, and collapsing the last
 * two into it is what makes a dashboard retry silently forever. Derive in this
 * order, and treat a partial result as normal:
 *
 * | State | Condition | What the UI should do |
 * | --- | --- | --- |
 * | No key configured | `!aiConfigured` | Admin prompt to set `OPENAI_API_KEY`. Not a retry. |
 * | Nothing to analyse | `aiConfigured && aiEligible === 0` | No AI state at all. Not an error. |
 * | Failing | `aiEligible > 0 && aiAnalyzed === 0` | Silent retry, or a low-key indicator. |
 * | Degraded | `0 < aiAnalyzed < aiEligible` | Render what exists; retry the rest. |
 * | Healthy | `aiAnalyzed >= aiEligible` | Render normally. |
 *
 * **Degraded is a normal outcome.** The model may omit rows and a batch stops
 * early on a rejected key, so `aiAnalyzed` legitimately sits between 0 and
 * `aiEligible` on a working system. No gap may be rendered as an error.
 */
export interface ChannelAiStatus {
  /** A provider is wired. Stable for the process lifetime — not a health check. */
  aiConfigured: boolean
  /** Messages in the 90-day window that had text worth analysing. */
  aiEligible: number
  /** How many of those carry a label. */
  aiAnalyzed: number
}

/** Width of both derived series. Matches `MESSAGE_RETENTION_DAYS` in the store. */
export const TREND_DAYS = 90

/**
 * A stored channel plus everything derived from it on read.
 *
 * `TrendPoint` is named through an inline `import()` because `dashboard-view.ts`
 * already imports this file: a top-level type import would close a cycle between
 * the model and the view model built on top of it.
 */
export type DashboardChannel = ChannelRollup &
  ChannelAiStatus & {
    /** Per-day sentiment over the 90-day window. Days with no labels are omitted. */
    sentimentTrend: import('./dashboard-view').TrendPoint[]
    /** Oldest-first, zero-filled, `TREND_DAYS` long. Sparkline input. */
    dailySeries: number[]
  }

/** A stored workspace whose channels carry their derived AI status. */
export interface DashboardWorkspace extends Omit<WorkspaceRollup, 'channels'> {
  channels: Record<string, DashboardChannel>
}

/**
 * Dashboard preferences. `autoSync` is the user-facing toggle; nothing in this
 * task schedules anything on it yet, so a renderer must not imply a refresh has
 * happened just because it is true.
 */
export interface DashboardSettings {
  autoSync: boolean
}

/**
 * One read of the whole dashboard. Small enough to send whole on every change:
 * the file is already bounded by the 90-day retention window.
 */
export interface DashboardSnapshot {
  /** Keyed by `teamId`. Never by `teamName` — two workspaces may share one. */
  workspaces: Record<string, DashboardWorkspace>
  settings: DashboardSettings
  /**
   * Teams with a walk in flight right now, keyed by `teamId`.
   *
   * Present because progress is an event stream, not state: a window that
   * remounts mid-sync has replayed no ticks and would otherwise render an idle
   * dashboard while the walk is running, and clicking Sync again would be
   * refused as "already syncing". A workspace synced for the first time appears
   * here only once it has been written to the store.
   */
  syncingTeamIds: string[]
}

/**
 * The progress tick as it crosses IPC, and the single declaration of it.
 *
 * This lives here rather than in `src/main/slack/sync-engine.ts` because it is
 * the shape the *renderer* consumes, and the renderer may only import from
 * `src/shared`. `sync-engine.ts` imports this type and aliases it as
 * `SyncProgress` — an alias, not a second declaration. An earlier version
 * declared the shape in both places and asserted they matched with a
 * conditional type; that assertion was inert, because an unused exported type
 * alias is never evaluated and a drift between the two shapes still compiled
 * clean. One declaration makes the drift unrepresentable.
 */
export interface SyncProgressPayload {
  phase: 'idle' | 'listing-channels' | 'reading-messages' | 'analyzing' | 'done' | 'error'
  /** The workspace this tick belongs to. Key listeners on this, not teamName. */
  teamId: string
  teamName: string
  /** 0-based; renderers show `channelIndex + 1`. */
  channelIndex: number
  channelTotal: number
  messageCount: number
  message?: string
}

/** `slack-dashboard:sync-now` — ask for one workspace walk. */
export interface SyncNowPayload {
  profileId: string
  teamId: string
  /** Optional: the stored name wins, so a renderer typo cannot rename a team. */
  teamName?: string
}

/**
 * Why a sync stopped, as distinct states rather than as a thrown string.
 *
 * A discriminated result rather than a rejection because the two refusals are
 * genuinely different user journeys — "reconnect Slack" versus "wait" — and
 * Electron mangles a thrown `Error` into an untyped string across `invoke`.
 */
export type SyncNowResult =
  | {
      ok: true
      teamId: string
      messagesRead: number
      channelsSynced: number
      /** Messages past the 90-day window dropped by the post-sync prune. */
      pruned: number
    }
  | {
      ok: false
      teamId: string
      reason: 'reconnect-required' | 'already-syncing' | 'failed'
      message: string
    }

/** `slack-dashboard:clear` — scope is one workspace, or all of them. */
export interface ClearDashboardPayload {
  /** Omit to wipe every workspace. */
  teamId?: string
}

/** `slack-dashboard:reconnect-needed` — the stored token is gone, not the sync. */
export interface ReconnectNeededPayload {
  teamId: string
  teamName: string
}

export interface CreateProfileInput {
  displayName: string
}

export interface ProfileIdPayload {
  profileId: string
}

export interface AppScopedPayload {
  profileId: string
  appId: AppId
}

export interface WorkspacePayload {
  profileId: string
  teamId: string
}

export interface PinFromAvailablePayload {
  profileId: string
  appId: AppId
  teamId: string
}

export interface UnpinWorkspacePayload {
  profileId: string
  appId: AppId
  teamId: string
}

export interface SyncWorkspacesPayload {
  profileId: string
  appId: AppId
  bounds: ViewportBounds
}

export interface OpenWorkspacePayload {
  profileId: string
  appId: AppId
  teamId: string
  bounds: ViewportBounds
}

export interface StartAppLoginPayload {
  profileId: string
  appId: AppId
  /** Required for embed-first login so the right-pane view can be shown. */
  bounds?: ViewportBounds
}

export interface StartGoogleAuthPayload {
  profileId: string
  /** Right-pane bounds so Google sign-in loads in the main embed. */
  bounds?: ViewportBounds
}

export interface ActivateAppPayload {
  profileId: string
  appId: AppId
  bounds: ViewportBounds
}

export interface ChannelHistoryPayload {
  profileId: string
  teamId: string
  channelId: string
  limit?: number
}

export interface ViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ActivateProfilePayload {
  profileId: string
  bounds: ViewportBounds
}

export interface CurrentWorkspaceInfo {
  profileId: string
  appId: AppId
  teamId: string
  url: string
}

export interface WorkspaceThemePayload {
  profileId: string
  appId: AppId | 'default'
  teamId?: string
  /** Primary accent (buttons, highlights) */
  accent: string
  /** Sidebar surface tint */
  sidebar: string
  /** Detected Slack (or app) chrome luminance */
  mode?: 'light' | 'dark'
}

export function emptySlackSession(): AppSession {
  return {
    sessionStatus: 'not-signed-in',
    availableWorkspaces: [],
    pinnedWorkspaces: []
  }
}

export function emptyTeamsSession(): AppSession {
  return {
    sessionStatus: 'not-signed-in',
    availableWorkspaces: [],
    pinnedWorkspaces: []
  }
}

export function emptyWhatsAppSession(): AppSession {
  return {
    sessionStatus: 'not-signed-in',
    availableWorkspaces: [],
    pinnedWorkspaces: []
  }
}

export function emptyProfileApps(): ProfileApps {
  return {
    slack: emptySlackSession(),
    teams: emptyTeamsSession(),
    whatsapp: emptyWhatsAppSession()
  }
}

export function appLabel(appId: AppId): string {
  if (appId === 'slack') {
    return 'Slack'
  }
  if (appId === 'teams') {
    return 'Teams'
  }
  return 'WhatsApp'
}

/** WhatsApp has a single Web session — no workspace tree. */
export function appSupportsWorkspaces(appId: AppId): boolean {
  return appId === 'slack' || appId === 'teams'
}
