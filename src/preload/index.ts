import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  type AppSettings,
  type IpcApi,
  type UnreadCountsMap
} from '../shared/ipc-contract'
import type {
  AppId,
  Profile,
  ProfileSessionStatusPayload,
  ViewportBounds,
  WorkspaceThemePayload
} from '../shared/types'

const api: IpcApi = {
  profiles: {
    list: () => ipcRenderer.invoke(IpcChannels.ProfileList),
    create: (displayName: string) => ipcRenderer.invoke(IpcChannels.ProfileCreate, { displayName }),
    delete: (profileId: string) => ipcRenderer.invoke(IpcChannels.ProfileDelete, { profileId }),
    deleteUnsignedDuplicates: () => ipcRenderer.invoke(IpcChannels.ProfileDeleteUnsignedDuplicates),
    clearStuckAuth: () => ipcRenderer.invoke(IpcChannels.ProfileClearStuckAuth),
    cancelAuthBusy: (profileId?: string) =>
      ipcRenderer.invoke(IpcChannels.ProfileCancelAuthBusy, { profileId }),
    clearAll: () => ipcRenderer.invoke(IpcChannels.ProfileClearAll),
    setCustomName: (profileId, customName) =>
      ipcRenderer.invoke(IpcChannels.ProfileSetCustomName, { profileId, customName }),
    setMuted: (profileId, muted) =>
      ipcRenderer.invoke(IpcChannels.ProfileSetMuted, { profileId, muted }),
    reorder: (orderedIds) => ipcRenderer.invoke(IpcChannels.ProfileReorder, { orderedIds }),
    exportMetadata: () => ipcRenderer.invoke(IpcChannels.ProfileExportMetadata),
    importMetadata: (profiles) =>
      ipcRenderer.invoke(IpcChannels.ProfileImportMetadata, { profiles }),
    activate: (profileId: string, bounds: ViewportBounds) =>
      ipcRenderer.invoke(IpcChannels.ProfileActivate, { profileId, bounds }),
    activateApp: (profileId: string, appId: AppId, bounds: ViewportBounds) =>
      ipcRenderer.invoke(IpcChannels.ProfileActivateApp, { profileId, appId, bounds }),
    activateSplit: (primary, secondary) =>
      ipcRenderer.invoke(IpcChannels.ProfileActivateSplit, { primary, secondary }),
    clearSplit: () => ipcRenderer.invoke(IpcChannels.ProfileClearSplit),
    updateBounds: (bounds: ViewportBounds) =>
      ipcRenderer.invoke(IpcChannels.ProfileUpdateBounds, bounds),
    setEmbedVisible: (visible: boolean) =>
      ipcRenderer.invoke(IpcChannels.ProfileSetEmbedVisible, { visible }),
    startGoogleAuth: (profileId: string, bounds?: ViewportBounds) =>
      ipcRenderer.invoke(IpcChannels.ProfileStartGoogleAuth, { profileId, bounds }),
    startAppLogin: (profileId: string, appId: AppId, bounds?: ViewportBounds) =>
      ipcRenderer.invoke(IpcChannels.ProfileStartAppLogin, { profileId, appId, bounds }),
    startFirstLogin: (profileId: string, bounds?: ViewportBounds) =>
      ipcRenderer.invoke(IpcChannels.ProfileStartFirstLogin, { profileId, bounds }),
    confirmChromeEmbed: () => ipcRenderer.invoke(IpcChannels.ProfileConfirmChromeEmbed),
    cancelChromeEmbed: () => ipcRenderer.invoke(IpcChannels.ProfileCancelChromeEmbed),
    syncChromeEmbedBounds: (bounds: ViewportBounds) =>
      ipcRenderer.invoke(IpcChannels.ProfileSyncChromeEmbedBounds, bounds),
    syncWorkspaces: (profileId: string, appId: AppId, bounds: ViewportBounds) =>
      ipcRenderer.invoke(IpcChannels.ProfileSyncWorkspaces, { profileId, appId, bounds }),
    pinFromAvailable: (profileId: string, appId: AppId, teamId: string) =>
      ipcRenderer.invoke(IpcChannels.ProfilePinFromAvailable, { profileId, appId, teamId }),
    unpinWorkspace: (profileId: string, appId: AppId, teamId: string) =>
      ipcRenderer.invoke(IpcChannels.ProfileUnpinWorkspace, { profileId, appId, teamId }),
    getCurrentWorkspace: (profileId: string, appId: AppId) =>
      ipcRenderer.invoke(IpcChannels.ProfileGetCurrentWorkspace, { profileId, appId }),
    openWorkspace: (profileId: string, appId: AppId, teamId: string, bounds: ViewportBounds) =>
      ipcRenderer.invoke(IpcChannels.ProfileOpenWorkspace, { profileId, appId, teamId, bounds }),
    onSessionStatusChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ProfileSessionStatusPayload
      ): void => callback(payload)
      ipcRenderer.on(IpcChannels.ProfileSessionStatusChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannels.ProfileSessionStatusChanged, listener)
    },
    onProfileUpdated: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, profile: Profile): void =>
        callback(profile)
      ipcRenderer.on(IpcChannels.ProfileUpdated, listener)
      return () => ipcRenderer.removeListener(IpcChannels.ProfileUpdated, listener)
    },
    onAuthProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, message: string): void =>
        callback(message)
      ipcRenderer.on(IpcChannels.ProfileAuthProgress, listener)
      return () => ipcRenderer.removeListener(IpcChannels.ProfileAuthProgress, listener)
    },
    onWorkspaceThemeChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceThemePayload): void =>
        callback(payload)
      ipcRenderer.on(IpcChannels.WorkspaceThemeChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannels.WorkspaceThemeChanged, listener)
    },
    onUnreadCountsChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, counts: UnreadCountsMap): void =>
        callback(counts)
      ipcRenderer.on(IpcChannels.UnreadCountsChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannels.UnreadCountsChanged, listener)
    },
    onDeepLink: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { profileId: string; appId?: AppId; teamId?: string }
      ): void => callback(payload)
      ipcRenderer.on(IpcChannels.ProfileDeepLink, listener)
      return () => ipcRenderer.removeListener(IpcChannels.ProfileDeepLink, listener)
    }
  },
  app: {
    getSettings: () => ipcRenderer.invoke(IpcChannels.AppSettingsGet),
    setSettings: (patch: Partial<AppSettings>) =>
      ipcRenderer.invoke(IpcChannels.AppSettingsSet, patch),
    pushRecent: (entry) => ipcRenderer.invoke(IpcChannels.AppPushRecent, entry),
    lock: () => ipcRenderer.invoke(IpcChannels.AppLock),
    unlock: () => ipcRenderer.invoke(IpcChannels.AppUnlock),
    reportActivity: () => ipcRenderer.invoke(IpcChannels.AppIdleActivity),
    checkUpdates: () => ipcRenderer.invoke(IpcChannels.AppCheckUpdates),
    testNotification: () => ipcRenderer.invoke(IpcChannels.AppTestNotification),
    adminStatus: () => ipcRenderer.invoke(IpcChannels.AppAdminStatus),
    adminLogin: (username, password, remember) =>
      ipcRenderer.invoke(IpcChannels.AppAdminLogin, { username, password, remember }),
    adminLogout: () => ipcRenderer.invoke(IpcChannels.AppAdminLogout),
    onLockStateChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, locked: boolean): void =>
        callback(locked)
      ipcRenderer.on(IpcChannels.AppLockStateChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannels.AppLockStateChanged, listener)
    },
    onToast: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, message: string): void =>
        callback(message)
      ipcRenderer.on(IpcChannels.AppToast, listener)
      return () => ipcRenderer.removeListener(IpcChannels.AppToast, listener)
    },
    onSettingsChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, settings: AppSettings): void =>
        callback(settings)
      ipcRenderer.on(IpcChannels.AppSettingsChanged, listener)
      return () => ipcRenderer.removeListener(IpcChannels.AppSettingsChanged, listener)
    }
  },
  slack: {
    connectWorkspace: (profileId: string) =>
      ipcRenderer.invoke(IpcChannels.OauthStartWorkspaceConnect, { profileId }),
    listWorkspaces: (profileId: string) =>
      ipcRenderer.invoke(IpcChannels.SlackWorkspacesForProfile, { profileId }),
    listChannels: (profileId: string, teamId: string) =>
      ipcRenderer.invoke(IpcChannels.SlackChannelsForWorkspace, { profileId, teamId }),
    listHistory: (profileId: string, teamId: string, channelId: string, limit?: number) =>
      ipcRenderer.invoke(IpcChannels.SlackHistoryForChannel, {
        profileId,
        teamId,
        channelId,
        limit
      })
  }
}

contextBridge.exposeInMainWorld('api', api)
