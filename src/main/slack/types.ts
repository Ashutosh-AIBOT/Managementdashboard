export interface SlackWorkspace {
  id: string
  name: string
  domain?: string
}

export interface SlackOauthTokenResponse {
  ok: boolean
  error?: string
  access_token?: string
  scope?: string
  team?: { id: string; name: string }
  authed_user?: {
    id: string
    scope?: string
    access_token?: string
  }
}

export class SlackApiError extends Error {
  constructor(
    public readonly slackError: string,
    public readonly method: string
  ) {
    super(`Slack API ${method} failed: ${slackError}`)
    this.name = 'SlackApiError'
  }
}

export interface SlackUsersResponse {
  ok: boolean
  error?: string
  members?: Array<{
    id: string
    name: string
    deleted?: boolean
    profile?: { real_name?: string }
  }>
  response_metadata?: { next_cursor?: string }
}

export interface SlackUserSummary {
  id: string
  name: string
  realName?: string
  deleted?: boolean
}
