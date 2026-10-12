type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const TOKEN_PATTERNS = [/xox[a-zA-Z]-[A-Za-z0-9-]+/g, /Bearer\s+[A-Za-z0-9._~+/=-]+/gi]

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    let redacted = value
    for (const pattern of TOKEN_PATTERNS) {
      redacted = redacted.replace(pattern, '[REDACTED]')
    }
    return redacted
  }

  if (Array.isArray(value)) {
    return value.map(redact)
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization/i.test(key)) {
        out[key] = '[REDACTED]'
      } else {
        out[key] = redact(nested)
      }
    }
    return out
  }

  return value
}

/**
 * Console writes throw EPIPE whenever stdout is closed — a background launch, a
 * pipe to a process that already exited, a daemonised start, or some CI setups.
 *
 * That must never take down the main process: the first log line after the pipe
 * closes would otherwise raise an uncaught exception and kill the app. Logging
 * is best-effort, so a failed write is dropped.
 */
function safeWrite(level: LogLevel, line: string): void {
  try {
    if (level === 'error') {
      console.error(line)
    } else if (level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  } catch {
    /* stdout/stderr closed — drop the line rather than crash */
  }
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  const entry = {
    level,
    message,
    ...(meta !== undefined ? { meta: redact(meta) } : {}),
    ts: new Date().toISOString()
  }
  safeWrite(level, JSON.stringify(entry))
}

export const log = {
  debug: (message: string, meta?: unknown): void => write('debug', message, meta),
  info: (message: string, meta?: unknown): void => write('info', message, meta),
  warn: (message: string, meta?: unknown): void => write('warn', message, meta),
  error: (message: string, meta?: unknown): void => write('error', message, meta)
}
