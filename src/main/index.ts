import { app, BrowserWindow, nativeImage, session, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import dockIcon from '../../resources/dockIcon.png?asset'
import trayIcon from '../../resources/trayIcon.png?asset'
import { APP_BUNDLE_ID, APP_DISPLAY_NAME } from '../shared/brand'
import { IpcChannels } from '../shared/ipc-contract'
import { AdminAuthController, defaultAdminSessionPath } from './admin-auth'
import { AppLockController, notifyUnreadIncrease } from './app-lock'
import { AppSettingsStore, defaultAppSettingsPath } from './app-settings'
import { registerAppIpc } from './ipc/app.ipc'
import { registerOauthIpc } from './ipc/oauth.ipc'
import { registerProfileIpc } from './ipc/profiles.ipc'
import { registerSlackDataIpc } from './ipc/slack-data.ipc'
import { loadAppEnv } from './load-app-env'
import { log } from './logging'
import { getChromeStayEmbed, getPendingChromeBrowserAuth } from './profiles/chrome-browser-auth'
import { BrowserViewManager } from './profiles/browser-view-manager'
import { defaultProfileStorePath, ProfileStore } from './profiles/profile-store'
import { CHROME_USER_AGENT } from './profiles/session-partition'
import { splitUnreadKey, sumUnread } from './profiles/unread-from-title'
import { createAppTray } from './tray'
import { defaultTokenStorePath, TokenStore } from './slack/token-store'
import { APP_IDS, appLabel, profileDisplayLabel, type AppId } from '../shared/types'

const loadedEnvPath = loadAppEnv()
if (loadedEnvPath) {
  // Logging module is safe here; avoids printing secret values.
  log.info('loaded env file', { path: loadedEnvPath })
} else {
  log.warn('no .env found — admin login will be unconfigured until you add one')
}

/** One process / one tray — second launches focus the existing window. */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('slack-dashboard', process.execPath, [join(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient('slack-dashboard')
  }

  app.userAgentFallback = CHROME_USER_AGENT

  let mainWindow: BrowserWindow | null = null
  const browserViewManager = new BrowserViewManager()
  let lastUnread: Record<string, number> = {}
  const pendingUnreadNotices = new Map<string, number>()
  let unreadNoticeTimer: ReturnType<typeof setTimeout> | null = null
  let lastEmbedActivity = Date.now()
  let sleepTimer: ReturnType<typeof setInterval> | null = null

  function getOauthConfig(): { clientId: string; clientSecret: string; redirectUri?: string } {
    return {
      clientId: process.env.SLACK_CLIENT_ID ?? '',
      clientSecret: process.env.SLACK_CLIENT_SECRET ?? '',
      redirectUri: process.env.SLACK_REDIRECT_URI
    }
  }

  function applyChromeUserAgent(contents: Electron.WebContents): void {
    contents.setUserAgent(CHROME_USER_AGENT)
  }

  function sendToast(message: string): void {
    const win = mainWindow
    if (win && !win.isDestroyed()) {
      win.webContents.send(IpcChannels.AppToast, message)
    }
  }

  function focusMainWindow(): void {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  function handleDeepLink(url: string): void {
    try {
      const u = new URL(url)
      if (u.protocol !== 'slack-dashboard:') return
      const profileId = u.hostname || u.pathname.replace(/^\//, '')
      if (!profileId) return
      const appId = (u.searchParams.get('app') as AppId | null) ?? undefined
      const teamId = u.searchParams.get('team') ?? undefined
      focusMainWindow()
      const win = mainWindow
      if (win && !win.isDestroyed()) {
        win.webContents.send(IpcChannels.ProfileDeepLink, { profileId, appId, teamId })
      }
    } catch (err) {
      log.warn('deep link parse failed', { url, err: String(err) })
    }
  }

  function deepLinkFromArgv(argv: string[]): string | undefined {
    return argv.find((a) => a.startsWith('slack-dashboard://'))
  }

  app.on('second-instance', (_event, argv) => {
    focusMainWindow()
    const url = deepLinkFromArgv(argv)
    if (url) handleDeepLink(url)
  })

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      autoHideMenuBar: true,
      title: APP_DISPLAY_NAME,
      backgroundColor: '#100e16',
      icon,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    applyChromeUserAgent(mainWindow.webContents)
    // Undo accidental ⌘+/trackpad zoom from prior sessions.
    mainWindow.webContents.setZoomFactor(1)

    mainWindow.on('ready-to-show', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.setZoomFactor(1)
      mainWindow.setSize(1280, 800)
      mainWindow.center()
      mainWindow.show()
    })

    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (!(input.control || input.meta) || input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      // ⌘0 / Ctrl+0 — reset zoom to 100%
      if (key === '0' || key === 'numpad0') {
        event.preventDefault()
        mainWindow?.webContents.setZoomFactor(1)
        browserViewManager.setAllZoomFactor(1)
        return
      }
      // ⌘+ / ⌘- — nudge zoom (keeps embeds in sync)
      if (key === '=' || key === '+') {
        event.preventDefault()
        const next = Math.min(2, (mainWindow?.webContents.getZoomFactor() ?? 1) + 0.1)
        mainWindow?.webContents.setZoomFactor(next)
        browserViewManager.setAllZoomFactor(next)
        return
      }
      if (key === '-') {
        event.preventDefault()
        const next = Math.max(0.5, (mainWindow?.webContents.getZoomFactor() ?? 1) - 0.1)
        mainWindow?.webContents.setZoomFactor(next)
        browserViewManager.setAllZoomFactor(next)
      }
    })

    mainWindow.on('closed', () => {
      browserViewManager.destroyAll()
      mainWindow = null
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      void shell.openExternal(details.url)
      return { action: 'deny' }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  app.whenReady().then(() => {
    electronApp.setAppUserModelId(APP_BUNDLE_ID)

    app.userAgentFallback = CHROME_USER_AGENT
    session.defaultSession.setUserAgent(CHROME_USER_AGENT)
    log.info('Chrome user agent applied', { ua: CHROME_USER_AGENT })

    // Dock icon: padded desktop-style squircle (Finder/Desktop still use icon.icns).
    if (process.platform === 'darwin' && app.dock) {
      const dockImg = nativeImage.createFromPath(dockIcon || icon)
      if (!dockImg.isEmpty()) app.dock.setIcon(dockImg)
    }
    app.setName(APP_DISPLAY_NAME)

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
      applyChromeUserAgent(window.webContents)
    })

    const userData = app.getPath('userData')
    const profileStore = new ProfileStore({ filePath: defaultProfileStorePath(userData) })
    const tokenStore = new TokenStore({ filePath: defaultTokenStorePath(userData) })
    const settingsStore = new AppSettingsStore(defaultAppSettingsPath(userData))

    const adminAuth = new AdminAuthController({
      sessionPath: defaultAdminSessionPath(userData)
    })

    const lock = new AppLockController(
      settingsStore,
      () => mainWindow,
      (locked) => {
        const win = mainWindow
        if (win && !win.isDestroyed()) {
          browserViewManager.setEmbedVisible(win, !locked && adminAuth.isAuthenticated())
        }
      }
    )

    registerProfileIpc({
      profileStore,
      browserViewManager,
      tokenStore,
      getMainWindow: () => mainWindow,
      onProfilesRemoved: async (ids) => {
        await settingsStore.removeRecentsForProfiles(ids)
        const win = mainWindow
        if (win && !win.isDestroyed()) {
          const settings = await settingsStore.get()
          win.webContents.send(IpcChannels.AppSettingsChanged, settings)
        }
      }
    })
    registerOauthIpc({
      tokenStore,
      profileStore,
      getOauthConfig
    })
    registerSlackDataIpc({ tokenStore })
    registerAppIpc({
      settingsStore,
      lock,
      adminAuth,
      profileStore,
      onUserActivity: () => {
        lastEmbedActivity = Date.now()
      },
      onAdminSessionChange: (authenticated) => {
        const win = mainWindow
        if (win && !win.isDestroyed()) {
          browserViewManager.setEmbedVisible(win, authenticated && !lock.isLocked())
        }
      }
    })

    const tray = createAppTray({
      iconPath: trayIcon || icon,
      getMainWindow: () => mainWindow,
      onSelectProfile: (profileId) => {
        const win = mainWindow
        if (win && !win.isDestroyed()) {
          win.webContents.send(IpcChannels.ProfileAuthProgress, `open-profile:${profileId}`)
          win.show()
          win.focus()
        }
      },
      onLock: () => {
        void lock.lock()
      }
    })

    browserViewManager.setActivityHandler(() => {
      lastEmbedActivity = Date.now()
    })

    browserViewManager.setUnreadHandler((counts) => {
      const win = mainWindow
      if (win && !win.isDestroyed()) {
        win.webContents.send(IpcChannels.UnreadCountsChanged, counts)
      }
      const increases: Array<{ key: string; next: number }> = []
      for (const [key, next] of Object.entries(counts)) {
        const prev = lastUnread[key] ?? 0
        if (next > prev && next > 0) {
          increases.push({ key, next })
        }
      }
      lastUnread = { ...counts }
      const total = sumUnread(counts)
      void Promise.all([profileStore.list()]).then(([profiles]) => {
        profilesNameMap = new Map(profiles.map((p) => [p.id, profileDisplayLabel(p)]))
        mutedIds = new Set(profiles.filter((p) => p.muted).map((p) => p.id))
        tray.update(profiles, total)
      })

      if (increases.length === 0) return
      for (const { key, next } of increases) {
        pendingUnreadNotices.set(key, next)
      }
      if (unreadNoticeTimer) clearTimeout(unreadNoticeTimer)
      unreadNoticeTimer = setTimeout(() => {
        unreadNoticeTimer = null
        const batch = [...pendingUnreadNotices.entries()]
        pendingUnreadNotices.clear()
        void Promise.all([profileStore.list(), settingsStore.get()]).then(
          ([profiles, settings]) => {
            profilesNameMap = new Map(profiles.map((p) => [p.id, profileDisplayLabel(p)]))
            mutedIds = new Set(profiles.filter((p) => p.muted).map((p) => p.id))
            tray.update(profiles, total)

            if (!settings.notificationsEnabled || batch.length === 0) return

            for (const [key, next] of batch) {
              const parsed = splitUnreadKey(key)
              if (!parsed) continue
              const { profileId, appId } = parsed
              if (!APP_IDS.includes(appId as AppId) || mutedIds.has(profileId)) continue
              const name = profilesNameMap.get(profileId) ?? 'Profile'
              const body = `${appLabel(appId as AppId)} · ${next} unread`

              void notifyUnreadIncrease({
                enabled: true,
                silent: !settings.notificationSound,
                title: APP_DISPLAY_NAME,
                subtitle: name,
                body,
                onClick: () => {
                  if (win && !win.isDestroyed()) {
                    win.show()
                    win.focus()
                    win.webContents.send(
                      IpcChannels.ProfileAuthProgress,
                      `open-app:${profileId}:${appId}`
                    )
                  }
                }
              })
            }
          }
        )
      }, 800)
    })

    let profilesNameMap = new Map<string, string>()
    let mutedIds = new Set<string>()
    void profileStore.list().then((list) => {
      profilesNameMap = new Map(list.map((p) => [p.id, profileDisplayLabel(p)]))
      mutedIds = new Set(list.filter((p) => p.muted).map((p) => p.id))
      tray.update(list, 0)
    })

    void profileStore.list().then(async (before) => {
      const wasStuck = before.some(
        (p) =>
          p.googleAuthStatus === 'signing-in' ||
          Object.values(p.apps).some((a) =>
            ['signing-in', 'signing-in-google', 'signing-in-slack'].includes(a.sessionStatus)
          )
      )
      await profileStore.clearStuckSigningInStatuses()
      log.info('cleared stuck signing-in statuses on launch')
      if (wasStuck) {
        setTimeout(() => {
          sendToast('Previous sign-in was interrupted — statuses were reset.')
        }, 1500)
      }
    })

    sleepTimer = setInterval(() => {
      void (async () => {
        if (getPendingChromeBrowserAuth() || getChromeStayEmbed()) return
        const settings = await settingsStore.get()
        if (!settings.idleSleepMinutes || settings.idleSleepMinutes <= 0) return
        const ms = settings.idleSleepMinutes * 60_000
        if (Date.now() - lastEmbedActivity < ms) return
        const keep = [
          browserViewManager.getActiveKey(),
          browserViewManager.getSecondaryKey()
        ].filter(Boolean) as string[]
        const win = mainWindow
        if (win && !win.isDestroyed()) {
          browserViewManager.destroyInactiveExcept(keep, win)
        }
      })()
    }, 30_000)

    createWindow()
    lock.startIdleWatch()
    log.info('app ready')

    app.on('open-url', (event, url) => {
      event.preventDefault()
      handleDeepLink(url)
    })

    const deepArg = deepLinkFromArgv(process.argv)
    if (deepArg) handleDeepLink(deepArg)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      } else {
        mainWindow?.show()
      }
    })

    app.on('before-quit', () => {
      lock.stopIdleWatch()
      if (sleepTimer) clearInterval(sleepTimer)
      tray.destroy()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
} // end single-instance lock
