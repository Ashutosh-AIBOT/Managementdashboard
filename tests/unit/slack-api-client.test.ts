import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '../../src/shared/ipc-contract'
import type { SlackMessageSummary } from '../../src/shared/types'
import { RateLimitError } from '../../src/main/slack/rate-limiter'
import { SlackApiError, type SlackUserSummary } from '../../src/main/slack/types'
import type { TokenStore } from '../../src/main/slack/token-store'
import { registerSlackDataIpc } from '../../src/main/ipc/slack-data.ipc'
import { authTest, listMessages, listUsers } from '../../src/main/slack/slack-api-client'

/**
 * The IPC layer is the only thing that would drag `electron` into this suite, and
 * `handle.ts` is a one-line wrapper around `ipcMain.handle`. Stubbing it captures the
 * registered handlers so the wiring can be invoked directly — no Electron runtime, and
 * no behavioural fakery inside the handler under test.
 */
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (payload: unknown) => Promise<unknown>>()
}))

vi.mock('../../src/main/ipc/handle', () => ({
  handleInvoke: (channel: string, handler: (payload: unknown) => Promise<unknown>): void => {
    ipcHandlers.set(channel, handler)
  }
}))

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body
  } as unknown as Response
}

/** The urlencoded request body of one recorded fetch call. */
function sentParams(call: unknown[]): URLSearchParams {
  return new URLSearchParams(String((call[1] as { body: unknown }).body))
}

/** Only `tryGet` is reachable from the history handler; the rest of the store is not. */
function tokenStoreReturning(token: string): TokenStore {
  return { tryGet: async () => token } as unknown as TokenStore
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('listMessages pagination', () => {
  it('follows next_cursor until exhausted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [{ ts: '1.1', text: 'a' }],
          response_metadata: { next_cursor: 'C1' }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [{ ts: '2.2', text: 'b' }],
          response_metadata: { next_cursor: '' }
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const out = await listMessages('xoxp-test', 'C123')

    expect(out).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentParams(fetchMock.mock.calls[1]).get('cursor')).toBe('C1')
  })

  it('stops at maxPages even if the cursor never empties', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        messages: [{ ts: '1.1', text: 'a' }],
        response_metadata: { next_cursor: 'always' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await listMessages('xoxp-test', 'C123', 50, undefined, 3)

    expect(out.length).toBeLessThanOrEqual(150)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('sends the oldest watermark and clamps the page size to 1000', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, messages: [], response_metadata: { next_cursor: '' } })
      )
    vi.stubGlobal('fetch', fetchMock)

    await listMessages('xoxp-test', 'C123', 5000, '1700000000.0')

    const params = sentParams(fetchMock.mock.calls[0] as unknown[])
    expect(params.get('channel')).toBe('C123')
    expect(params.get('limit')).toBe('1000')
    expect(params.get('oldest')).toBe('1700000000.0')
    expect(params.get('cursor')).toBeNull()
  })

  it('sorts newest first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          messages: [
            { ts: '1.1', text: 'old' },
            { ts: '3.3', text: 'new' }
          ],
          response_metadata: { next_cursor: '' }
        })
      )
    )

    const out = await listMessages('xoxp-test', 'C123')

    expect(out[0].ts).toBe('3.3')
  })
})

describe('listUsers', () => {
  it('paginates and maps the fields the dashboard needs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          members: [{ id: 'U1', name: 'ada', profile: { real_name: 'Ada L' } }],
          response_metadata: { next_cursor: 'U-page-2' }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          members: [{ id: 'U2', name: 'gone', deleted: true }],
          response_metadata: { next_cursor: '' }
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const users: SlackUserSummary[] = await listUsers('xoxp-test')

    expect(users).toEqual([
      { id: 'U1', name: 'ada', realName: 'Ada L', deleted: undefined },
      { id: 'U2', name: 'gone', realName: undefined, deleted: true }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain('users.list')
    expect(sentParams(fetchMock.mock.calls[1] as unknown[]).get('cursor')).toBe('U-page-2')
  })
})

describe('authTest', () => {
  it('surfaces the user and team ids', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, user_id: 'U1', team_id: 'T1' }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await authTest('xoxp-test')

    expect(out).toEqual({ userId: 'U1', teamId: 'T1' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('auth.test')
  })
})

describe('SlackHistoryForChannel handler', () => {
  /**
   * This handler is the ad-hoc "show me recent messages" read, not the sync walk.
   * It issued one request for at most 50 messages before Task 2 gave `listMessages`
   * bulk defaults; without an explicit `maxPages` here it would silently walk ten
   * cursor pages of 200. The mock always hands back a next_cursor, so a handler
   * that merely relied on the cursor running out would still fail this.
   */
  it('issues one request for 50 messages when no limit is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        messages: Array.from({ length: 50 }, (_, i) => ({ ts: `${200 - i}.0`, text: `m${i}` })),
        response_metadata: { next_cursor: 'there-is-more' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    ipcHandlers.clear()
    registerSlackDataIpc({ tokenStore: tokenStoreReturning('xoxp-ipc') })

    const handler = ipcHandlers.get(IpcChannels.SlackHistoryForChannel)
    const out = (await handler?.({
      profileId: 'p1',
      teamId: 'T1',
      channelId: 'C123'
    })) as SlackMessageSummary[]

    const params = sentParams(fetchMock.mock.calls[0])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(params.get('limit')).toBe('50')
    expect(params.get('channel')).toBe('C123')
    expect(params.get('cursor')).toBeNull()
    expect(out).toHaveLength(50)
  })

  it('honours an explicit limit and still stays on one page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        messages: [{ ts: '1.0', text: 'only' }],
        response_metadata: { next_cursor: 'there-is-more' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    ipcHandlers.clear()
    registerSlackDataIpc({ tokenStore: tokenStoreReturning('xoxp-ipc') })

    const handler = ipcHandlers.get(IpcChannels.SlackHistoryForChannel)
    await handler?.({ profileId: 'p1', teamId: 'T1', channelId: 'C123', limit: 5 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sentParams(fetchMock.mock.calls[0]).get('limit')).toBe('5')
  })
})

describe('callSlack rate limiting', () => {
  /**
   * The point of these two tests is that the sleep length comes from the mocked
   * Slack response, not from a constant baked into the client. Both assert the
   * exact `setTimeout` delay and, as a guard against that constant drifting back
   * in, that the call is still pending after our own 1s backoff would have
   * elapsed.
   */
  it('sleeps for the retry_after carried in the Slack response body', async () => {
    vi.useFakeTimers()
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'ratelimited', retry_after: 7 }, 429))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, messages: [{ ts: '9.9', text: 'recovered' }] })
      )
    vi.stubGlobal('fetch', fetchMock)

    let settled = false
    const pending = listMessages('xoxp-test', 'C123').then((out) => {
      settled = true
      return out
    })

    await vi.advanceTimersByTimeAsync(3000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toEqual([{ ts: '9.9', user: undefined, text: 'recovered' }])
    expect(settled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(timerSpy.mock.calls.map((c) => c[1])).toEqual([7000])
  })

  it('falls back to the Retry-After header when the body has no retry_after', async () => {
    vi.useFakeTimers()
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: 'ratelimited' }, 429, {
          'Retry-After': '5'
        })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, messages: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = listMessages('xoxp-test', 'C123')
    await vi.advanceTimersByTimeAsync(3000)
    expect(timerSpy.mock.calls.map((c) => c[1])).toEqual([5000])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after the bounded attempt count instead of recursing forever', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'setTimeout')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: 'ratelimited', retry_after: 1 }, 429))
    vi.stubGlobal('fetch', fetchMock)

    // Attach the outcome handler up front: the rejection lands mid-timer-advance
    // and would otherwise be reported as an unhandled rejection.
    const outcome = listMessages('xoxp-test', 'C123').then(
      () => undefined,
      (err: unknown) => err
    )
    await vi.advanceTimersByTimeAsync(60_000)

    const err = await outcome
    expect(err).toBeInstanceOf(RateLimitError)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not retry an error that is not a rate limit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: 'invalid_auth' }, 200))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listMessages('xoxp-bad', 'C123')).rejects.toThrow(SlackApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
