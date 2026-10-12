import type { SlackChannelSummary, SlackMessageSummary } from '../../shared/types'
import { RateLimitError, isRateLimited, retryDelaySeconds, withRetry } from './rate-limiter'
import { SlackApiError, type SlackUserSummary, type SlackUsersResponse } from './types'

export type { SlackUserSummary } from './types'

interface SlackListChannelsResponse {
  ok: boolean
  error?: string
  channels?: Array<{
    id: string
    name: string
    is_private?: boolean
    topic?: { value?: string }
    num_members?: number
  }>
  response_metadata?: { next_cursor?: string }
}

interface SlackHistoryResponse {
  ok: boolean
  error?: string
  messages?: Array<{ ts: string; user?: string; text?: string }>
  response_metadata?: { next_cursor?: string }
}

interface SlackTeamInfoResponse {
  ok: boolean
  error?: string
  team?: { id: string; name: string; domain?: string }
}

async function callSlack<T extends { ok: boolean; error?: string }>(
  method: string,
  token: string,
  params: Record<string, string>
): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(params)
    })

    const body = (await res.json()) as T
    if (!body.ok) {
      if (isRateLimited({ status: res.status, bodyError: body.error })) {
        // The delay has to come from this response. Handing withRetry a constant
        // here would leave `retryDelaySeconds` unused and retry ahead of Slack.
        throw new RateLimitError(
          retryDelaySeconds({
            status: res.status,
            bodyError: body.error,
            retryAfterHeader: res.headers.get('Retry-After'),
            bodyRetryAfter: (body as { retry_after?: number }).retry_after
          }),
          `Slack rate limited: ${method}`
        )
      }
      throw new SlackApiError(body.error ?? 'unknown_error', method)
    }
    return body
  })
}

function toChannelSummary(
  channel: NonNullable<SlackListChannelsResponse['channels']>[number]
): SlackChannelSummary {
  return {
    id: channel.id,
    name: channel.name,
    isPrivate: Boolean(channel.is_private),
    topic: channel.topic?.value || undefined,
    memberCount: channel.num_members
  }
}

export async function listChannels(token: string): Promise<SlackChannelSummary[]> {
  const channels: SlackChannelSummary[] = []
  let cursor: string | undefined

  do {
    const params: Record<string, string> = {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200'
    }
    if (cursor) {
      params.cursor = cursor
    }

    const res = await callSlack<SlackListChannelsResponse>('conversations.list', token, params)
    for (const channel of res.channels ?? []) {
      channels.push(toChannelSummary(channel))
    }
    cursor = res.response_metadata?.next_cursor || undefined
  } while (cursor)

  return channels
}

/**
 * Recent history for a channel, newest first.
 *
 * `conversations.history` is cursor-paged, so a single page is not the answer
 * unless we want to pretend a channel has under `limit` messages. `maxPages`
 * bounds the walk: an unexhausted cursor costs one request per page, and a
 * channel we have already paged through for the sidebar should never be able to
 * hold the UI hostage.
 */
export async function listMessages(
  token: string,
  channelId: string,
  limit = 200,
  oldest?: string,
  maxPages = 10
): Promise<SlackMessageSummary[]> {
  const messages: SlackMessageSummary[] = []
  let cursor: string | undefined

  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string> = {
      channel: channelId,
      limit: String(Math.min(limit, 1000))
    }
    if (oldest) params.oldest = oldest
    if (cursor) params.cursor = cursor

    const res = await callSlack<SlackHistoryResponse>('conversations.history', token, params)
    messages.push(
      ...(res.messages ?? []).map((m) => ({
        ts: m.ts,
        user: m.user,
        text: m.text ?? ''
      }))
    )
    cursor = res.response_metadata?.next_cursor || undefined
    if (!cursor) break
  }

  return messages.sort((a, b) => Number(b.ts) - Number(a.ts))
}

/** Workspace members, paged and flattened to the fields the dashboard renders. */
export async function listUsers(token: string): Promise<SlackUserSummary[]> {
  const users: SlackUserSummary[] = []
  let cursor: string | undefined

  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = { limit: '200' }
    if (cursor) params.cursor = cursor

    const res = await callSlack<SlackUsersResponse>('users.list', token, params)
    users.push(
      ...(res.members ?? []).map((u) => ({
        id: u.id,
        name: u.name,
        realName: u.profile?.real_name,
        deleted: u.deleted
      }))
    )
    cursor = res.response_metadata?.next_cursor || undefined
    if (!cursor) break
  }

  return users
}

/** Who this token belongs to and which team it is scoped to. */
export async function authTest(token: string): Promise<{ userId: string; teamId: string }> {
  const res = await callSlack<{ ok: boolean; user_id: string; team_id: string }>(
    'auth.test',
    token,
    {}
  )
  return { userId: res.user_id, teamId: res.team_id }
}

export async function getTeamInfo(
  token: string
): Promise<{ id: string; name: string; domain?: string }> {
  const res = await callSlack<SlackTeamInfoResponse>('team.info', token, {})
  if (!res.team) {
    throw new SlackApiError('missing_team', 'team.info')
  }
  return res.team
}

/** Exported for unit tests — do not call from IPC handlers. */
export const __test__ = { callSlack, toChannelSummary }
