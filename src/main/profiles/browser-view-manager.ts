import { WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import type { AppId, AvailableWorkspace, DiscoveredWorkspace } from '../../shared/types'
import {
  isSlackPlaceholderName,
  parseSlackClientPath,
  parseSlackTeamDomain,
  parseTeamIdFromSlackClientUrl,
  resolvePinnedOpenUrl,
  slackClientUrlForConversation,
  slackClientUrlForTeam
} from '../../shared/slack-url'
import { log } from '../logging'
import {
  canonicalizeTeamsWorkspaceId,
  DISCOVER_TEAMS_WORKSPACES_SCRIPT,
  DISCOVER_WORKSPACES_SCRIPT,
  isTeamsPersonalTenantId,
  normalizeDiscoveredWorkspaces,
  normalizeTeamsDiscoveredWorkspaces,
  READ_SLACK_CONTEXT_SCRIPT,
  READ_SLACK_WORKSPACE_NAME_SCRIPT,
  READ_TEAMS_ORG_NAME_SCRIPT
} from './discover-workspaces'
import { SAMPLE_SLACK_THEME_SCRIPT } from './theme-sample'
import type { WorkspaceThemePayload } from '../../shared/types'
import {
  applySlackWebContentsTweaks,
  applyTeamsWebContentsTweaks,
  applyWhatsAppWebContentsTweaks,
  homeUrlForApp,
  injectHideDmCss,
  isMicrosoftSignedOutUrl,
  isTeamsSignedInUrl,
  normalizeTeamsOpenUrl,
  partitionForProfile,
  profileSessionWebPreferences,
  SLACK_CLIENT_URL,
  TEAMS_HOME_URL,
  WHATSAPP_WEB_URL
} from './session-partition'
import { parseUnreadFromTitle, READ_PAGE_UNREAD_SCRIPT, unreadKey } from './unread-from-title'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeHostname(urlString: string): string {
  try {
    return new URL(urlString).hostname
  } catch {
    return ''
  }
}

export function viewKey(profileId: string, appId: AppId): string {
  return `${profileId}:${appId}`
}

export type WorkspaceSeenHandler = (
  profileId: string,
  appId: AppId,
  workspace: {
    teamId: string
    teamName: string
    openUrl: string
    teamDomain?: string
    lastChannelName?: string
  }
) => void | Promise<void>

/**
 * One WebContentsView per profile+app. Switching attaches/detaches — never reloads.
 */
export class BrowserViewManager {
  private readonly views = new Map<string, WebContentsView>()
  private activeKey: string | null = null
  private secondaryKey: string | null = null
  private lastBounds: Rectangle | null = null
  private secondaryBounds: Rectangle | null = null
  private embedHidden = false
  private workspaceSeenHandler: WorkspaceSeenHandler | null = null
  private themeHandler: ((payload: WorkspaceThemePayload) => void) | null = null
  private unreadHandler: ((counts: Record<string, number>) => void) | null = null
  private readonly unreadCounts = new Map<string, number>()
  private readonly captureWired = new Set<string>()
  private readonly unreadWired = new Set<string>()
  private unreadPollTimer: ReturnType<typeof setInterval> | null = null
  private unreadEmitTimer: ReturnType<typeof setTimeout> | null = null
  private activityHandler: (() => void) | null = null
  private readonly captureDebounce = new Map<string, ReturnType<typeof setTimeout>>()
  private themeSampleTimer: ReturnType<typeof setTimeout> | null = null
  private lastEmittedThemeKey: string | null = null

  setActivityHandler(handler: (() => void) | null): void {
    this.activityHandler = handler
  }

  noteActivity(): void {
    this.activityHandler?.()
  }

  setWorkspaceSeenHandler(handler: WorkspaceSeenHandler | null): void {
    this.workspaceSeenHandler = handler
  }

  setThemeHandler(handler: ((payload: WorkspaceThemePayload) => void) | null): void {
    this.themeHandler = handler
  }

  private unreadPollInFlight = false

  setUnreadHandler(handler: ((counts: Record<string, number>) => void) | null): void {
    this.unreadHandler = handler
    if (handler) {
      void this.pollAllUnread()
      this.emitUnread()
      if (!this.unreadPollTimer) {
        this.unreadPollTimer = setInterval(() => void this.pollAllUnread(), 2_000)
      }
    }
  }

  getUnreadCounts(): Record<string, number> {
    return Object.fromEntries(this.unreadCounts)
  }

  getActiveKey(): string | null {
    return this.activeKey
  }

  getSecondaryKey(): string | null {
    return this.secondaryKey
  }

  private emitUnread(): void {
    this.unreadHandler?.(this.getUnreadCounts())
  }

  private scheduleEmitUnread(): void {
    if (this.unreadEmitTimer) return
    this.unreadEmitTimer = setTimeout(() => {
      this.unreadEmitTimer = null
      this.emitUnread()
    }, 120)
  }

  private setUnread(profileId: string, appId: AppId, count: number, emit = true): boolean {
    const key = unreadKey(profileId, appId)
    const prev = this.unreadCounts.get(key) ?? 0
    const next = Math.max(0, count)
    if (prev === next) return false
    this.unreadCounts.set(key, next)
    if (emit) this.scheduleEmitUnread()
    return true
  }

  private async pollAllUnread(): Promise<void> {
    if (this.unreadPollInFlight) return
    this.unreadPollInFlight = true
    let changed = false
    try {
      for (const [key, view] of this.views) {
        if (view.webContents.isDestroyed()) continue
        const sep = key.lastIndexOf(':')
        if (sep < 0) continue
        const profileId = key.slice(0, sep)
        const appId = key.slice(sep + 1) as AppId
        if (!profileId || !appId) continue
        try {
          const title = view.webContents.getTitle()
          let count = parseUnreadFromTitle(title, appId)
          try {
            const fromPage = (await view.webContents.executeJavaScript(
              READ_PAGE_UNREAD_SCRIPT,
              true
            )) as unknown
            // -1 = channel sidebar not in DOM yet — keep title. Otherwise page is source of truth
            // so Slack's Activity/workspace "3" in the tab title cannot stick as unread.
            if (typeof fromPage === 'number' && fromPage >= 0) {
              count = fromPage
            }
          } catch {
            /* page may not be ready */
          }
          if (this.setUnread(profileId, appId, count, false)) {
            changed = true
          }
        } catch {
          /* ignore */
        }
      }
      if (changed) this.emitUnread()
    } finally {
      this.unreadPollInFlight = false
    }
  }

  private wireUnread(profileId: string, appId: AppId, view: WebContentsView): void {
    const key = viewKey(profileId, appId)
    if (this.unreadWired.has(key)) return
    this.unreadWired.add(key)
    const apply = (): void => {
      if (view.webContents.isDestroyed()) return
      void this.pollAllUnread()
    }
    view.webContents.on('page-title-updated', apply)
    view.webContents.on('did-finish-load', apply)
    view.webContents.on('dom-ready', apply)
    apply()
  }

  /**
   * Debounced Slack theme sample — runs at most once per activate burst.
   * Skips IPC when colors/mode are unchanged.
   */
  sampleAndEmitSlackTheme(profileId: string, teamId?: string): void {
    if (this.themeSampleTimer) {
      clearTimeout(this.themeSampleTimer)
      this.themeSampleTimer = null
    }
    this.themeSampleTimer = setTimeout(() => {
      this.themeSampleTimer = null
      void this.runSlackThemeSample(profileId, teamId)
    }, 450)
  }

  private async runSlackThemeSample(profileId: string, teamId?: string): Promise<void> {
    if (!this.themeHandler) return
    const view = this.views.get(viewKey(profileId, 'slack'))
    if (!view || view.webContents.isDestroyed()) return
    // Only sample when this Slack view is the active embed.
    if (this.activeKey !== viewKey(profileId, 'slack')) return

    try {
      const raw = (await view.webContents.executeJavaScript(SAMPLE_SLACK_THEME_SCRIPT, true)) as {
        accent?: string
        sidebar?: string
        mode?: string
      }
      const accentRaw =
        typeof raw?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent)
          ? raw.accent
          : '#7a6b8a'
      const sidebarRaw =
        typeof raw?.sidebar === 'string' && /^#[0-9a-f]{6}$/i.test(raw.sidebar)
          ? raw.sidebar
          : '#1a1820'
      const mode: 'light' | 'dark' = raw?.mode === 'light' ? 'light' : 'dark'

      const hexLum = (hex: string): number => {
        const r = Number.parseInt(hex.slice(1, 3), 16) / 255
        const g = Number.parseInt(hex.slice(3, 5), 16) / 255
        const b = Number.parseInt(hex.slice(5, 7), 16) / 255
        const f = (c: number): number =>
          c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      // Drop white / near-white leaks from Slack's main pane.
      const accent = hexLum(accentRaw) > 0.72 ? '#7a6b8a' : accentRaw
      const sidebar =
        hexLum(sidebarRaw) > 0.72 ? (mode === 'light' ? '#ebe6ef' : '#1a1820') : sidebarRaw
      const key = `${profileId}|${teamId ?? ''}|${accent}|${sidebar}|${mode}`
      if (key === this.lastEmittedThemeKey) return
      this.lastEmittedThemeKey = key
      this.themeHandler({
        profileId,
        appId: 'slack',
        teamId,
        accent,
        sidebar,
        mode
      })
      log.info('slack theme sampled', { profileId, teamId, accent, sidebar, mode })
    } catch (err) {
      log.warn('slack theme sample failed', { profileId, err: String(err) })
    }
  }

  emitDefaultTheme(profileId: string, appId: AppId | 'default' = 'default'): void {
    const payload: WorkspaceThemePayload =
      appId === 'teams'
        ? {
            profileId,
            appId,
            accent: '#6264a7',
            sidebar: '#1b1f3b',
            mode: 'dark'
          }
        : appId === 'whatsapp'
          ? {
              profileId,
              appId,
              accent: '#25d366',
              sidebar: '#111b21',
              mode: 'dark'
            }
          : appId === 'slack'
            ? {
                profileId,
                appId,
                accent: '#7a6b8a',
                sidebar: '#1a1820',
                mode: 'dark'
              }
            : {
                profileId,
                appId: 'default',
                accent: '#2bac76',
                sidebar: '#141a24'
              }
    const key = `${payload.appId}|${payload.accent}|${payload.sidebar}|${payload.mode ?? ''}`
    if (key === this.lastEmittedThemeKey) return
    this.lastEmittedThemeKey = key
    this.themeHandler?.(payload)
  }

  static partitionFor(profileId: string, appId: AppId = 'slack'): string {
    return partitionForProfile(profileId, appId)
  }

  static clientUrl(): string {
    return SLACK_CLIENT_URL
  }

  static teamsHomeUrl(): string {
    return TEAMS_HOME_URL
  }

  static whatsappWebUrl(): string {
    return WHATSAPP_WEB_URL
  }

  static workspaceClientUrl(teamId: string): string {
    return slackClientUrlForTeam(teamId)
  }

  getOrCreate(profileId: string, appId: AppId, options?: { deferLoad?: boolean }): WebContentsView {
    const key = viewKey(profileId, appId)
    const existing = this.views.get(key)
    if (existing) {
      return existing
    }

    const view = new WebContentsView({
      webPreferences: profileSessionWebPreferences(profileId, appId)
    })

    view.webContents.setZoomFactor(1)

    if (appId === 'teams') {
      applyTeamsWebContentsTweaks(view.webContents)
    } else if (appId === 'whatsapp') {
      applyWhatsAppWebContentsTweaks(view.webContents)
    } else {
      applySlackWebContentsTweaks(view.webContents)
    }

    view.webContents.on('dom-ready', () => {
      if (appId === 'slack') {
        injectHideDmCss(view.webContents)
        // Title updates are handled via Electron page-title-updated — no in-page poll.
      }
    })

    this.wirePassiveCapture(profileId, appId, view)
    this.wireUnread(profileId, appId, view)

    if (!options?.deferLoad) {
      void view.webContents.loadURL(homeUrlForApp(appId))
    }
    this.views.set(key, view)
    log.info('browser view created', {
      profileId,
      appId,
      partition: partitionForProfile(profileId, appId),
      deferLoad: Boolean(options?.deferLoad)
    })
    return view
  }

  async navigateToWorkspace(
    profileId: string,
    appId: AppId,
    input: { teamId: string; openUrl?: string; teamDomain?: string; teamName?: string }
  ): Promise<string> {
    const view = this.getOrCreate(profileId, appId)
    const url =
      appId === 'slack'
        ? resolvePinnedOpenUrl(input)
        : normalizeTeamsOpenUrl(input.openUrl?.trim() || TEAMS_HOME_URL)

    await view.webContents.loadURL(url)

    if (appId === 'slack') {
      const landedTeamId = await this.waitForSlackTeamId(profileId, 15_000)
      if (!landedTeamId) {
        const label = input.teamName?.trim() || input.teamId
        throw new Error(
          `Slack did not open "${label}". Sync workspaces, or open it with Slack’s Open button first.`
        )
      }
      await this.emitWorkspaceSeen(profileId, appId)
      void this.sampleAndEmitSlackTheme(profileId, landedTeamId)
      return landedTeamId
    }

    const ok = await this.waitForTeamsLoggedIn(profileId, 15_000)
    if (!ok) {
      const label = input.teamName?.trim() || input.teamId
      throw new Error(
        `Teams did not open "${label}". Sign in to Teams first, then Sync workspaces.`
      )
    }
    await this.emitWorkspaceSeen(profileId, appId)
    this.emitDefaultTheme(profileId, 'teams')
    return input.teamId
  }

  async waitForSlackTeamId(profileId: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const teamId = this.getCurrentTeamId(profileId, 'slack')
      if (teamId) {
        return teamId
      }
      await sleep(250)
    }
    return this.getCurrentTeamId(profileId, 'slack')
  }

  async waitForTeamsLoggedIn(profileId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const url = this.getCurrentUrl(profileId, 'teams')
      if (url && isTeamsSignedInUrl(url)) {
        return true
      }
      await sleep(250)
    }
    const url = this.getCurrentUrl(profileId, 'teams')
    return Boolean(url && isTeamsSignedInUrl(url))
  }

  /** After Microsoft login in the same partition, force embed back onto Teams app. */
  async ensureTeamsAppLoaded(profileId: string): Promise<void> {
    const view = this.getOrCreate(profileId, 'teams')
    if (view.webContents.isDestroyed()) {
      return
    }
    const url = view.webContents.getURL()
    if (!url || isMicrosoftSignedOutUrl(url) || !isTeamsSignedInUrl(url)) {
      log.info('reloading Teams embed after auth', { profileId, from: url?.slice(0, 120) })
      await view.webContents.loadURL(TEAMS_HOME_URL)
    }
  }

  async discoverWorkspaces(profileId: string, appId: AppId): Promise<DiscoveredWorkspace[]> {
    const view = this.views.get(viewKey(profileId, appId)) ?? this.getOrCreate(profileId, appId)
    if (view.webContents.isDestroyed()) {
      return []
    }
    try {
      const script =
        appId === 'teams' ? DISCOVER_TEAMS_WORKSPACES_SCRIPT : DISCOVER_WORKSPACES_SCRIPT
      const raw = await view.webContents.executeJavaScript(script, true)
      return appId === 'teams'
        ? normalizeTeamsDiscoveredWorkspaces(raw)
        : normalizeDiscoveredWorkspaces(raw)
    } catch (err) {
      log.warn('discover workspaces failed', { profileId, appId, err: String(err) })
      return []
    }
  }

  async syncWorkspaces(profileId: string, appId: AppId): Promise<AvailableWorkspace[]> {
    if (appId === 'whatsapp') {
      return []
    }
    const view = this.getOrCreate(profileId, appId)
    let candidates = await this.discoverWorkspaces(profileId, appId)

    if (candidates.length === 0) {
      try {
        await view.webContents.loadURL(homeUrlForApp(appId))
        await sleep(2000)
        candidates = await this.discoverWorkspaces(profileId, appId)
      } catch (err) {
        log.warn('sync bootstrap navigation failed', { profileId, appId, err: String(err) })
      }
    }

    const now = new Date().toISOString()
    const collected: AvailableWorkspace[] = []
    const seen = new Set<string>()

    for (const candidate of candidates) {
      try {
        let teamId = candidate.teamId
        let teamName = candidate.teamName
        const teamDomain = candidate.teamDomain
        let openUrl = candidate.openUrl

        if (appId === 'slack') {
          if (!teamId) {
            teamId = await this.navigateToWorkspace(profileId, appId, {
              teamId: teamDomain ? `domain:${teamDomain}` : 'pending',
              openUrl: candidate.openUrl,
              teamDomain,
              teamName: candidate.teamName
            })
            teamName = (await this.readPageTitle(profileId, appId)) || candidate.teamName || teamId
            const landed = this.getCurrentUrl(profileId, appId)
            const loc = landed ? parseSlackClientPath(landed) : null
            openUrl = slackClientUrlForConversation(teamId, loc?.conversationId)
          } else {
            const loc = parseSlackClientPath(candidate.openUrl || '')
            openUrl = slackClientUrlForConversation(teamId, loc?.conversationId)
          }
        } else {
          // Teams: only real tenants or a single personal home session — never hash random URLs.
          if (!teamId || (/^teams-/i.test(teamId) && teamId !== 'teams-home')) {
            continue
          }
          openUrl = normalizeTeamsOpenUrl(candidate.openUrl || TEAMS_HOME_URL)
          if (teamId === 'teams-home') {
            openUrl = TEAMS_HOME_URL
            const readName = await this.readPageTitle(profileId, appId)
            teamName =
              (readName && !/^microsoft teams$/i.test(readName) ? readName : null) ||
              (candidate.teamName && !/^microsoft teams$/i.test(candidate.teamName)
                ? candidate.teamName
                : null) ||
              'Personal'
          } else {
            try {
              await this.navigateToWorkspace(profileId, appId, {
                teamId,
                openUrl,
                teamName: candidate.teamName
              })
              const readName = await this.readPageTitle(profileId, appId)
              teamName =
                (readName && !/^microsoft teams$/i.test(readName) ? readName : null) ||
                (candidate.teamName && !/^microsoft teams$/i.test(candidate.teamName)
                  ? candidate.teamName
                  : null) ||
                `Org ${teamId.replace(/^tenant-/i, '').slice(0, 8)}`
              openUrl = this.getCurrentUrl(profileId, appId) || openUrl
            } catch {
              openUrl = candidate.openUrl || TEAMS_HOME_URL
              teamName =
                candidate.teamName && !/^microsoft teams$/i.test(candidate.teamName)
                  ? candidate.teamName
                  : `Org ${String(teamId)
                      .replace(/^tenant-/i, '')
                      .slice(0, 8)}`
            }
          }
        }

        if (!teamId || seen.has(teamId)) {
          continue
        }
        seen.add(teamId)
        collected.push({
          teamId,
          teamName: teamName || teamId,
          openUrl,
          lastSeenAt: now,
          ...(teamDomain ? { teamDomain } : {})
        })
      } catch (err) {
        log.warn('sync candidate failed', {
          profileId,
          appId,
          candidate: candidate.openUrl,
          err: String(err)
        })
      }
    }

    log.info('workspace sync finished', { profileId, appId, count: collected.length })
    return collected.map((ws) => {
      // Prefer human names over bare ids when we already have a better label elsewhere
      if (appId === 'slack' && ws.teamName === ws.teamId && ws.teamDomain) {
        return { ...ws, teamName: ws.teamDomain }
      }
      return ws
    })
  }

  async readSlackContext(
    profileId: string
  ): Promise<{ workspaceName: string | null; channelName: string | null }> {
    const view = this.views.get(viewKey(profileId, 'slack'))
    if (!view || view.webContents.isDestroyed()) {
      return { workspaceName: null, channelName: null }
    }
    try {
      const raw = (await view.webContents.executeJavaScript(READ_SLACK_CONTEXT_SCRIPT, true)) as {
        workspaceName?: unknown
        channelName?: unknown
      }
      const workspaceName =
        typeof raw?.workspaceName === 'string' && raw.workspaceName.trim()
          ? raw.workspaceName.trim()
          : null
      const channelName =
        typeof raw?.channelName === 'string' && raw.channelName.trim()
          ? raw.channelName.trim()
          : null
      return { workspaceName, channelName }
    } catch {
      return { workspaceName: null, channelName: null }
    }
  }

  async readPageTitle(profileId: string, appId: AppId): Promise<string | null> {
    const view = this.views.get(viewKey(profileId, appId))
    if (!view || view.webContents.isDestroyed()) {
      return null
    }
    try {
      const script =
        appId === 'teams' ? READ_TEAMS_ORG_NAME_SCRIPT : READ_SLACK_WORKSPACE_NAME_SCRIPT
      const name = await view.webContents.executeJavaScript(script, true)
      if (typeof name === 'string' && name.trim()) {
        return name.trim()
      }
      const title = await view.webContents.executeJavaScript(
        `document.title.replace(/\\s*[—–-|]\\s*(Slack|Microsoft Teams|Teams)\\s*$/i, '').trim()`,
        true
      )
      return typeof title === 'string' && title.trim() ? title.trim() : null
    } catch {
      return null
    }
  }

  getCurrentTeamId(profileId: string, appId: AppId): string | null {
    const url = this.getCurrentUrl(profileId, appId)
    if (!url) {
      return null
    }
    if (appId === 'slack') {
      return parseTeamIdFromSlackClientUrl(url)
    }
    try {
      const u = new URL(url)
      if (u.hostname.toLowerCase().includes('teams.live.com')) {
        return 'teams-home'
      }
      const tenant = u.searchParams.get('tenantId') || u.searchParams.get('tenant')
      if (tenant && /^[0-9a-f-]{8,}$/i.test(tenant)) {
        const id = `tenant-${tenant.toLowerCase()}`
        return isTeamsPersonalTenantId(id) ? 'teams-home' : id
      }
    } catch {
      /* ignore */
    }
    return 'teams-home'
  }

  getCurrentUrl(profileId: string, appId: AppId): string | null {
    const view = this.views.get(viewKey(profileId, appId))
    if (!view || view.webContents.isDestroyed()) {
      return null
    }
    return view.webContents.getURL()
  }

  /** Used by embed-first WhatsApp / Google / Slack pane login to poll the live view. */
  getWebContents(
    profileId: string,
    appId: AppId,
    options?: { deferLoad?: boolean }
  ): import('electron').WebContents | null {
    const view =
      this.views.get(viewKey(profileId, appId)) ?? this.getOrCreate(profileId, appId, options)
    if (view.webContents.isDestroyed()) {
      return null
    }
    return view.webContents
  }

  private async emitWorkspaceSeen(profileId: string, appId: AppId): Promise<void> {
    if (!this.workspaceSeenHandler) {
      return
    }
    if (appId === 'whatsapp') {
      return
    }
    const url = this.getCurrentUrl(profileId, appId)
    if (!url) {
      return
    }

    if (appId === 'slack') {
      const loc = parseSlackClientPath(url)
      const teamId = loc?.teamId
      if (!teamId) {
        return
      }
      const context = await this.readSlackContext(profileId)
      const title = context.workspaceName || (await this.readPageTitle(profileId, appId))
      const teamDomain = parseSlackTeamDomain(url) ?? undefined
      const looksLikeId = isSlackPlaceholderName(title)
      const teamName =
        (title && !looksLikeId ? title : null) || teamDomain || context.workspaceName || teamId
      const openUrl = slackClientUrlForConversation(teamId, loc.conversationId)
      await this.workspaceSeenHandler(profileId, appId, {
        teamId,
        teamName,
        openUrl,
        teamDomain,
        ...(context.channelName ? { lastChannelName: context.channelName } : {})
      })
      return
    }

    if (!isTeamsSignedInUrl(url)) {
      return
    }
    const title = await this.readPageTitle(profileId, appId)
    const rawTeamId = this.getCurrentTeamId(profileId, appId) || 'teams-home'
    // Personal / consumer directory → single stable home row (never a parallel tenant clone).
    const teamId = canonicalizeTeamsWorkspaceId(rawTeamId)
    const genericTitle =
      !title || /^(microsoft teams|teams|chat|teams org|organization|personal)$/i.test(title)
    const teamName =
      teamId === 'teams-home'
        ? 'Personal'
        : !genericTitle
          ? title
          : `Org ${teamId.replace(/^tenant-/i, '').slice(0, 8)}`
    await this.workspaceSeenHandler(profileId, appId, {
      teamId,
      teamName,
      openUrl: teamId === 'teams-home' ? TEAMS_HOME_URL : url.split('#')[0] || TEAMS_HOME_URL
    })
  }

  private wireEmbedNavigation(profileId: string, appId: AppId, view: WebContentsView): void {
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('msteams:')) {
        log.info('embed blocked msteams protocol; using Teams web', { profileId, appId })
        void view.webContents.loadURL(TEAMS_HOME_URL)
        return { action: 'deny' }
      }

      const host = safeHostname(url)
      const keepInEmbed =
        /(?:^|\.)slack\.com$/i.test(host) ||
        /(?:^|\.)google\.com$/i.test(host) ||
        /(?:^|\.)googleusercontent\.com$/i.test(host) ||
        /(?:^|\.)microsoft\.com$/i.test(host) ||
        /(?:^|\.)microsoftonline\.com$/i.test(host) ||
        /(?:^|\.)live\.com$/i.test(host) ||
        /(?:^|\.)office\.com$/i.test(host) ||
        /(?:^|\.)office365\.com$/i.test(host) ||
        /(?:^|\.)whatsapp\.com$/i.test(host) ||
        /(?:^|\.)wa\.me$/i.test(host) ||
        /(?:^|\.)facebook\.com$/i.test(host)

      if (keepInEmbed) {
        const target = appId === 'teams' ? normalizeTeamsOpenUrl(url) : url
        log.info('embed popup redirected in-place', { profileId, appId, url: target })
        void view.webContents.loadURL(target)
      } else {
        log.info('embed popup blocked', { profileId, appId, url })
      }
      return { action: 'deny' }
    })
  }

  private wirePassiveCapture(profileId: string, appId: AppId, view: WebContentsView): void {
    const key = viewKey(profileId, appId)
    if (this.captureWired.has(key)) {
      return
    }
    this.captureWired.add(key)
    this.wireEmbedNavigation(profileId, appId, view)

    const maybeCapture = (): void => {
      const prev = this.captureDebounce.get(key)
      if (prev) clearTimeout(prev)
      this.captureDebounce.set(
        key,
        setTimeout(() => {
          this.captureDebounce.delete(key)
          void this.emitWorkspaceSeen(profileId, appId)
        }, 900)
      )
    }
    view.webContents.on('did-navigate', maybeCapture)
    view.webContents.on('did-navigate-in-page', maybeCapture)
    view.webContents.on('did-finish-load', maybeCapture)
  }

  activate(
    profileId: string,
    appId: AppId,
    mainWindow: BrowserWindow,
    bounds: Rectangle,
    options?: { deferLoad?: boolean }
  ): void {
    const next = this.getOrCreate(profileId, appId, options)
    const key = viewKey(profileId, appId)
    this.lastBounds = bounds

    if (this.activeKey && this.activeKey !== key) {
      const prev = this.views.get(this.activeKey)
      if (prev) {
        mainWindow.contentView.removeChildView(prev)
      }
      this.lastEmittedThemeKey = null
    }

    this.activeKey = key

    if (this.embedHidden) {
      log.info('browser view activated (hidden for overlay)', { profileId, appId })
      return
    }

    if (!mainWindow.contentView.children.includes(next)) {
      mainWindow.contentView.addChildView(next)
    }
    next.setBounds(bounds)
    if (appId === 'teams') {
      void this.ensureTeamsAppLoaded(profileId)
    }
    this.noteActivity()
    log.info('browser view activated', { profileId, appId })
  }

  activateSecondary(
    profileId: string,
    appId: AppId,
    mainWindow: BrowserWindow,
    bounds: Rectangle
  ): void {
    const next = this.getOrCreate(profileId, appId)
    const key = viewKey(profileId, appId)
    this.secondaryBounds = bounds
    if (this.secondaryKey && this.secondaryKey !== key && this.secondaryKey !== this.activeKey) {
      const prev = this.views.get(this.secondaryKey)
      if (prev) {
        mainWindow.contentView.removeChildView(prev)
      }
    }
    this.secondaryKey = key
    if (this.embedHidden) return
    if (this.activeKey === key) {
      // Same as primary — just update bounds later via updateSplitBounds
      return
    }
    if (!mainWindow.contentView.children.includes(next)) {
      mainWindow.contentView.addChildView(next)
    }
    next.setBounds(bounds)
    this.noteActivity()
  }

  clearSecondary(mainWindow: BrowserWindow): void {
    if (!this.secondaryKey) return
    if (this.secondaryKey !== this.activeKey) {
      const view = this.views.get(this.secondaryKey)
      if (view) {
        mainWindow.contentView.removeChildView(view)
      }
    }
    this.secondaryKey = null
    this.secondaryBounds = null
  }

  updateSplitBounds(
    mainWindow: BrowserWindow,
    primary: Rectangle,
    secondary: Rectangle | null
  ): void {
    this.lastBounds = primary
    this.secondaryBounds = secondary
    if (this.embedHidden) return
    if (this.activeKey) {
      const view = this.views.get(this.activeKey)
      if (view) {
        if (!mainWindow.contentView.children.includes(view)) {
          mainWindow.contentView.addChildView(view)
        }
        view.setBounds(primary)
      }
    }
    if (secondary && this.secondaryKey && this.secondaryKey !== this.activeKey) {
      const view = this.views.get(this.secondaryKey)
      if (view) {
        if (!mainWindow.contentView.children.includes(view)) {
          mainWindow.contentView.addChildView(view)
        }
        view.setBounds(secondary)
      }
    }
  }

  /**
   * Tear down inactive embeds to save RAM. Caller must ensure Chrome auth is not active.
   */
  destroyInactiveExcept(keepKeys: string[], mainWindow?: BrowserWindow): number {
    const keep = new Set(keepKeys.filter(Boolean))
    let removed = 0
    for (const key of [...this.views.keys()]) {
      if (keep.has(key)) continue
      const view = this.views.get(key)
      if (!view) continue
      if (mainWindow) {
        try {
          mainWindow.contentView.removeChildView(view)
        } catch {
          /* ignore */
        }
      }
      if (!view.webContents.isDestroyed()) {
        view.webContents.close()
      }
      this.views.delete(key)
      this.captureWired.delete(key)
      this.unreadWired.delete(key)
      if (this.activeKey === key) this.activeKey = null
      if (this.secondaryKey === key) this.secondaryKey = null
      removed += 1
    }
    if (removed > 0) {
      log.info('destroyed inactive embeds', { removed, kept: [...keep] })
    }
    return removed
  }

  /** Detach any active embed without changing selection. */
  deactivate(mainWindow: BrowserWindow): void {
    if (!this.activeKey) {
      return
    }
    const view = this.views.get(this.activeKey)
    if (view) {
      mainWindow.contentView.removeChildView(view)
    }
    this.activeKey = null
  }

  updateBounds(mainWindow: BrowserWindow, bounds: Rectangle): void {
    this.lastBounds = bounds
    if (!this.activeKey || this.embedHidden) {
      return
    }
    const view = this.views.get(this.activeKey)
    if (!view) {
      return
    }
    if (!mainWindow.contentView.children.includes(view)) {
      mainWindow.contentView.addChildView(view)
    }
    view.setBounds(bounds)
  }

  setEmbedVisible(mainWindow: BrowserWindow, visible: boolean): void {
    if (visible) {
      this.embedHidden = false
      if (this.activeKey) {
        const view = this.views.get(this.activeKey)
        if (view) {
          if (!mainWindow.contentView.children.includes(view)) {
            mainWindow.contentView.addChildView(view)
          }
          if (this.lastBounds) view.setBounds(this.lastBounds)
        }
      }
      if (this.secondaryKey && this.secondaryKey !== this.activeKey) {
        const view = this.views.get(this.secondaryKey)
        if (view) {
          if (!mainWindow.contentView.children.includes(view)) {
            mainWindow.contentView.addChildView(view)
          }
          if (this.secondaryBounds) view.setBounds(this.secondaryBounds)
        }
      }
      return
    }

    this.embedHidden = true
    for (const key of [this.activeKey, this.secondaryKey]) {
      if (!key) continue
      const view = this.views.get(key)
      if (view) {
        mainWindow.contentView.removeChildView(view)
      }
    }
  }

  setAllZoomFactor(factor: number): void {
    const z = Math.min(2, Math.max(0.5, factor))
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.setZoomFactor(z)
      }
    }
  }

  destroy(profileId: string, mainWindow?: BrowserWindow): void {
    for (const appId of ['slack', 'teams', 'whatsapp'] as AppId[]) {
      const key = viewKey(profileId, appId)
      const view = this.views.get(key)
      if (!view) {
        continue
      }
      if (mainWindow && this.activeKey === key) {
        mainWindow.contentView.removeChildView(view)
        this.activeKey = null
      }
      if (!view.webContents.isDestroyed()) {
        view.webContents.close()
      }
      this.views.delete(key)
      this.captureWired.delete(key)
      this.unreadWired.delete(key)
      this.unreadCounts.delete(key)
    }
    if (this.secondaryKey?.startsWith(`${profileId}:`)) {
      this.secondaryKey = null
    }
    log.info('browser views destroyed for profile', { profileId })
  }

  destroyAll(mainWindow?: BrowserWindow): void {
    const profileIds = new Set(
      [...this.views.keys()].map((k) => k.split(':')[0]).filter(Boolean) as string[]
    )
    for (const profileId of profileIds) {
      this.destroy(profileId, mainWindow)
    }
  }
}
