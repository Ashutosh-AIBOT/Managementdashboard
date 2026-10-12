import { existsSync } from 'node:fs'

/**
 * Chrome/Chromium executable resolution.
 *
 * Pure and Electron-free on purpose. `chrome-system-login.ts` imports `electron`
 * at module load, so anything worth testing has to live here instead — same
 * split as `session-partition.ts`.
 */

/**
 * Chrome/Chromium launch paths per platform.
 *
 * The macOS list is order-sensitive and MUST NOT change: it is the sequence
 * that shipped before Linux support was added, and reordering it can silently
 * switch a user from Chrome to Chromium. `tests/unit/chrome-resolution.test.ts`
 * pins it byte-for-byte so a regression fails CI rather than reaching a user.
 */
const MAC_CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
]

const LINUX_CHROME_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium'
]

const WIN32_CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe'
]

/** Candidate list for a platform. Unknown platforms fall back to the Linux list. */
export function chromeCandidatesFor(platform: NodeJS.Platform): readonly string[] {
  if (platform === 'darwin') return MAC_CHROME_CANDIDATES
  if (platform === 'win32') return WIN32_CHROME_CANDIDATES
  return LINUX_CHROME_CANDIDATES
}

/**
 * First existing Chrome/Chromium binary for this platform, or null.
 *
 * `platform` and `exists` are injectable so resolution order can be tested
 * without depending on what happens to be installed on the machine running the
 * tests. Production callers use the defaults, which preserve the previous
 * behaviour exactly on macOS.
 */
export function resolveChromeExecutable(
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = existsSync
): string | null {
  for (const candidate of chromeCandidatesFor(platform)) {
    if (exists(candidate)) {
      return candidate
    }
  }
  return null
}
