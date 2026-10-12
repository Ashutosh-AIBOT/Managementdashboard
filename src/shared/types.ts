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
