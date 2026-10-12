import { describe, expect, it, vi } from 'vitest'
import {
  RateLimitError,
  isRateLimited,
  retryDelaySeconds,
  withRetry
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
    expect(
      retryDelaySeconds({
        status: 200,
        bodyError: 'ratelimited',
        retryAfterHeader: '5',
        bodyRetryAfter: 30
      })
    ).toBe(30)
  })
  it('falls back to the header', () => {
    expect(
      retryDelaySeconds({ status: 429, retryAfterHeader: '7', bodyRetryAfter: undefined })
    ).toBe(7)
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
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError(1, 'rl'))
      .mockResolvedValueOnce('ok')
    expect(await withRetry(fn, { sleep })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('sleeps at least as long as the server asked', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError(30, 'rl'))
      .mockResolvedValueOnce('ok')
    await withRetry(fn, { sleep })
    expect(sleep).toHaveBeenCalledWith(expect.any(Number))
    const sleptMs = sleep.mock.calls[0][0] as number
    expect(sleptMs).toBeGreaterThanOrEqual(30_000)
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
