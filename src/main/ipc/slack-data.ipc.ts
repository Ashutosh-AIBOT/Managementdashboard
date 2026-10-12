import { IpcChannels } from '../../shared/ipc-contract'
import type { ChannelHistoryPayload, ProfileIdPayload, WorkspacePayload } from '../../shared/types'
import { listChannels, listMessages } from '../slack/slack-api-client'
import type { TokenStore } from '../slack/token-store'
import { handleInvoke } from './handle'

export interface SlackDataIpcDeps {
  tokenStore: TokenStore
}

export function registerSlackDataIpc(deps: SlackDataIpcDeps): void {
  handleInvoke(IpcChannels.SlackWorkspacesForProfile, async (payload: ProfileIdPayload) => {
    return deps.tokenStore.listWorkspaces(payload.profileId)
  })

  handleInvoke(IpcChannels.SlackChannelsForWorkspace, async (payload: WorkspacePayload) => {
    // Pinned workspaces do not require Connect — return empty instead of throwing.
    const token = await deps.tokenStore.tryGet(payload.profileId, payload.teamId)
    if (!token) {
      return []
    }
    return listChannels(token)
  })

  handleInvoke(IpcChannels.SlackHistoryForChannel, async (payload: ChannelHistoryPayload) => {
    const token = await deps.tokenStore.tryGet(payload.profileId, payload.teamId)
    if (!token) {
      return []
    }
    // Ad-hoc "show me recent messages" read: one request, bounded. `listMessages`
    // defaults to the bulk-walk profile (200 per page, up to 10 pages), which is
    // what the sync engine wants and is far too much for an on-demand invoke.
    return listMessages(token, payload.channelId, payload.limit ?? 50, undefined, 1)
  })
}
