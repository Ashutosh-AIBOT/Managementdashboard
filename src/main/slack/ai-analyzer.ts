import { log } from '../logging'

export type Sentiment = 'positive' | 'neutral' | 'negative'

export interface AiMessageResult {
  sentiment: Sentiment
  score: number
  completionHint?: string
}

/** The one message shape every provider accepts. */
export interface AiInputMessage {
  ts: string
  text: string
}

/**
 * What one `analyzeBatch` call produced.
 *
 * `results` and `eligible` are separate because a caller has to tell apart
 * states that all look like "no results". Combined with
 * {@link AiAnalyzer.isAvailable}, they give every state the UI needs:
 *
 * | State | Condition | What the UI should do |
 * | --- | --- | --- |
 * | No key configured | `!isAvailable()` | Admin prompt to set `OPENAI_API_KEY`. Not a retry. |
 * | Nothing to analyse | `eligible === 0` | Not an error and not a retry — the channel is simply quiet. |
 * | Failing | `eligible > 0 && results.size === 0` | Silent retry, or a low-key indicator. |
 * | Degraded | `0 < results.size < eligible` | Render sentiment from what exists; retry the rest. |
 * | Healthy | `results.size >= eligible` | Render normally. |
 *
 * **Degraded is a normal outcome, not a failure.** The model may omit rows, and a
 * batch may stop early on a rejected key, so `results.size` legitimately sits
 * between 0 and `eligible` on a working system. Any gap must not be treated as
 * an error.
 *
 * The unavailable state is `!isAvailable()` alone. Keying it on an empty result
 * set instead makes a channel with no messages look permanently broken, and the
 * UI would retry silently and forever with nothing to retry.
 */
export interface AiBatchOutcome {
  /** Labelled messages keyed by `ts`. Empty whenever analysis produced nothing. */
  results: Map<string, AiMessageResult>
  /** Messages that had text worth sending, regardless of whether analysis worked. */
  eligible: number
}

/**
 * Labels come back keyed by the `ts` the model echoed, never by array position.
 * A positional contract silently assumes the reply has one row per message, in
 * order; when the model omits a row from the middle, every label after it lands
 * on the wrong message and nothing in the reply contradicts the guess. Keying by
 * `ts` makes that failure impossible to express.
 */
export interface AiProvider {
  analyze(messages: AiInputMessage[]): Promise<Map<string, AiMessageResult>>
}

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const DEFAULT_MODEL = 'gpt-4o-mini'

/**
 * Slack messages run longer than this all the time — pasted stack traces,
 * incident threads, someone quoting a log file. This is the only bound on what
 * one message can cost, so it is applied to the text that is actually sent.
 */
const MAX_MESSAGE_CHARS = 1000

/**
 * Upper bound on messages per request. A first sync across a large workspace can
 * hand this thousands of messages; sent as one request that is a single
 * multi-megabyte body which stalls — and takes every message in the batch down
 * with it. 100 capped messages is a ~100 KB body worst case, small enough that
 * one request cannot swallow a whole sync.
 */
export const MAX_BATCH_MESSAGES = 100

const SENTIMENTS: readonly string[] = ['positive', 'neutral', 'negative']

/**
 * JSON mode (`response_format: json_object`) forces a JSON *object*, so the
 * array the prompt asks for is wrapped under a `results` key.
 *
 * Each returned object has to carry the `ts` it was given. Without it the only
 * way to match a label back to its message is by array position, which shifts
 * every label after any row the model omits.
 */
const SYSTEM_PROMPT = [
  'You label Slack messages. Reply with a JSON object and nothing else:',
  '{"results":[ ...one object per input message... ]}',
  'Each object MUST start with the ts of the message it labels, copied exactly:',
  '{"ts":"<the ts you were given>","sentiment":"positive|neutral|negative",',
  '"score":<number -1..1>,',
  '"completionHint":"<max 15 words, only when the message implies a task finished>"}'
].join(' ')

interface OpenAiCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>
}

/**
 * A fresh object per call, never a shared constant: one map entry per message
 * means a single shared default would be stored N times, and one consumer
 * mutating it would corrupt every entry.
 */
function neutralResult(): AiMessageResult {
  return { sentiment: 'neutral', score: 0 }
}

/**
 * One unusable row must not shift every label after it, so a row is replaced
 * in place by the neutral default rather than filtered out.
 */
function toResult(row: unknown): AiMessageResult {
  if (!row || typeof row !== 'object') return neutralResult()
  const { sentiment, score, completionHint } = row as Record<string, unknown>

  if (typeof sentiment !== 'string' || !SENTIMENTS.includes(sentiment)) return neutralResult()

  const raw = typeof score === 'number' && Number.isFinite(score) ? score : 0
  const hint =
    typeof completionHint === 'string' && completionHint.trim() !== ''
      ? completionHint.trim()
      : undefined

  return {
    sentiment: sentiment as Sentiment,
    score: Math.max(-1, Math.min(1, raw)),
    ...(hint === undefined ? {} : { completionHint: hint })
  }
}

/**
 * The `{"results":[…]}` wrapper the system prompt asks for is the only shape
 * accepted. A reply without it carries no labels at all, so it is a failure.
 *
 * Labels are keyed by the `ts` the model echoed, never by array position. The
 * reply is free to omit rows, reorder them, or repeat one, and none of that can
 * move a label onto the wrong message. A row is dropped — not guessed at — when
 * its `ts` is missing, is not a string, is repeated, or is not one this batch
 * sent. Short replies are therefore just replies missing some labels, which is
 * a partial result rather than a failure.
 */
function readResults(content: string): Map<string, AiMessageResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('OpenAI response was not valid JSON')
  }

  const rows = (parsed as { results?: unknown } | null)?.results
  if (!Array.isArray(rows)) {
    throw new Error('OpenAI response did not contain a results array')
  }

  const out = new Map<string, AiMessageResult>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const ts = (row as { ts?: unknown }).ts
    if (typeof ts !== 'string' || ts === '') continue
    // Two labels for one message is a model that lost track of its own output.
    // Keeping the first is arbitrary but deterministic; picking a winner would
    // not be.
    if (out.has(ts)) continue
    out.set(ts, toResult(row))
  }
  return out
}

/**
 * A credential the provider rejected.
 *
 * Distinct from a generic failure because it is permanent: a revoked key will
 * be rejected by every remaining chunk too, so `AiAnalyzer` stops rather than
 * spending one futile request — and one warn line — per chunk. A rate limit is
 * deliberately not this: a later chunk can still succeed, so it must not
 * short-circuit.
 */
export class AiAuthError extends Error {
  constructor(public readonly status: number) {
    super(`AI provider rejected the API key with status ${status}`)
    this.name = 'AiAuthError'
  }
}

export class OpenAiProvider implements AiProvider {
  private readonly apiKey: string
  private readonly model: string

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
  }

  async analyze(messages: AiInputMessage[]): Promise<Map<string, AiMessageResult>> {
    if (messages.length === 0) return new Map()

    const res = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              messages: messages.map((m) => ({
                ts: m.ts,
                text: m.text.slice(0, MAX_MESSAGE_CHARS)
              }))
            })
          }
        ]
      })
    })

    // Only the status is ever surfaced — never the key, and never the raw body,
    // because logging.ts does not redact `sk-`.
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new AiAuthError(res.status)
      }
      throw new Error(`OpenAI request failed with status ${res.status}`)
    }

    const body = (await res.json()) as OpenAiCompletionResponse
    const content = body.choices?.[0]?.message?.content
    // No text content is a protocol violation like any other malformed reply,
    // so it is reported rather than silently read as "the model found nothing".
    if (typeof content !== 'string') {
      throw new Error('OpenAI response carried no message content')
    }

    return readResults(content)
  }
}

/**
 * The dashboard's seam for AI labelling.
 *
 * Every failure mode here is non-fatal by design: no provider configured, a
 * provider that throws, a provider that breaks its own contract, a model that
 * returns junk. None of them stop the caller from rendering real Slack metrics
 * and marking only the AI sections unavailable; they show up as an empty or
 * short `results`, never as a throw. Swapping providers is a one-file change —
 * this class knows only `AiProvider`.
 */
export class AiAnalyzer {
  private readonly provider: AiProvider | null

  constructor(opts: { provider?: AiProvider | null }) {
    this.provider = opts.provider ?? null
  }

  /**
   * Whether a provider is wired at all — a configuration question, not a health
   * one. It stays `true` when every batch comes back empty because the key was
   * revoked or the network is down.
   *
   * On its own it is not enough to drive an "AI unavailable" state. A caller
   * needs this *and* the `AiBatchOutcome`: `eligible === 0` means there was
   * nothing to analyse rather than something to retry.
   */
  isAvailable(): boolean {
    return this.provider !== null
  }

  async analyzeBatch(texts: AiInputMessage[]): Promise<AiBatchOutcome> {
    const eligible = texts.filter((t) => t.text.trim() !== '')
    if (eligible.length === 0) return { results: new Map(), eligible: 0 }

    // Filtered first so `eligible` always means the same thing — messages with
    // text worth sending — whether or not a provider exists to send them to.
    const provider = this.provider
    if (!provider) return { results: new Map(), eligible: eligible.length }

    const out = new Map<string, AiMessageResult>()
    for (let i = 0; i < eligible.length; i += MAX_BATCH_MESSAGES) {
      const chunk = eligible.slice(i, i + MAX_BATCH_MESSAGES)
      // Consuming the result is inside the try on purpose. The provider is a
      // pluggable seam, so a swapped-in one that breaks its contract must still
      // not throw out of here — and a chunk that fails costs only its own
      // messages, never the chunks that already succeeded.
      try {
        const results = await provider.analyze(chunk)
        if (!(results instanceof Map)) {
          log.warn('ai: provider returned a non-map; skipping this chunk', { size: chunk.length })
          continue
        }
        // A provider is trusted to key by ts, not to key by *this* batch's ts.
        // Anything it invents is dropped rather than written against a message
        // that was never sent.
        const inChunk = new Set(chunk.map((m) => m.ts))
        for (const [ts, result] of results) {
          if (inChunk.has(ts)) out.set(ts, result)
        }
      } catch (err) {
        const auth = err instanceof AiAuthError
        log.warn(
          auth
            ? 'ai: key rejected, skipping the rest of the batch'
            : 'ai: batch analysis failed, continuing without AI results',
          { reason: err instanceof Error ? err.message : 'unknown' }
        )
        // A rejected key is rejected by every chunk still to come. Stopping here
        // is the difference between one futile request and one per chunk — a
        // 20k-message first sync is ~200 chunks.
        if (auth) break
      }
    }
    return { results: out, eligible: eligible.length }
  }
}
