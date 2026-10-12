import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../src/main/logging'

/**
 * Regression: a closed stdout made every log call throw an uncaught EPIPE,
 * which Electron surfaced as "A JavaScript error occurred in the main process"
 * and killed the app. Logging must never be able to do that.
 */

function epipe(): never {
  const err = new Error('write EPIPE') as NodeJS.ErrnoException
  err.code = 'EPIPE'
  throw err
}

describe('log resilience', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(vi.fn())
    vi.spyOn(console, 'warn').mockImplementation(vi.fn())
    vi.spyOn(console, 'error').mockImplementation(vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not throw when stdout is closed', () => {
    vi.mocked(console.log).mockImplementation(epipe)
    expect(() => log.info('app ready')).not.toThrow()
    expect(() => log.debug('verbose')).not.toThrow()
  })

  it('does not throw when stderr is closed', () => {
    vi.mocked(console.error).mockImplementation(epipe)
    vi.mocked(console.warn).mockImplementation(epipe)
    expect(() => log.error('boom')).not.toThrow()
    expect(() => log.warn('careful')).not.toThrow()
  })

  it('swallows any console failure, not only EPIPE', () => {
    vi.mocked(console.log).mockImplementation(() => {
      throw new Error('some unrelated console failure')
    })
    expect(() => log.info('still fine')).not.toThrow()
  })

  it('keeps logging normally when the console works', () => {
    log.info('app ready', { profileId: 'abc' })
    expect(console.log).toHaveBeenCalledTimes(1)
    const entry = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string)
    expect(entry.level).toBe('info')
    expect(entry.message).toBe('app ready')
    expect(entry.meta).toEqual({ profileId: 'abc' })
    expect(typeof entry.ts).toBe('string')
  })

  it('routes each level to the right stream', () => {
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(console.log).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('still redacts secrets after the change', () => {
    log.info('connect', { access_token: 'xoxb-secret', team: 'acme' })
    const entry = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string)
    expect(entry.meta.access_token).toBe('[REDACTED]')
    expect(entry.meta.team).toBe('acme')
  })
})
