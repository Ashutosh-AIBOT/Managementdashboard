/**
 * Slack rate-limit detection and bounded retry.
 *
 * Pure and Electron-free so `tests/unit/rate-limiter.test.ts` can exercise it
 * in plain Node — same split as `profiles/chrome-resolution.ts`.
 */

/** Upper bound on any single delay, in seconds. Slack's own advice tops out well below this. */
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
      const backoffMs = baseDelayMs * 2 ** (attempt - 1)
      const jitter = Math.floor(Math.random() * 250)
      // Slack's requested delay is a floor, not a hint: retrying early just burns
      // an attempt and gets us rate-limited again. Our own backoff still applies
      // when the server asks for less, and the cap bounds the worst case.
      const serverFloorMs = err.retryAfterSeconds * 1000
      await sleep(Math.min(Math.max(backoffMs + jitter, serverFloorMs), MAX_DELAY_SECONDS * 1000))
    }
  }
  throw lastError ?? new RateLimitError(1, 'rate limited')
}
