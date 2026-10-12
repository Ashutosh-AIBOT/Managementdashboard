import { describe, expect, it } from 'vitest'
import {
  chromeCandidatesFor,
  resolveChromeExecutable
} from '../../src/main/profiles/chrome-resolution'

/**
 * The pre-Linux list, copied verbatim from the code as it shipped.
 * If this ever changes, a macOS user could silently switch browser builds.
 */
const ORIGINAL_MAC_LIST = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
]

describe('chromeCandidatesFor', () => {
  it('keeps the macOS list byte-identical to what shipped before', () => {
    expect(chromeCandidatesFor('darwin')).toEqual(ORIGINAL_MAC_LIST)
  })

  it('never returns a macOS path on Linux', () => {
    for (const candidate of chromeCandidatesFor('linux')) {
      expect(candidate.startsWith('/Applications/')).toBe(false)
    }
  })

  it('never returns a macOS path on win32', () => {
    for (const candidate of chromeCandidatesFor('win32')) {
      expect(candidate.startsWith('/Applications/')).toBe(false)
      expect(candidate.endsWith('.exe')).toBe(true)
    }
  })

  it('covers the common Linux install locations', () => {
    const linux = chromeCandidatesFor('linux')
    expect(linux).toContain('/usr/bin/google-chrome')
    expect(linux).toContain('/usr/bin/google-chrome-stable')
    expect(linux).toContain('/usr/bin/chromium')
    expect(linux).toContain('/usr/bin/chromium-browser')
  })

  it('prefers real Chrome over Chromium on Linux', () => {
    const linux = chromeCandidatesFor('linux')
    const chrome = linux.findIndex((p) => p.includes('google-chrome'))
    const chromium = linux.findIndex((p) => p.includes('chromium'))
    expect(chrome).toBeGreaterThanOrEqual(0)
    expect(chromium).toBeGreaterThanOrEqual(0)
    expect(chrome).toBeLessThan(chromium)
  })

  it('falls back to the Linux list for unknown platforms', () => {
    expect(chromeCandidatesFor('freebsd')).toEqual(chromeCandidatesFor('linux'))
  })
})

describe('resolveChromeExecutable', () => {
  const only = (...paths: string[]) => {
    const set = new Set(paths)
    return (candidate: string) => set.has(candidate)
  }

  it('returns the first existing candidate in list order', () => {
    const found = resolveChromeExecutable(
      'darwin',
      only(ORIGINAL_MAC_LIST[1], ORIGINAL_MAC_LIST[2])
    )
    expect(found).toBe(ORIGINAL_MAC_LIST[1])
  })

  it('returns null when nothing is installed', () => {
    expect(resolveChromeExecutable('darwin', () => false)).toBeNull()
    expect(resolveChromeExecutable('linux', () => false)).toBeNull()
    expect(resolveChromeExecutable('win32', () => false)).toBeNull()
  })

  it('does not resolve a macOS install when running on Linux', () => {
    const macOnly = only(...ORIGINAL_MAC_LIST)
    expect(resolveChromeExecutable('linux', macOnly)).toBeNull()
    expect(resolveChromeExecutable('darwin', macOnly)).toBe(ORIGINAL_MAC_LIST[0])
  })

  it('resolves Chromium on Linux when that is what is installed', () => {
    expect(resolveChromeExecutable('linux', only('/usr/bin/chromium'))).toBe('/usr/bin/chromium')
  })

  it('never returns a foreign-platform path', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      const all = [
        ...chromeCandidatesFor('darwin'),
        ...chromeCandidatesFor('linux'),
        ...chromeCandidatesFor('win32')
      ]
      const found = resolveChromeExecutable(platform, only(...all))
      expect(found === null || chromeCandidatesFor(platform).includes(found)).toBe(true)
    }
  })

  it('defaults to the running platform', () => {
    // Real filesystem, no injection. Never throws on any platform.
    const found = resolveChromeExecutable()
    if (found !== null) {
      expect(chromeCandidatesFor(process.platform)).toContain(found)
    }
  })
})
