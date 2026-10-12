import { describe, expect, it } from 'vitest'
import { log } from '../../src/main/logging'

describe('logging redaction', () => {
  it('does not throw when logging token-like strings', () => {
    expect(() =>
      log.info('token check', {
        Authorization: 'Bearer xoxp-should-not-leak',
        note: 'xoxp-1234567890-abcdefgh'
      })
    ).not.toThrow()
  })
})
