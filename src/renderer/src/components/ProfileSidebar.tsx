import { memo, useMemo, useState } from 'react'
import { APP_DISPLAY_NAME } from '../../../shared/brand'
import type { AppId, AppSession, AppSessionStatus, Profile } from '../../../shared/types'
import {
  APP_IDS,
  appLabel,
  appSupportsWorkspaces,
  profileDisplayLabel
} from '../../../shared/types'
import { formatUnreadBadge, unreadKey } from '../lib/unread-badge'
import { AppIcon } from './AppIcon'
import { SidebarPanelIcon } from './SidebarPanelIcon'

interface RecentWorkspace {
  profileId: string
  appId: string
  teamId: string
  label: string
  at: string
}

interface ProfileSidebarProps {
  profiles: Profile[]
  activeProfileId: string | null
  activeAppId: AppId | null
  selectedTeamId: string | null
  syncingProfileId: string | null
  email: string
  onEmailChange: (value: string) => void
  googleBusy: boolean
  statusLine: string
  unreadCounts: Record<string, number>
  recentWorkspaces: RecentWorkspace[]
  onAddGoogle: () => void
  onCancelGoogle: () => void
  onToggleSidebar: () => void
  onSelect: (profileId: string) => void
  onSelectApp: (profileId: string, appId: AppId) => void
  onDelete: (profileId: string) => void
  onRename: (profileId: string, name: string) => void
  onToggleMute: (profileId: string, muted: boolean) => void
  onReorder: (orderedIds: string[]) => void
  onOpenInSplit: (profileId: string, appId: AppId) => void
  onOpenWorkspace: (profileId: string, appId: AppId, teamId: string) => void
  onSyncWorkspaces: (profileId: string, appId: AppId) => void
  onPinFromAvailable: (profileId: string, appId: AppId, teamId: string) => void
  onUnpin: (profileId: string, appId: AppId, teamId: string) => void
  onDismissError: () => void
}

function isBusy(status: AppSessionStatus): boolean {
  return status === 'signing-in' || status === 'signing-in-google' || status === 'signing-in-slack'
}

function SignedInTick(): React.JSX.Element {
  return (
    <span className="status-tick" title="Signed in" aria-label="Signed in">
      ✓
    </span>
  )
}

function BusyMark({ label = 'Signing in…' }: { label?: string }): React.JSX.Element {
  return <span className="status-busy" title={label} aria-label={label} />
}

function ProfileAuthMark({
  googleAuthStatus
}: {
  googleAuthStatus: Profile['googleAuthStatus']
}): React.JSX.Element | null {
  if (googleAuthStatus === 'signing-in') {
    return <BusyMark label="Google sign-in in progress…" />
  }
  if (googleAuthStatus === 'signed-in') {
    return <SignedInTick />
  }
  return null
}

function AppStatusMark({ status }: { status: AppSessionStatus }): React.JSX.Element | null {
  if (status === 'signed-in') {
    return <SignedInTick />
  }
  if (isBusy(status)) {
    return <BusyMark />
  }
  return null
}

function displayWorkspaceName(ws: {
  teamName: string
  teamDomain?: string
  teamId: string
  lastChannelName?: string
}): string {
  const name = ws.teamName?.trim()
  const generic =
    !name ||
    /^(microsoft teams|teams|teams org|organization|teams-home)$/i.test(name) ||
    /^tenant-/i.test(name) ||
    /^T[A-Z0-9]+$/i.test(name)

  if (!generic) {
    return name
  }
  if (ws.lastChannelName?.trim()) {
    return ws.lastChannelName.trim()
  }
  if (ws.teamDomain?.trim()) {
    return ws.teamDomain.trim()
  }
  if (ws.teamId === 'teams-home') {
    return 'Personal'
  }
  return name || ws.teamId
}

function workspaceSubtitle(
  ws: { teamName: string; teamDomain?: string; teamId: string; lastChannelName?: string },
  appId: AppId
): string | null {
  const title = displayWorkspaceName(ws)
  const channel = ws.lastChannelName?.trim()
  if (appId === 'slack' && channel && channel !== title) {
    return `#${channel.replace(/^#/, '')}`
  }
  const domain = ws.teamDomain?.trim()
  if (domain && domain !== title) return domain
  if (appId === 'teams') return 'Organization'
  if (appId === 'slack') return 'Workspace'
  return null
}

function monogramFromLabel(label: string): string {
  const cleaned = label.trim()
  if (!cleaned) return '?'
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
  }
  return cleaned.slice(0, 2).toUpperCase()
}

function PinGlyph({ filled }: { filled: boolean }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      {filled ? (
        <path
          fill="currentColor"
          d="M16.5 2h-9A1.5 1.5 0 0 0 6 3.5V5h1.2c1.9 0 3.5 1.3 3.9 3.1l.2 1V12c0 .4-.2.8-.6 1L8 14.7V17h3.2v5h1.6v-5H16v-2.3l-2.7-1.6c-.4-.2-.6-.6-.6-1V9.1l.2-1C13.3 6.3 14.9 5 16.8 5H18V3.5A1.5 1.5 0 0 0 16.5 2z"
        />
      ) : (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 3.5h6M10.2 3.5v6.2c0 1.2-.6 2.3-1.6 3L7.2 14v2.2h4.1V21h1.4v-4.8h4.1V14l-1.4-1.3c-1-.7-1.6-1.8-1.6-3V3.5"
        />
      )}
    </svg>
  )
}

function WorkspaceBranch({
  profileId,
  appId,
  session,
  selectedTeamId,
  onOpenWorkspace,
  onPin,
  onUnpin
}: {
  profileId: string
  appId: AppId
  session: AppSession
  selectedTeamId: string | null
  onOpenWorkspace: (profileId: string, appId: AppId, teamId: string) => void
  onPin: (profileId: string, appId: AppId, teamId: string) => void
  onUnpin: (profileId: string, appId: AppId, teamId: string) => void
}): React.JSX.Element {
  const pinnedIds = useMemo(
    () => new Set(session.pinnedWorkspaces.map((w) => w.teamId)),
    [session.pinnedWorkspaces]
  )

  const workspaces = useMemo(() => {
    const byId = new Map(session.availableWorkspaces.map((w) => [w.teamId, w]))
    const pinnedFirst = session.pinnedWorkspaces.map((p) => byId.get(p.teamId) ?? p).filter(Boolean)
    const rest = session.availableWorkspaces.filter((w) => !pinnedIds.has(w.teamId))
    return [...pinnedFirst, ...rest]
  }, [session.availableWorkspaces, session.pinnedWorkspaces, pinnedIds])

  const sectionTitle = appId === 'teams' ? 'Organizations' : 'Workspaces'

  if (session.sessionStatus !== 'signed-in') {
    return <p className="nav-hint">Sign in to discover {sectionTitle.toLowerCase()}.</p>
  }
  if (workspaces.length === 0) {
    return (
      <p className="nav-hint">
        {appId === 'teams'
          ? 'Open Teams to discover organizations.'
          : 'Open Slack to discover workspaces.'}
      </p>
    )
  }

  return (
    <div className="nav-workspace-block">
      <p className="nav-workspace-heading">{sectionTitle}</p>
      <ul className="nav-workspace-list">
        {workspaces.map((ws) => {
          const pinned = pinnedIds.has(ws.teamId)
          const title = displayWorkspaceName(ws)
          const subtitle = workspaceSubtitle(ws, appId)
          const selected = selectedTeamId === ws.teamId
          return (
            <li
              key={ws.teamId}
              className={`nav-workspace-row${selected ? ' is-selected' : ''}${pinned ? ' is-pinned' : ''}`}
            >
              <button
                type="button"
                className="nav-workspace-open"
                onClick={() => onOpenWorkspace(profileId, appId, ws.teamId)}
              >
                <span className="ws-app-chip" aria-hidden>
                  <AppIcon appId={appId} className="ws-app-icon" size={11} />
                </span>
                <span className="ws-copy">
                  <span className="ws-title">{title}</span>
                  {subtitle ? <span className="ws-sub">{subtitle}</span> : null}
                </span>
              </button>
              <button
                type="button"
                className={`nav-pin${pinned ? ' is-pinned' : ''}`}
                title={pinned ? 'Unpin' : 'Pin to top'}
                aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
                aria-pressed={pinned}
                onClick={(e) => {
                  e.stopPropagation()
                  if (pinned) onUnpin(profileId, appId, ws.teamId)
                  else onPin(profileId, appId, ws.teamId)
                }}
              >
                <PinGlyph filled={pinned} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export const ProfileSidebar = memo(function ProfileSidebar({
  profiles,
  activeProfileId,
  activeAppId,
  selectedTeamId,
  email,
  onEmailChange,
  googleBusy,
  statusLine,
  unreadCounts,
  recentWorkspaces,
  onAddGoogle,
  onCancelGoogle,
  onToggleSidebar,
  onSelect,
  onSelectApp,
  onDelete,
  onRename,
  onToggleMute,
  onReorder,
  onOpenInSplit,
  onOpenWorkspace,
  onPinFromAvailable,
  onUnpin,
  onDismissError
}: ProfileSidebarProps): React.JSX.Element {
  const [profileExpanded, setProfileExpanded] = useState<Record<string, boolean>>({})
  const [appExpanded, setAppExpanded] = useState<Record<string, boolean>>({})
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const profileIdSet = useMemo(() => new Set(profiles.map((p) => p.id)), [profiles])
  const visibleRecents = useMemo(
    () => recentWorkspaces.filter((r) => profileIdSet.has(r.profileId)).slice(0, 5),
    [recentWorkspaces, profileIdSet]
  )

  const isProfileOpen = (profileId: string): boolean => {
    if (profileId in profileExpanded) {
      return profileExpanded[profileId]!
    }
    return profileId === activeProfileId
  }

  const isAppOpen = (profileId: string, appId: AppId): boolean => {
    const key = `${profileId}:${appId}`
    if (key in appExpanded) {
      return appExpanded[key]!
    }
    return profileId === activeProfileId && activeAppId === appId
  }

  const profileUnread = (profileId: string): number =>
    APP_IDS.reduce((sum, appId) => sum + (unreadCounts[unreadKey(profileId, appId)] ?? 0), 0)

  const commitRename = (profileId: string): void => {
    const trimmed = renameValue.trim()
    onRename(profileId, trimmed)
    setRenamingId(null)
  }

  return (
    <aside className="sidebar" aria-label="Profiles">
      <div className="sidebar-brand">
        <div className="sidebar-brand-row">
          <h1 className="brand">{APP_DISPLAY_NAME}</h1>
          <div className="sidebar-brand-actions">
            <button
              type="button"
              className="btn ghost icon-btn"
              onClick={onToggleSidebar}
              title="Hide sidebar (⌘B)"
              aria-label="Hide sidebar"
            >
              <SidebarPanelIcon />
            </button>
          </div>
        </div>
      </div>

      {visibleRecents.length > 0 ? (
        <div className="recent-strip" aria-label="Recent workspaces">
          <div className="recent-strip-head">
            <p className="recent-label">Recent</p>
          </div>
          <ul className="recent-list">
            {visibleRecents.map((r) => {
              const profile = profiles.find((p) => p.id === r.profileId)
              const profileName = profile ? profileDisplayLabel(profile) : 'Profile'
              const app = APP_IDS.includes(r.appId as AppId) ? (r.appId as AppId) : null
              const live =
                app && profile
                  ? profile.apps[app].availableWorkspaces.find((w) => w.teamId === r.teamId)
                  : undefined
              const pinned =
                app && profile
                  ? profile.apps[app].pinnedWorkspaces.find((w) => w.teamId === r.teamId)
                  : undefined
              const title =
                live?.lastChannelName?.trim() ||
                (live ? displayWorkspaceName(live) : null) ||
                (pinned ? displayWorkspaceName(pinned) : null) ||
                r.label?.trim() ||
                'Workspace'
              return (
                <li key={`${r.profileId}:${r.appId}:${r.teamId}:${r.at}`}>
                  <button
                    type="button"
                    className="recent-item"
                    onClick={() => {
                      onSelect(r.profileId)
                      if (app) {
                        onOpenWorkspace(r.profileId, app, r.teamId)
                      }
                    }}
                  >
                    {app ? (
                      <span className="recent-app-chip" aria-hidden>
                        <AppIcon appId={app} className="recent-app-icon" size={11} />
                      </span>
                    ) : (
                      <span className="ws-avatar recent-avatar" aria-hidden>
                        {monogramFromLabel(title)}
                      </span>
                    )}
                    <span className="ws-copy">
                      <span className="ws-title">{title}</span>
                      <span className="ws-sub">
                        {profileName}
                        {app ? ` · ${appLabel(app)}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      <label className="field-label" htmlFor="google-email">
        Google email
      </label>
      <input
        id="google-email"
        className="field-input"
        type="email"
        placeholder="name@gmail.com"
        value={email}
        disabled={googleBusy}
        onChange={(e) => onEmailChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onAddGoogle()
        }}
      />
      <button
        type="button"
        className="btn primary block btn-apply"
        disabled={googleBusy}
        onClick={onAddGoogle}
        aria-label="Continue with Google"
      >
        {googleBusy ? 'Signing in…' : 'Continue with Google'}
      </button>
      {googleBusy ? (
        <button type="button" className="btn secondary block" onClick={onCancelGoogle}>
          Cancel sign-in
        </button>
      ) : null}

      <ul className="nav-tree">
        {profiles.length === 0 ? (
          <li className="empty-hint">No profiles yet.</li>
        ) : (
          profiles.map((profile) => {
            const profileOpen = isProfileOpen(profile.id)
            const profileActive = profile.id === activeProfileId
            const label = profileDisplayLabel(profile)

            return (
              <li
                key={profile.id}
                className={`nav-profile${profileActive ? ' is-active' : ''}${profileOpen ? ' is-open' : ''}${profile.muted ? ' is-muted' : ''}`}
                draggable
                onDragStart={() => setDragId(profile.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (!dragId || dragId === profile.id) return
                  const ids = profiles.map((p) => p.id)
                  const from = ids.indexOf(dragId)
                  const to = ids.indexOf(profile.id)
                  if (from < 0 || to < 0) return
                  const next = [...ids]
                  next.splice(from, 1)
                  next.splice(to, 0, dragId)
                  onReorder(next)
                  setDragId(null)
                }}
                onDragEnd={() => setDragId(null)}
              >
                <div className="nav-profile-row">
                  {renamingId === profile.id ? (
                    <input
                      className="nav-rename-input"
                      value={renameValue}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(profile.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(profile.id)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="nav-profile-select"
                      onClick={() => {
                        setProfileExpanded((prev) => ({ ...prev, [profile.id]: !profileOpen }))
                        onSelect(profile.id)
                      }}
                      onDoubleClick={() => {
                        setRenamingId(profile.id)
                        setRenameValue(profile.customName ?? profile.displayName)
                      }}
                      title="Double-click to rename · drag to reorder"
                    >
                      <span className="nav-disclosure" aria-hidden>
                        {profileOpen ? '▼' : '▶'}
                      </span>
                      <span className="nav-profile-name">{label}</span>
                      <ProfileAuthMark googleAuthStatus={profile.googleAuthStatus} />
                      {profile.muted ? (
                        <span
                          className="mute-mark"
                          title="Desktop notifications muted for this profile"
                        >
                          muted
                        </span>
                      ) : null}
                      {formatUnreadBadge(profileUnread(profile.id)) ? (
                        <span className="unread-badge" aria-label="Unread">
                          {formatUnreadBadge(profileUnread(profile.id))}
                        </span>
                      ) : null}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`nav-mute${profile.muted ? ' is-muted' : ''}`}
                    onClick={() => onToggleMute(profile.id, !profile.muted)}
                    title={
                      profile.muted
                        ? 'Unmute — allow desktop notifications for this profile'
                        : 'Mute — silence desktop notifications for this profile'
                    }
                    aria-pressed={profile.muted}
                    aria-label={profile.muted ? 'Unmute notifications' : 'Mute notifications'}
                  >
                    {profile.muted ? 'Muted' : 'Mute'}
                  </button>
                  <button
                    type="button"
                    className="nav-delete"
                    onClick={() => onDelete(profile.id)}
                    title="Delete profile"
                    aria-label={`Delete ${label}`}
                  >
                    ×
                  </button>
                </div>

                {profileOpen ? (
                  <ul className="nav-apps">
                    {APP_IDS.map((appId) => {
                      const session = profile.apps[appId]
                      const appOpen = isAppOpen(profile.id, appId)
                      const appActive = profileActive && activeAppId === appId
                      const signedIn = session.sessionStatus === 'signed-in'
                      const supportsWorkspaces = appSupportsWorkspaces(appId)

                      return (
                        <li
                          key={appId}
                          className={`nav-app${appActive ? ' is-active' : ''}${appOpen ? ' is-open' : ''}`}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            onOpenInSplit(profile.id, appId)
                          }}
                        >
                          <button
                            type="button"
                            className="nav-app-select"
                            onClick={() => {
                              onSelectApp(profile.id, appId)
                              if (signedIn && supportsWorkspaces) {
                                setAppExpanded((prev) => ({
                                  ...prev,
                                  [`${profile.id}:${appId}`]: true
                                }))
                              }
                            }}
                            title="Right-click: open in split"
                          >
                            <AppIcon appId={appId} className="nav-app-icon" size={12} />
                            <span className="nav-app-label">{appLabel(appId)}</span>
                            <AppStatusMark status={session.sessionStatus} />
                            {formatUnreadBadge(unreadCounts[unreadKey(profile.id, appId)] ?? 0) ? (
                              <span className="unread-badge" aria-label="Unread">
                                {formatUnreadBadge(unreadCounts[unreadKey(profile.id, appId)] ?? 0)}
                              </span>
                            ) : null}
                          </button>

                          {appOpen && signedIn && supportsWorkspaces ? (
                            <WorkspaceBranch
                              profileId={profile.id}
                              appId={appId}
                              session={session}
                              selectedTeamId={appActive ? selectedTeamId : null}
                              onOpenWorkspace={onOpenWorkspace}
                              onPin={onPinFromAvailable}
                              onUnpin={onUnpin}
                            />
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </li>
            )
          })
        )}
      </ul>

      <p className="sidebar-status" onClick={onDismissError} role="status">
        {statusLine}
      </p>
    </aside>
  )
})
