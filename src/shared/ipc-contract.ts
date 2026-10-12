import type {
  ActivateAppPayload,
  ActivateProfilePayload,
  AppId,
  ChannelHistoryPayload,
  CreateProfileInput,
  CurrentWorkspaceInfo,
  OpenWorkspacePayload,
  PinFromAvailablePayload,
  Profile,
  ProfileIdPayload,
  ProfileSessionStatusPayload,
  SlackChannelSummary,
  SlackMessageSummary,
  SlackWorkspaceLink,
  StartAppLoginPayload,
  SyncWorkspacesPayload,
  UnpinWorkspacePayload,
  ViewportBounds,
  WorkspacePayload,
  WorkspaceThemePayload,
  StartGoogleAuthPayload
} from './types'

export const IpcChannels = {
  ProfileList: 'profile:list',
  ProfileCreate: 'profile:create',
  ProfileDelete: 'profile:delete',
  ProfileDeleteUnsignedDuplicates: 'profile:delete-unsigned-duplicates',
  ProfileClearStuckAuth: 'profile:clear-stuck-auth',
  ProfileCancelAuthBusy: 'profile:cancel-auth-busy',
  ProfileActivate: 'profile:activate',
  ProfileActivateApp: 'profile:activate-app',
  ProfileUpdateBounds: 'profile:update-bounds',
  ProfileSetEmbedVisible: 'profile:set-embed-visible',
  ProfileStartFirstLogin: 'profile:start-first-login',
  ProfileStartGoogleAuth: 'profile:start-google-auth',
  ProfileStartAppLogin: 'profile:start-app-login',
  ProfileConfirmChromeEmbed: 'profile:confirm-chrome-embed',
  ProfileCancelChromeEmbed: 'profile:cancel-chrome-embed',
  ProfileSyncChromeEmbedBounds: 'profile:sync-chrome-embed-bounds',
  ProfileSyncWorkspaces: 'profile:sync-workspaces',
  ProfilePinFromAvailable: 'profile:pin-from-available',
  ProfileUnpinWorkspace: 'profile:unpin-workspace',
  ProfileGetCurrentWorkspace: 'profile:get-current-workspace',
  ProfileOpenWorkspace: 'profile:open-workspace',
  ProfileSetCustomName: 'profile:set-custom-name',
  ProfileSetMuted: 'profile:set-muted',
  ProfileReorder: 'profile:reorder',
  ProfileClearAll: 'profile:clear-all',
  ProfileExportMetadata: 'profile:export-metadata',
  ProfileImportMetadata: 'profile:import-metadata',
  ProfileActivateSplit: 'profile:activate-split',
  ProfileClearSplit: 'profile:clear-split',
  ProfileSessionStatusChanged: 'profile:session-status-changed',
  ProfileUpdated: 'profile:updated',
  ProfileAuthProgress: 'profile:auth-progress',
  ProfileDeepLink: 'profile:deep-link',
  UnreadCountsChanged: 'unread:counts-changed',
  WorkspaceThemeChanged: 'ui:workspace-theme-changed',
  AppToast: 'app:toast',

  AppSettingsGet: 'app:settings-get',
  AppSettingsSet: 'app:settings-set',
  AppSettingsChanged: 'app:settings-changed',
  AppLock: 'app:lock',
  AppUnlock: 'app:unlock',
  AppLockStateChanged: 'app:lock-state-changed',
  AppIdleActivity: 'app:idle-activity',
  AppPushRecent: 'app:push-recent',
  AppCheckUpdates: 'app:check-updates',
  AppTestNotification: 'app:test-notification',
  AppAdminStatus: 'app:admin-status',
  AppAdminLogin: 'app:admin-login',
  AppAdminLogout: 'app:admin-logout',

  OauthStartWorkspaceConnect: 'oauth:start-workspace-connect',

  SlackWorkspacesForProfile: 'slack:workspaces-for-profile',
  SlackChannelsForWorkspace: 'slack:channels-for-workspace',
  SlackHistoryForChannel: 'slack:history-for-channel'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/** Key: `${profileId}:${appId}` → unread count */
export type UnreadCountsMap = Record<string, number>

export interface AppSettings {
  notificationsEnabled: boolean
  idleLockMinutes: number
  theme: 'system' | 'light' | 'dark'
  sidebarDensity: 'comfortable' | 'compact'
  /** Sidebar pixel width (user-resizable). */
  sidebarWidth: number
  /** When true, primary sidebar is collapsed (IDE-style). */
  sidebarCollapsed: boolean
  idleSleepMinutes: number
  splitViewEnabled: boolean
  notificationSound: boolean
  recentWorkspaces: Array<{
    profileId: string
    appId: string
    teamId: string
    label: string
    at: string
  }>
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  notificationsEnabled: true,
  idleLockMinutes: 15,
  theme: 'dark',
  sidebarDensity: 'comfortable',
  sidebarWidth: 300,
  sidebarCollapsed: false,
  idleSleepMinutes: 30,
  splitViewEnabled: false,
  notificationSound: false,
  recentWorkspaces: []
}

export type AdminStatus = {
  authenticated: boolean
  configured: boolean
  envPathHint: string
}

export type AdminLoginResult = { ok: true } | { ok: false; message: string }

export interface IpcApi {
  profiles: {
    list: () => Promise<Profile[]>
    create: (displayName: string) => Promise<Profile>
    delete: (profileId: string) => Promise<void>
    deleteUnsignedDuplicates: () => Promise<Profile[]>
    clearStuckAuth: () => Promise<Profile[]>
    cancelAuthBusy: (profileId?: string) => Promise<Profile[]>
    clearAll: () => Promise<Profile[]>
    setCustomName: (profileId: string, customName: string | null) => Promise<Profile>
    setMuted: (profileId: string, muted: boolean) => Promise<Profile>
    reorder: (orderedIds: string[]) => Promise<Profile[]>
    exportMetadata: () => Promise<Profile[]>
    importMetadata: (profiles: Profile[]) => Promise<Profile[]>
    activate: (profileId: string, bounds: ViewportBounds) => Promise<void>
    activateApp: (profileId: string, appId: AppId, bounds: ViewportBounds) => Promise<void>
    activateSplit: (
      primary: { profileId: string; appId: AppId; bounds: ViewportBounds },
      secondary: { profileId: string; appId: AppId; bounds: ViewportBounds }
    ) => Promise<void>
    clearSplit: () => Promise<void>
    updateBounds: (bounds: ViewportBounds) => Promise<void>
    setEmbedVisible: (visible: boolean) => Promise<void>
    startGoogleAuth: (profileId: string, bounds?: ViewportBounds) => Promise<Profile>
    startAppLogin: (profileId: string, appId: AppId, bounds?: ViewportBounds) => Promise<Profile>
    startFirstLogin: (profileId: string, bounds?: ViewportBounds) => Promise<Profile>
    confirmChromeEmbed: () => Promise<boolean>
    cancelChromeEmbed: () => Promise<boolean>
    syncChromeEmbedBounds: (bounds: ViewportBounds) => Promise<void>
    syncWorkspaces: (profileId: string, appId: AppId, bounds: ViewportBounds) => Promise<Profile>
    pinFromAvailable: (profileId: string, appId: AppId, teamId: string) => Promise<Profile>
    unpinWorkspace: (profileId: string, appId: AppId, teamId: string) => Promise<Profile>
    getCurrentWorkspace: (profileId: string, appId: AppId) => Promise<CurrentWorkspaceInfo | null>
    openWorkspace: (
      profileId: string,
      appId: AppId,
      teamId: string,
      bounds: ViewportBounds
    ) => Promise<void>
    onSessionStatusChanged: (callback: (payload: ProfileSessionStatusPayload) => void) => () => void
    onProfileUpdated: (callback: (profile: Profile) => void) => () => void
    onAuthProgress: (callback: (message: string) => void) => () => void
    onWorkspaceThemeChanged: (callback: (payload: WorkspaceThemePayload) => void) => () => void
    onUnreadCountsChanged: (callback: (counts: UnreadCountsMap) => void) => () => void
    onDeepLink: (
      callback: (payload: { profileId: string; appId?: AppId; teamId?: string }) => void
    ) => () => void
  }
  app: {
    getSettings: () => Promise<AppSettings>
    setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
    pushRecent: (entry: {
      profileId: string
      appId: string
      teamId: string
      label: string
    }) => Promise<AppSettings>
    lock: () => Promise<void>
    unlock: () => Promise<boolean>
    reportActivity: () => Promise<void>
    checkUpdates: () => Promise<{ ok: boolean; message: string }>
    testNotification: () => Promise<{ ok: boolean; message: string }>
    adminStatus: () => Promise<AdminStatus>
    adminLogin: (
      username: string,
      password: string,
      remember?: boolean
    ) => Promise<AdminLoginResult>
    adminLogout: () => Promise<void>
    onLockStateChanged: (callback: (locked: boolean) => void) => () => void
    onToast: (callback: (message: string) => void) => () => void
    onSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
  }
  slack: {
    connectWorkspace: (profileId: string) => Promise<SlackWorkspaceLink>
    listWorkspaces: (profileId: string) => Promise<SlackWorkspaceLink[]>
    listChannels: (profileId: string, teamId: string) => Promise<SlackChannelSummary[]>
    listHistory: (
      profileId: string,
      teamId: string,
      channelId: string,
      limit?: number
    ) => Promise<SlackMessageSummary[]>
  }
}

export type {
  ActivateAppPayload,
  ActivateProfilePayload,
  AppId,
  ChannelHistoryPayload,
  CreateProfileInput,
  CurrentWorkspaceInfo,
  OpenWorkspacePayload,
  PinFromAvailablePayload,
  Profile,
  ProfileIdPayload,
  ProfileSessionStatusPayload,
  SlackChannelSummary,
  SlackMessageSummary,
  SlackWorkspaceLink,
  StartAppLoginPayload,
  StartGoogleAuthPayload,
  SyncWorkspacesPayload,
  UnpinWorkspacePayload,
  ViewportBounds,
  WorkspacePayload,
  WorkspaceThemePayload
}
