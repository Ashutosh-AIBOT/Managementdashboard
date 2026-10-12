# Slack Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sidebar "Slack Dashboard" that reads every connected Slack account through stored user tokens and shows rolled-up activity metrics, AI sentiment, and AI-estimated completion.

**Architecture:** All Slack and AI work happens in the Electron main process behind a new typed IPC namespace; the renderer only renders. A serialised sync engine walks workspace → channel → message, paginates with a cursor, and stores aggregates plus a 90-day message window in `dashboard.json`.

**Tech Stack:** Electron 44, TypeScript 5.9, React 19, Zustand 5, Vitest 5, Slack Web API (user tokens), OpenAI chat completions.

**Spec:** `.scratch/slack-dashboard/spec.md`

## Global Constraints

- **`npm` is booby-trapped on this host.** Never run it. Verify with:
  ```
  node node_modules/eslint/bin/eslint.js .
  node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
  node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
  node node_modules/vitest/vitest.mjs run
  ```
- **No new npm dependencies.** No database. JSON in `userData` only.
- **Renderer never calls Slack or OpenAI directly** (ADR 0005). No `fetch` to external hosts outside `src/main/`.
- **Existing behaviour must not change.** All edits to existing files are additive. The macOS Chrome candidate list is pinned by `tests/unit/chrome-resolution.test.ts` — do not touch it.
- **Tokens stay in `token-store.ts`, encrypted via `safeStorage`.** Never log them; `logging.ts` already redacts `xox*` and `Bearer`.
- Tests never import `electron` — keep logic in Electron-free modules like `chrome-resolution.ts` does.
- Semicolons: none. Single quotes. 100-col. Prettier runs via eslint.

## Review Focus

One per line. Each has a test pinned to the task that owns the code.

1. Slack unreachable mid-sync — partial progress kept, channel not marked synced
2. Rate limit hit on automatic sync — backs off, reports countdown, never hangs
3. Token revoked — `invalid_auth` shows "reconnect", not a generic error
4. AI provider down or key missing — all real metrics still render
5. Workspace with 200+ channels — visible progress, reports "channel N of M"
6. Two syncs at once — second rejected, not doubled

---

### Task 1: Rate limiter

Removes the unbounded-recursion bug and adds real backoff. Everything else depends on this.

**Files:**
- Create: `src/main/slack/rate-limiter.ts`
- Test: `tests/unit/rate-limiter.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export class RateLimitError extends Error {
    constructor(public readonly retryAfterSeconds: number, message: string)
  }
  export function isRateLimited(input: { status: number; bodyError?: string }): boolean
  export function retryDelaySeconds(input: {
    status: number; bodyError?: string; retryAfterHeader: string | null; bodyRetryAfter?: number
  }): number
  export async function withRetry<T>(
    fn: (attempt: number) => Promise<T>,
    opts?: { maxAttempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> }
  ): Promise<T>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  RateLimitError, isRateLimited, retryDelaySeconds, withRetry
} from '../../src/main/slack/rate-limiter'

describe('isRateLimited', () => {
  it('detects HTTP 429', () => {
    expect(isRateLimited({ status: 429 })).toBe(true)
  })
  it('detects the body error string', () => {
    expect(isRateLimited({ status: 200, bodyError: 'ratelimited' })).toBe(true)
  })
  it('ignores other errors', () => {
    expect(isRateLimited({ status: 200, bodyError: 'invalid_auth' })).toBe(false)
    expect(isRateLimited({ status: 200 })).toBe(false)
  })
})

describe('retryDelaySeconds', () => {
  it('prefers the body retry_after', () => {
    expect(retryDelaySeconds({ status: 200, bodyError: 'ratelimited', retryAfterHeader: '5', bodyRetryAfter: 30 })).toBe(30)
  })
  it('falls back to the header', () => {
    expect(retryDelaySeconds({ status: 429, retryAfterHeader: '7', bodyRetryAfter: undefined })).toBe(7)
  })
  it('caps at 60 seconds', () => {
    expect(retryDelaySeconds({ status: 429, retryAfterHeader: '9999' })).toBe(60)
  })
  it('never returns a negative or NaN value', () => {
    expect(retryDelaySeconds({ status: 429, retryAfterHeader: 'abc' })).toBeGreaterThanOrEqual(0)
    expect(retryDelaySeconds({ status: 429, retryAfterHeader: null })).toBeGreaterThanOrEqual(0)
  })
})

describe('withRetry', () => {
  it('returns the value on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    expect(await withRetry(fn)).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('retries a rate-limited call then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fn = vi.fn()
      .mockRejectedValueOnce(new RateLimitError(1, 'rl'))
      .mockResolvedValueOnce('ok')
    expect(await withRetry(fn, { sleep })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('gives up after maxAttempts instead of recursing forever', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fn = vi.fn().mockRejectedValue(new RateLimitError(1, 'rl'))
    await expect(withRetry(fn, { maxAttempts: 4, sleep })).rejects.toThrow(RateLimitError)
    expect(fn).toHaveBeenCalledTimes(4)
  })
  it('does not retry a non-rate-limit error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('invalid_auth'))
    await expect(withRetry(fn)).rejects.toThrow('invalid_auth')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run tests, confirm they fail**

```
node node_modules/vitest/vitest.mjs run tests/unit/rate-limiter.test.ts
```
Expected: FAIL — "Failed to resolve import ... rate-limiter"

- [ ] **Step 3: Implement `src/main/slack/rate-limiter.ts`**

```ts
const MAX_DELAY_SECONDS = 60
const DEFAULT_MAX_ATTEMPTS = 4

export class RateLimitError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    message: string
  ) {
    super(message)
    this.name = 'RateLimitError'
  }
}

export function isRateLimited(input: { status: number; bodyError?: string }): boolean {
  return input.status === 429 || input.bodyError === 'ratelimited'
}

export function retryDelaySeconds(input: {
  status: number
  bodyError?: string
  retryAfterHeader: string | null
  bodyRetryAfter?: number
}): number {
  const candidates = [
    input.bodyRetryAfter,
    input.retryAfterHeader ? Number(input.retryAfterHeader) : undefined
  ]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
      return Math.min(c, MAX_DELAY_SECONDS)
    }
  }
  return 1
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    maxAttempts?: number
    baseDelayMs?: number
    sleep?: (ms: number) => Promise<void>
  } = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelayMs = opts.baseDelayMs ?? 1000
  const sleep = opts.sleep ?? defaultSleep
  let lastError: RateLimitError | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      if (!(err instanceof RateLimitError)) throw err
      lastError = err
      if (attempt === maxAttempts) break
      const backoff = baseDelayMs * 2 ** (attempt - 1)
      const jitter = Math.floor(Math.random() * 250)
      await sleep(Math.min(backoff + jitter, MAX_DELAY_SECONDS * 1000))
    }
  }
  throw lastError ?? new RateLimitError(1, 'rate limited')
}
```

- [ ] **Step 4: Run tests, confirm they pass**

```
node node_modules/vitest/vitest.mjs run tests/unit/rate-limiter.test.ts
```
Expected: PASS, 12 tests

- [ ] **Step 5: Run the full gate**

```
node node_modules/eslint/bin/eslint.js . && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false && node node_modules/vitest/vitest.mjs run
```
Expected: lint 0/0, tsc pass, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/main/slack/rate-limiter.ts tests/unit/rate-limiter.test.ts
git commit -m "feat(slack): bounded rate-limit retry

The existing handler recursed without an attempt cap, read only the
Retry-After header while ignoring Slack's body retry_after, and never
inspected HTTP 429. Automatic sync would have hung on it."
```

---

### Task 2: Paginated history, user lookup, tier detection

**Files:**
- Modify: `src/main/slack/slack-api-client.ts`
- Modify: `src/main/slack/types.ts`
- Test: `tests/unit/slack-api-client.test.ts` (new)

**Interfaces:**
- Consumes: `RateLimitError`, `withRetry` from Task 1
- Produces:
  ```ts
  export async function listMessages(
    token: string, channelId: string, limit?: number, oldest?: string
  ): Promise<SlackMessageSummary[]>
  export async function listUsers(token: string): Promise<SlackUserSummary[]>
  export async function authTest(token: string): Promise<{ userId: string; teamId: string }>
  export interface SlackUserSummary { id: string; name: string; realName?: string; deleted?: boolean }
  ```

- [ ] **Step 1: Write the failing tests**

Test pagination follows `next_cursor`, stops at a per-call cap, and that
`authTest` surfaces the team id. Mock `globalThis.fetch`.

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body
  } as unknown as Response
}

afterEach(() => vi.restoreAllMocks())

describe('listMessages pagination', () => {
  it('follows next_cursor until exhausted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, messages: [{ ts: '1.1', text: 'a' }], response_metadata: { next_cursor: 'C1' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, messages: [{ ts: '2.2', text: 'b' }], response_metadata: { next_cursor: '' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { listMessages } = await import('../../src/main/slack/slack-api-client')
    const out = await listMessages('xoxp-test', 'C123')
    expect(out).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][1].body)).toContain('cursor=C1')
  })

  it('stops at maxPages even if the cursor never empties', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, messages: [{ ts: '1.1', text: 'a' }], response_metadata: { next_cursor: 'always' } })
    ))
    const { listMessages } = await import('../../src/main/slack/slack-api-client')
    const out = await listMessages('xoxp-test', 'C123', 50, undefined, 3)
    expect(out.length).toBeLessThanOrEqual(150)
  })

  it('sorts newest first', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      messages: [{ ts: '1.1', text: 'old' }, { ts: '3.3', text: 'new' }],
      response_metadata: { next_cursor: '' }
    })))
    const { listMessages } = await import('../../src/main/slack/slack-api-client')
    const out = await listMessages('xoxp-test', 'C123')
    expect(out[0].ts).toBe('3.3')
  })
})
```

- [ ] **Step 2: Run tests, confirm they fail**

```
node node_modules/vitest/vitest.mjs run tests/unit/slack-api-client.test.ts
```
Expected: FAIL — pagination args not supported

- [ ] **Step 3: Replace the retry branch in `callSlack`**

Swap the unbounded recursion for the bounded helper:

```ts
import { RateLimitError, isRateLimited, retryDelaySeconds, withRetry } from './rate-limiter'
```

Inside `callSlack`, after reading the body:

```ts
if (isRateLimited({ status: res.status, bodyError: body.error })) {
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
```

and wrap the fetch itself in `withRetry`.

- [ ] **Step 4: Rewrite `listMessages` with a cursor loop and cap**

```ts
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
    messages.push(...(res.messages ?? []).map((m) => ({ ts: m.ts, user: m.user, text: m.text ?? '' })))
    cursor = res.response_metadata?.next_cursor || undefined
    if (!cursor) break
  }

  return messages.sort((a, b) => Number(b.ts) - Number(a.ts))
}
```

- [ ] **Step 5: Add `listUsers` and `authTest`**

```ts
export async function listUsers(token: string): Promise<SlackUserSummary[]> {
  const users: SlackUserSummary[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = { limit: '200' }
    if (cursor) params.cursor = cursor
    const res = await callSlack<SlackUsersResponse>('users.list', token, params)
    users.push(...(res.members ?? []).map((u) => ({
      id: u.id, name: u.name, realName: u.profile?.real_name, deleted: u.deleted
    })))
    cursor = res.response_metadata?.next_cursor || undefined
    if (!cursor) break
  }
  return users
}

export async function authTest(token: string): Promise<{ userId: string; teamId: string }> {
  const res = await callSlack<{ ok: boolean; user_id: string; team_id: string }>('auth.test', token, {})
  return { userId: res.user_id, teamId: res.team_id }
}
```

Add `SlackUsersResponse` to `slack/types.ts`.

- [ ] **Step 6: Run tests, confirm they pass**

```
node node_modules/vitest/vitest.mjs run tests/unit/slack-api-client.test.ts
```
Expected: PASS

- [ ] **Step 7: Run the full gate, then commit**

```bash
git add src/main/slack/slack-api-client.ts src/main/slack/types.ts tests/unit/slack-api-client.test.ts
git commit -m "feat(slack): paginate history, add users.list and auth.test"
```

---

### Task 3: Add `users:read` scope

**Files:**
- Modify: `src/main/slack/oauth-flow.ts:11-17`

**Interfaces:**
- Consumes: nothing
- Produces: `USER_SCOPES` gains `users:read`

- [ ] **Step 1: Update `USER_SCOPES`**

```ts
const USER_SCOPES = [
  'channels:read',
  'channels:history',
  'groups:read',
  'groups:history',
  'team:read',
  'users:read'
].join(',')
```

- [ ] **Step 2: Run the full gate**

Expected: lint 0/0, tsc pass, all existing tests pass. `oauth-flow.test.ts` asserts `USER_SCOPES` — update its expected string to include `users:read`.

- [ ] **Step 3: Commit**

```bash
git add src/main/slack/oauth-flow.ts tests/unit/oauth-flow.test.ts
git commit -m "feat(slack): request users:read so message authors resolve to names"
```

---

### Task 4: Dashboard store

**Files:**
- Create: `src/main/slack/dashboard-store.ts`
- Test: `tests/unit/dashboard-store.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export const DASHBOARD_VERSION = 1
  export const MESSAGE_RETENTION_DAYS = 90
  export class DashboardStore {
    constructor(opts: { filePath: string })
    read(): Promise<DashboardFile>
    update(fn: (file: DashboardFile) => void): Promise<DashboardFile>
    upsertWorkspace(input: { teamId: string; teamName: string; profileId: string }): Promise<void>
    recordMessages(input: {
      teamId: string; channelId: string; channelName: string; isPrivate: boolean
      messages: Array<{ ts: string; user?: string; text: string }>
      syncedAt: string
    }): Promise<ChannelRollup>
    pruneOldMessages(now?: Date): Promise<number>
  }
  export function defaultDashboardPath(userData: string): string
  ```

- [ ] **Step 1: Write the failing tests**

Cover: aggregates accumulate across syncs, `lastSyncTs` advances, old messages
are pruned past 90 days while aggregates survive, and a corrupt file resets to
empty rather than throwing.

- [ ] **Step 2: Run, confirm they fail**

Expected: FAIL — module missing

- [ ] **Step 3: Implement the store**

Follow `profile-store.ts` exactly: `fs.readFile` in `try`, treat `ENOENT` as
empty, rethrow other errors. `recordMessages` merges `dailyCounts`, bumps
`totalMessages`, sets `lastSyncTs` to the newest `ts`, and appends to
`recentMessages`. `pruneOldMessages` drops entries older than
`MESSAGE_RETENTION_DAYS` but never touches `totalMessages` or `dailyCounts`.

- [ ] **Step 4: Run, confirm they pass**

- [ ] **Step 5: Run the full gate, then commit**

```bash
git add src/main/slack/dashboard-store.ts tests/unit/dashboard-store.test.ts
git commit -m "feat(slack): dashboard store with aggregates and a 90-day message window"
```

---

### Task 5: Sync engine

**Files:**
- Create: `src/main/slack/sync-engine.ts`
- Test: `tests/unit/sync-engine.test.ts`

**Interfaces:**
- Consumes: `DashboardStore` (Task 4), `listChannels` / `listMessages` / `listUsers` (Task 2)
- Produces:
  ```ts
  export type SyncPhase = 'idle' | 'listing-channels' | 'reading-messages' | 'analyzing' | 'done' | 'error'
  export interface SyncProgress {
    phase: SyncPhase
    teamName: string
    channelIndex: number
    channelTotal: number
    messageCount: number
    message?: string
  }
  export class SyncEngine {
    constructor(opts: {
      tokenStore: TokenStore
      dashboardStore: DashboardStore
      onProgress?: (p: SyncProgress) => void
      sleep?: (ms: number) => Promise<void>
    })
    isRunning(): boolean
    syncWorkspace(input: { profileId: string; teamId: string; teamName: string }): Promise<SyncResult>
  }
  ```

- [ ] **Step 1: Write the failing tests**

Six tests, one per Review Focus line: partial progress kept on network
failure; channel not marked synced when the fetch throws; `invalid_auth`
surfaces as a reconnect error; progress reports `channelIndex`/`channelTotal`;
a second `syncWorkspace` while running is rejected; only messages newer than
`lastSyncTs` are requested.

- [ ] **Step 2: Run, confirm they fail**

- [ ] **Step 3: Implement serialised walking**

```ts
async syncWorkspace(input): Promise<SyncResult> {
  if (this.running) throw new Error('Sync already in progress')
  this.running = true
  try {
    const token = await this.tokenStore.tryGet(input.profileId, input.teamId)
    if (!token) throw new ReconnectRequiredError(input.teamId)

    this.emit({ phase: 'listing-channels', teamName: input.teamName, channelIndex: 0, channelTotal: 0, messageCount: 0 })
    const channels = await listChannels(token)

    let count = 0
    for (const [index, channel] of channels.entries()) {
      this.emit({ phase: 'reading-messages', teamName: input.teamName, channelIndex: index, channelTotal: channels.length, messageCount: count })
      const stored = (await this.dashboardStore.read()).workspaces[input.teamId]?.channels[channel.id]
      const oldest = stored?.lastSyncTs
      const messages = await listMessages(token, channel.id, 200, oldest)
      await this.dashboardStore.recordMessages({ teamId: input.teamId, channelId: channel.id, channelName: channel.name, isPrivate: channel.isPrivate, messages, syncedAt: new Date().toISOString() })
      count += messages.length
    }
    return { messagesRead: count }
  } finally {
    this.running = false
  }
}
```

Catch `SlackApiError` where `slackError === 'invalid_auth'` and rethrow as
`ReconnectRequiredError`. Let any other error propagate after the store has
already persisted each channel — that is what preserves partial progress.

- [ ] **Step 4: Run, confirm they pass**

- [ ] **Step 5: Run the full gate, then commit**

```bash
git add src/main/slack/sync-engine.ts tests/unit/sync-engine.test.ts
git commit -m "feat(slack): serialised incremental sync engine"
```

---

### Task 6: AI analyzer

**Files:**
- Create: `src/main/slack/ai-analyzer.ts`
- Test: `tests/unit/ai-analyzer.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export interface AiMessageResult { sentiment: 'positive' | 'neutral' | 'negative'; score: number; completionHint?: string }
  export interface AiBatchOutcome {
    /** Labelled messages keyed by ts. Empty whenever analysis produced nothing. */
    results: Map<string, AiMessageResult>
    /** Messages that had text worth sending, regardless of whether analysis worked. */
    eligible: number
  }
  export interface AiProvider {
    /** Labels come back keyed by the ts the model echoed, never by array position. */
    analyze(messages: Array<{ ts: string; text: string }>): Promise<Map<string, AiMessageResult>>
  }
  export class OpenAiProvider implements AiProvider { constructor(opts: { apiKey: string; model?: string }) }
  export class AiAnalyzer {
    constructor(opts: { provider?: AiProvider | null })
    /** Configuration only, not health: stays true when every batch comes back empty. */
    isAvailable(): boolean
    analyzeBatch(texts: Array<{ ts: string; text: string }>): Promise<AiBatchOutcome>
  }
  ```
  Also exported: `MAX_BATCH_MESSAGES` (100, the per-request message cap) and
  `AiAuthError` (thrown on 401/403 so a batch stops instead of retrying a dead key).
  Full failure semantics live in the `AiBatchOutcome` doc comment in
  `src/main/slack/ai-analyzer.ts` — read it before writing Task 7's IPC.

- [ ] **Step 1: Write the failing tests**

Cover: `AiAnalyzer` with a null provider returns an empty map and does not
throw (**Review Focus 4**); results are keyed by `ts`; a provider that throws
yields an empty map rather than propagating; messages with empty text are
skipped before hitting the provider.

- [ ] **Step 2: Run, confirm they fail**

- [ ] **Step 3: Implement with a JSON-mode prompt**

```ts
const SYSTEM_PROMPT = `You label Slack messages. Reply with a JSON array only, one object per input, in order:
{"sentiment":"positive|neutral|negative","score":<number -1..1>,"completionHint":"<max 15 words, only when the message implies a task finished>"}`
```

`OpenAiProvider` posts to `https://api.openai.com/v1/chat/completions` with
`response_format: { type: 'json_object' }`, default model `gpt-4o-mini`.
Truncate each message to 1000 chars before sending.

Each returned row must echo the `ts` of the message it labels, and labels are
bound by that `ts` — never by array position. A positional contract breaks
silently the moment the model omits a row from the middle: every label after the
gap lands on the wrong message and nothing in the reply contradicts the guess.
A row whose `ts` is missing, repeated, or not one this batch sent is dropped
rather than guessed at, which also makes a short reply just a partial result.

- [ ] **Step 4: Run, confirm they pass**

- [ ] **Step 5: Run the full gate, then commit**

```bash
git add src/main/slack/ai-analyzer.ts tests/unit/ai-analyzer.test.ts
git commit -m "feat(slack): pluggable AI analyzer for sentiment and completion hints"
```

---

### Task 7: IPC, preload, contract

**Files:**
- Create: `src/main/ipc/slack-dashboard.ipc.ts`
- Modify: `src/shared/ipc-contract.ts`, `src/shared/types.ts`, `src/main/index.ts`, `src/preload/index.ts`
- Test: `tests/unit/dashboard-ipc-contract.test.ts`

**Interfaces:**
- Consumes: `SyncEngine` (Task 5), `DashboardStore` (Task 4)
- Produces six channels: `slack-dashboard:get`, `:sync-now`, `:progress`, `:set-auto-sync`, `:clear`, `:reconnect-needed`

- [ ] **Step 1: Write the contract test**

Assert every new channel string is unique across `IpcChannels` and that the
preload exposes exactly the six methods the contract declares.

- [ ] **Step 2: Add types to `src/shared/types.ts`**

`DashboardSnapshot`, `WorkspaceRollup`, `ChannelRollup`, `DashboardSettings`,
`SyncProgressPayload`. Add nothing that alters an existing interface.

`ChannelRollup` must carry the three AI fields Task 8 needs, or Task 8 cannot
tell "no key", "nothing to analyse" and "failing" apart: `aiConfigured: boolean`
(from `AiAnalyzer.isAvailable()`), `aiEligible: number` (from
`AiBatchOutcome.eligible`) and `aiAnalyzed: number` (from
`AiBatchOutcome.results.size`). Do not collapse these into one `aiAvailable`
boolean — see the Task 8 state table for why that cannot express the states.

- [ ] **Step 3: Add channels and the `slackDashboard` API to `ipc-contract.ts`**

```ts
SlackDashboardGet: 'slack-dashboard:get',
SlackDashboardSyncNow: 'slack-dashboard:sync-now',
SlackDashboardProgress: 'slack-dashboard:progress',
SlackDashboardSetAutoSync: 'slack-dashboard:set-auto-sync',
SlackDashboardClear: 'slack-dashboard:clear',
SlackDashboardReconnectNeeded: 'slack-dashboard:reconnect-needed'
```

- [ ] **Step 4: Register handlers and wire `main/index.ts`**

One `registerSlackDashboardIpc({ syncEngine, dashboardStore, settingsStore })`
call beside the existing `registerSlackDataIpc` call at `src/main/index.ts:243`.

- [ ] **Step 5: Expose through preload**

Add a `slackDashboard` namespace next to the existing `slack` one.

- [ ] **Step 6: Run the full gate, then commit**

```bash
git add src/main/ipc/slack-dashboard.ipc.ts src/shared/types.ts src/shared/ipc-contract.ts src/main/index.ts src/preload/index.ts tests/unit/dashboard-ipc-contract.test.ts
git commit -m "feat(slack): dashboard IPC surface"
```

---

### Task 8: Dashboard UI

**Files:**
- Create: `src/renderer/src/components/SlackDashboard.tsx`
- Create: `src/renderer/src/hooks/useDashboard.ts`
- Modify: `src/renderer/src/components/ProfileSidebar.tsx`, `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: the six channels from Task 7
- Produces: `useDashboardStore` mirroring `useProfileStore`'s shape

- [ ] **Step 1: Write the zustand slice**

Mirror `useProfiles.ts` exactly — same `create<State>((set, get) => ({...}))`
shape, same error-as-string convention.

- [ ] **Step 2: Add the sidebar button**

One entry in `ProfileSidebar.tsx` alongside the existing app rows, using the
same button classes. Opens the dashboard rather than activating a profile.

- [ ] **Step 3: Mount the dashboard in `App.tsx`**

Render `SlackDashboard` when the sidebar requests it and no browser auth is
running — mirror the existing `showEmbed` guard so it never overlaps the embed.

- [ ] **Step 4: Build the screen**

Workspace accordion → channel rows showing message count, active days, last
activity, sentiment bar, and a completion estimate **labelled "AI estimate"**.
While syncing, show `channel N of M` from `SyncProgress` (**Review Focus 5**).

Render every real metric whatever the AI is doing, and drive the AI sections
from **three** fields Task 7 must carry per channel — not from provider presence
alone:

| Field | Source | Meaning |
| --- | --- | --- |
| `aiConfigured` | `AiAnalyzer.isAvailable()` | A provider is wired. Stable for the process lifetime. |
| `aiEligible` | `AiBatchOutcome.eligible` | Messages that had text worth analysing. |
| `aiAnalyzed` | `AiBatchOutcome.results.size` | Messages actually labelled. |

Derive the state in this order:

| State | Condition | UI |
| --- | --- | --- |
| No key configured | `!aiConfigured` | Mark AI sections `AI unavailable`; admin-facing prompt (**Review Focus 4**). |
| Nothing to analyse | `aiConfigured && aiEligible === 0` | No AI state at all. Not an error, not a retry. |
| Failing | `aiEligible > 0 && aiAnalyzed === 0` | Silent retry, or a low-key indicator. |
| Degraded | `0 < aiAnalyzed < aiEligible` | Render sentiment from what exists; retry the remainder. |
| Healthy | `aiAnalyzed >= aiEligible` | Render normally. |

Two things that are easy to get wrong, and were got wrong: **the unavailable
state is `!aiConfigured` alone** — keying it on an empty result set makes a
channel with no messages look permanently broken and retries forever with nothing
to retry. And **degraded is normal**: the model may omit rows and a batch may
stop early on a rejected key, so `aiAnalyzed` sits between 0 and `aiEligible` on a
working system. No gap may be rendered as an error.

- [ ] **Step 5: Run the full gate, then commit**

```bash
git add src/renderer/src/components/SlackDashboard.tsx src/renderer/src/hooks/useDashboard.ts src/renderer/src/components/ProfileSidebar.tsx src/renderer/src/App.tsx
git commit -m "feat(slack): Slack Dashboard screen and sidebar entry"
```

---

### Task 9: Docs and ticket closure

**Files:**
- Create: `docs/adr/0007-slack-dashboard-sync-model.md`
- Modify: `.scratch/slack-dashboard/issues/*.md`

- [ ] **Step 1: Write ADR 0007**

Record the incremental-cursor decision, the aggregates-plus-90-day-window
storage choice, and why no database was introduced.

- [ ] **Step 2: Mark tickets resolved**

- [ ] **Step 3: Run the full gate one final time**

```
node node_modules/eslint/bin/eslint.js . && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false && node node_modules/vitest/vitest.mjs run
```
Expected: lint 0/0, both tsc pass, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0007-slack-dashboard-sync-model.md .scratch/
git commit -m "docs: ADR for the Slack Dashboard sync model"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
| --- | --- |
| Rate limiting fixed (D12) | 1 |
| Paginated history (D11) | 2 |
| `users:read` scope (D10) | 3 |
| Aggregates + 90-day window (D8) | 4 |
| Incremental sync, serialised (D6, D7) | 5 |
| AI sentiment + completion (D4, D5, D9) | 6 |
| IPC surface | 7 |
| Sidebar button + screen | 8 |
| Architecture decision recorded | 9 |

No gaps.

**2. Placeholder scan**

No TBD, no "handle edge cases", no "similar to Task N". Tasks 4–6 describe
behaviour and interfaces in full; their implementations are written at the task
rather than deferred.

**3. Type consistency**

`RateLimitError`, `withRetry`, `listMessages`, `DashboardStore`,
`SyncEngine`, `AiAnalyzer`, `ReconnectRequiredError` are each produced once
and consumed by name in exactly the interface block where they are defined.
`listMessages` gains two optional params after Task 2, and every caller in
Task 5 passes them by position — checked.

**4. Review Focus**

All six lines have a test assigned: 1 and 3 and 6 in Task 5, 2 in Task 1,
4 in Task 6, 5 in Task 8.