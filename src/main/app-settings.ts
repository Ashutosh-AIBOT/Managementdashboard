import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../shared/ipc-contract'

export function defaultAppSettingsPath(userData: string): string {
  return join(userData, 'app-settings.json')
}

function clampInt(n: unknown, fallback: number, min: number, max: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function normalizeAppSettings(parsed: Partial<AppSettings>): AppSettings {
  const theme =
    parsed.theme === 'system' || parsed.theme === 'light' || parsed.theme === 'dark'
      ? parsed.theme
      : DEFAULT_APP_SETTINGS.theme
  const sidebarDensity =
    parsed.sidebarDensity === 'compact' || parsed.sidebarDensity === 'comfortable'
      ? parsed.sidebarDensity
      : DEFAULT_APP_SETTINGS.sidebarDensity
  const recent = Array.isArray(parsed.recentWorkspaces)
    ? parsed.recentWorkspaces
        .filter(
          (r) =>
            r &&
            typeof r.profileId === 'string' &&
            typeof r.appId === 'string' &&
            typeof r.teamId === 'string'
        )
        .slice(0, 5)
        .map((r) => ({
          profileId: r.profileId,
          appId: r.appId,
          teamId: r.teamId,
          label: typeof r.label === 'string' ? r.label : r.teamId,
          at: typeof r.at === 'string' ? r.at : new Date().toISOString()
        }))
    : []

  return {
    notificationsEnabled:
      typeof parsed.notificationsEnabled === 'boolean'
        ? parsed.notificationsEnabled
        : DEFAULT_APP_SETTINGS.notificationsEnabled,
    idleLockMinutes: clampInt(parsed.idleLockMinutes, DEFAULT_APP_SETTINGS.idleLockMinutes, 1, 240),
    theme,
    sidebarDensity,
    sidebarWidth: clampInt(parsed.sidebarWidth, DEFAULT_APP_SETTINGS.sidebarWidth, 220, 520),
    sidebarCollapsed:
      typeof parsed.sidebarCollapsed === 'boolean'
        ? parsed.sidebarCollapsed
        : DEFAULT_APP_SETTINGS.sidebarCollapsed,
    idleSleepMinutes: clampInt(
      parsed.idleSleepMinutes,
      DEFAULT_APP_SETTINGS.idleSleepMinutes,
      0,
      240
    ),
    splitViewEnabled:
      typeof parsed.splitViewEnabled === 'boolean'
        ? parsed.splitViewEnabled
        : DEFAULT_APP_SETTINGS.splitViewEnabled,
    notificationSound:
      typeof parsed.notificationSound === 'boolean'
        ? parsed.notificationSound
        : DEFAULT_APP_SETTINGS.notificationSound,
    recentWorkspaces: recent
  }
}

export class AppSettingsStore {
  private readonly filePath: string
  private writeChain: Promise<void> = Promise.resolve()
  private cache: AppSettings | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async get(): Promise<AppSettings> {
    if (this.cache) {
      return this.cache
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      this.cache = normalizeAppSettings(parsed)
      return this.cache
    } catch {
      this.cache = { ...DEFAULT_APP_SETTINGS, recentWorkspaces: [] }
      return this.cache
    }
  }

  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.get()
    const next = normalizeAppSettings({ ...current, ...patch })
    this.cache = next
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify(next, null, 2), 'utf8')
    })
    await this.writeChain
    return next
  }

  async pushRecent(entry: {
    profileId: string
    appId: string
    teamId: string
    label: string
  }): Promise<AppSettings> {
    const current = await this.get()
    const nextEntry = { ...entry, at: new Date().toISOString() }
    const filtered = current.recentWorkspaces.filter(
      (r) =>
        !(r.profileId === entry.profileId && r.appId === entry.appId && r.teamId === entry.teamId)
    )
    return this.set({
      recentWorkspaces: [nextEntry, ...filtered].slice(0, 5)
    })
  }

  async removeRecentsForProfiles(profileIds: string[]): Promise<AppSettings> {
    const ids = new Set(profileIds.filter(Boolean))
    if (ids.size === 0) return this.get()
    const current = await this.get()
    const next = current.recentWorkspaces.filter((r) => !ids.has(r.profileId))
    if (next.length === current.recentWorkspaces.length) return current
    return this.set({ recentWorkspaces: next })
  }

  async pruneRecents(validProfileIds: Iterable<string>): Promise<AppSettings> {
    const valid = new Set(validProfileIds)
    const current = await this.get()
    const next = current.recentWorkspaces.filter((r) => valid.has(r.profileId))
    if (next.length === current.recentWorkspaces.length) return current
    return this.set({ recentWorkspaces: next })
  }
}
