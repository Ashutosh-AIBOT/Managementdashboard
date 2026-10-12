import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiAnalyzer,
  MAX_BATCH_MESSAGES,
  OpenAiProvider,
  type AiBatchOutcome,
  type AiMessageResult,
  type AiProvider
} from '../../src/main/slack/ai-analyzer'

/**
 * Every test here mocks `fetch` at the module boundary. No test may reach the
 * network: the analyzer's whole promise is that a dead AI degrades to "no AI
 * data", and a test that actually called api.openai.com could not tell that
 * apart from a genuine failure.
 */

const MESSAGES = [
  { ts: '1700000001.0', text: 'deploy is green' },
  { ts: '1700000002.0', text: 'still broken' }
]

const SINGLE = [{ ts: '1.0', text: 'deploy is green' }]

/** Nothing was eligible, so there was nothing to say about analysis succeeding. */
function nothingToDo(): AiBatchOutcome {
  return { results: new Map(), eligible: 0 }
}

function analyzerWith(provider: AiProvider): AiAnalyzer {
  return new AiAnalyzer({ provider })
}

/** A provider that records what it was asked about and returns fixed labels. */
function recordingProvider(
  results: Map<string, AiMessageResult>
): AiProvider & { calls: string[][] } {
  const provider = {
    calls: [] as string[][],
    analyze: vi.fn(async (messages: Array<{ ts: string; text: string }>) => {
      provider.calls.push(messages.map((m) => m.text))
      return results
    })
  }
  return provider
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body
  } as unknown as Response
}

/** OpenAI chat-completion envelope wrapping raw assistant `content`. */
function completionResponse(content: string, status = 200): Response {
  return jsonResponse({ choices: [{ message: { content } }] }, status)
}

/** A well-formed JSON-mode reply: the wrapper the system prompt actually asks for. */
function results(rows: unknown[]): Response {
  return completionResponse(JSON.stringify({ results: rows }))
}

/** A labelled row, keyed to the message it belongs to. */
function labelled(ts: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts, sentiment: 'neutral', score: 0, ...extra }
}

/** The same labels the mock `sentBatch` reports, echoed back with their `ts`. */
function echoLabels(sent: Array<{ ts: string }>, extra: Record<string, unknown> = {}): Response {
  return results(sent.map((m) => labelled(m.ts, extra)))
}

function requestBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as { body: string }).body)) as Record<string, unknown>
}

function chatMessages(call: unknown[]): Array<{ role: string; content: string }> {
  return requestBody(call).messages as Array<{ role: string; content: string }>
}

/** The user turn carries the batch as JSON; parse it back out of the request. */
function sentBatch(call: unknown[]): Array<{ ts: string; text: string }> {
  const user = chatMessages(call).find((m) => m.role === 'user')
  return JSON.parse(String(user?.content)).messages
}

function messages(count: number): Array<{ ts: string; text: string }> {
  return Array.from({ length: count }, (_, i) => ({ ts: `${i}.0`, text: `m${i}` }))
}

/** Silence and count the analyzer's warnings — "how many log lines" is a claim. */
function spyOnWarnings(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AiAnalyzer binds labels by the ts the model echoes', () => {
  /**
   * Binding by array position assumes the model returns exactly one row per
   * message, in order. It does not have to, and when it drops a row from the
   * middle every label after it lands on the wrong message — silently, because
   * the reply carries no `ts` to contradict the guess. Each fixture below gives
   * every row a distinct score so a misbinding cannot hide.
   */
  it('does not shift labels when a row is missing from the middle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        completionResponse(
          JSON.stringify({
            results: [
              { ts: '0.0', sentiment: 'positive', score: 0.1 },
              { ts: '2.0', sentiment: 'positive', score: 0.2 },
              { ts: '3.0', sentiment: 'negative', score: 0.3 }
            ]
          })
        )
      )
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(messages(4))

    expect(out.results.size).toBe(3)
    expect(out.results.get('0.0')).toEqual({ sentiment: 'positive', score: 0.1 })
    expect(out.results.get('2.0')).toEqual({ sentiment: 'positive', score: 0.2 })
    expect(out.results.get('3.0')).toEqual({ sentiment: 'negative', score: 0.3 })
    expect(out.results.has('1.0')).toBe(false)
    expect(out.eligible).toBe(4)
  })

  it('keeps the first label when a ts is duplicated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        completionResponse(
          JSON.stringify({
            results: [
              { ts: '0.0', sentiment: 'positive', score: 0.1 },
              { ts: '0.0', sentiment: 'negative', score: 0.9 },
              { ts: '1.0', sentiment: 'neutral', score: 0 }
            ]
          })
        )
      )
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(messages(2))

    expect(out.results.size).toBe(2)
    expect(out.results.get('0.0')).toEqual({ sentiment: 'positive', score: 0.1 })
    expect(out.results.get('1.0')).toEqual({ sentiment: 'neutral', score: 0 })
  })

  it('drops a row whose ts is not in the batch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        completionResponse(
          JSON.stringify({
            results: [
              { ts: '0.0', sentiment: 'positive', score: 0.1 },
              { ts: '999.0', sentiment: 'negative', score: 0.9 }
            ]
          })
        )
      )
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(messages(2))

    expect(out.results.size).toBe(1)
    expect(out.results.get('0.0')).toEqual({ sentiment: 'positive', score: 0.1 })
    expect(out.results.has('1.0')).toBe(false)
  })

  it('drops a row whose ts is not a string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        completionResponse(
          JSON.stringify({
            results: [
              { ts: 0, sentiment: 'positive', score: 0.1 },
              { ts: '1.0', sentiment: 'positive', score: 0.2 }
            ]
          })
        )
      )
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(messages(2))

    expect(out.results.size).toBe(1)
    expect(out.results.get('1.0')).toEqual({ sentiment: 'positive', score: 0.2 })
  })

  /**
   * The round-2 guarantee has to survive the change of binding: a truncated tail
   * is still a short response, not a misaligned one.
   */
  it('still keeps 99 of 100 labels when only the last row is missing', async () => {
    const rows = Array.from({ length: MAX_BATCH_MESSAGES - 1 }, (_, i) => ({
      ts: `${i}.0`,
      sentiment: 'positive',
      score: 0.7
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(results(rows)))
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(messages(MAX_BATCH_MESSAGES))

    expect(out.results.size).toBe(MAX_BATCH_MESSAGES - 1)
    expect(out.results.get('0.0')).toEqual({ sentiment: 'positive', score: 0.7 })
    expect(out.results.has(`${MAX_BATCH_MESSAGES - 1}.0`)).toBe(false)
  })
})

describe('AiAnalyzer with no provider', () => {
  /**
   * Review Focus 4: no OPENAI_API_KEY is configured on this machine, so the
   * AI-off path is the *initial* product state, not an edge case. An
   * unavailable analyzer has to hand back an empty map, not throw, because every
   * caller is on the path that paints real Slack metrics.
   */
  it('returns an empty outcome and does not throw when the provider is null', async () => {
    const analyzer = new AiAnalyzer({ provider: null })

    await expect(analyzer.analyzeBatch(MESSAGES)).resolves.toEqual({
      results: new Map(),
      eligible: MESSAGES.length
    })
  })

  it('reports itself unavailable so the UI can hide only the AI sections', () => {
    expect(new AiAnalyzer({ provider: null }).isAvailable()).toBe(false)
    expect(new AiAnalyzer({}).isAvailable()).toBe(false)
  })

  it('never calls a provider for an empty batch', async () => {
    const provider = recordingProvider(new Map())

    await expect(analyzerWith(provider).analyzeBatch([])).resolves.toEqual(nothingToDo())

    expect(provider.analyze).not.toHaveBeenCalled()
  })
})

describe('AiAnalyzer when the provider misbehaves', () => {
  /**
   * Review Focus 4, second half. A network error, a revoked key or a rate limit
   * must not propagate: Slack metrics are real data and may never be gated on
   * the AI being reachable.
   */
  it('returns an empty result set when the provider rejects', async () => {
    const provider: AiProvider = {
      analyze: vi.fn(async () => {
        throw new Error('fetch failed')
      })
    }

    const out = await analyzerWith(provider).analyzeBatch(MESSAGES)

    expect(out.results).toEqual(new Map())
    expect(out.eligible).toBe(MESSAGES.length)
  })

  it('returns an empty result set when the OpenAI request fails at the fetch boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(MESSAGES)

    expect(out.results).toEqual(new Map())
    expect(out.eligible).toBe(MESSAGES.length)
  })

  it('returns an empty result set on a non-2xx OpenAI response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500)))
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(MESSAGES)

    expect(out.results).toEqual(new Map())
    expect(out.eligible).toBe(MESSAGES.length)
  })

  /**
   * Covers the JSON.parse catch specifically — the text here is prose, not JSON,
   * so it never reaches the wrapper handling. The wrong-wrapper shapes are
   * covered separately below, where the content does parse.
   */
  it('returns an empty result set when the model returns unparseable output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(completionResponse('sorry, here is a JSON array: [{'))
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(MESSAGES)

    expect(out.results).toEqual(new Map())
  })

  /**
   * The seam exists so providers can be swapped. A swapped-in provider that
   * breaks its own contract must still not break the caller: the results are
   * consumed inside the analyzer, so consuming a non-array cannot throw out of
   * `analyzeBatch`.
   */
  it('returns an empty result set when a provider resolves with a non-array', async () => {
    const provider: AiProvider = {
      analyze: vi.fn(async () => 'positive' as unknown as Map<string, AiMessageResult>)
    }

    const out = await analyzerWith(provider).analyzeBatch(MESSAGES)

    expect(out.results).toEqual(new Map())
  })

  it('returns an empty result set when a provider resolves with null', async () => {
    const provider: AiProvider = {
      analyze: vi.fn(async () => null as unknown as Map<string, AiMessageResult>)
    }

    const out = await analyzerWith(provider).analyzeBatch(MESSAGES)

    expect(out.results).toEqual(new Map())
  })
})

describe('AiAnalyzer when the model returns an unexpected shape', () => {
  /**
   * These all parse as JSON, so they get past `JSON.parse` and land on the
   * wrapper handling. The requirement is the same as for unparseable output: no
   * map entries, rather than a full map of invented neutral labels that the
   * dashboard would render as real analysis.
   */
  it('returns nothing when the rows are wrapped under an unexpected key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        completionResponse(
          JSON.stringify({
            labels: [
              { sentiment: 'positive', score: 0.9 },
              { sentiment: 'negative', score: -0.9 }
            ]
          })
        )
      )
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(MESSAGES)

    expect(out.results).toEqual(new Map())
    expect(out.eligible).toBe(2)
  })

  it('returns nothing when the model returns a bare top-level array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        completionResponse(
          JSON.stringify([
            { sentiment: 'positive', score: 0.9 },
            { sentiment: 'negative', score: -0.9 }
          ])
        )
      )
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(MESSAGES)

    expect(out.results).toEqual(new Map())
  })

  it('returns nothing when the wrapper key holds a non-array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(completionResponse(JSON.stringify({ results: 'positive' })))
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(MESSAGES)

    expect(out.results).toEqual(new Map())
  })

  /**
   * A short response still labelled most of the batch. Those labels are real
   * work and must survive; only the messages the model never labelled are
   * omitted, because padding them with a neutral default would present an
   * invented label as a real one.
   */
  it('keeps the rows a short response did label and omits only the missing ones', async () => {
    const rows = Array.from({ length: MAX_BATCH_MESSAGES - 1 }, (_, i) =>
      labelled(`${i}.0`, { sentiment: 'positive', score: 0.7 })
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(results(rows)))
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(messages(MAX_BATCH_MESSAGES))

    expect(out.results.size).toBe(MAX_BATCH_MESSAGES - 1)
    expect(out.results.get('0.0')).toEqual({ sentiment: 'positive', score: 0.7 })
    expect(out.results.has(`${MAX_BATCH_MESSAGES - 1}.0`)).toBe(false)
    expect(out.eligible).toBe(MAX_BATCH_MESSAGES)
  })

  it('omits only the unlabelled message when a two-message batch gets one row', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          results([labelled('1700000001.0', { sentiment: 'positive', score: 0.9 })])
        )
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(MESSAGES)

    expect(out.results.size).toBe(1)
    expect(out.results.get('1700000001.0')).toEqual({ sentiment: 'positive', score: 0.9 })
    expect(out.results.has('1700000002.0')).toBe(false)
  })

  /**
   * A row the model labelled correctly but that we cannot use (unknown
   * sentiment, say) still becomes its own neutral entry. If every entry were the
   * same shared object, one consumer mutating it would corrupt the whole map.
   */
  it('gives each fallback entry its own object rather than sharing one default', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          results([
            labelled('1700000001.0', { sentiment: 'elated', score: 1 }),
            labelled('1700000002.0', { sentiment: 'elated', score: 1 })
          ])
        )
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const values = [...(await analyzer.analyzeBatch(MESSAGES)).results.values()]

    expect(values).toHaveLength(2)
    expect(values[0]).not.toBe(values[1])
    values[0].score = 99
    expect(values[1].score).toBe(0)
  })
})

describe('AiAnalyzer batching', () => {
  /**
   * A first sync across a large workspace can hand this thousands of messages.
   * Sent as one request that is a single multi-megabyte body which fails or
   * takes minutes — and, worse, takes every message in the batch down with it.
   * The batch is therefore split, and each chunk is settled independently.
   */
  it('splits an oversized batch across several requests and returns every result', async () => {
    const count = MAX_BATCH_MESSAGES * 2 + 7
    const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init: unknown) => {
      const sent = sentBatch([_url, init])
      return echoLabels(sent, { sentiment: 'positive', score: 0.5 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await analyzerWith(new OpenAiProvider({ apiKey: 'k' })).analyzeBatch(
      messages(count)
    )

    expect(fetchMock.mock.calls.length).toBe(Math.ceil(count / MAX_BATCH_MESSAGES))
    for (const call of fetchMock.mock.calls) {
      expect(sentBatch(call as unknown[]).length).toBeLessThanOrEqual(MAX_BATCH_MESSAGES)
    }
    expect(out.results.size).toBe(count)
  })

  it('keeps the results of chunks that succeeded when a later chunk fails', async () => {
    const count = MAX_BATCH_MESSAGES + 1
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        results(
          Array.from({ length: MAX_BATCH_MESSAGES }, (_, i) =>
            labelled(`${i}.0`, { sentiment: 'positive', score: 1 })
          )
        )
      )
      .mockRejectedValueOnce(new Error('ECONNRESET'))
    vi.stubGlobal('fetch', fetchMock)

    const out = await analyzerWith(new OpenAiProvider({ apiKey: 'k' })).analyzeBatch(
      messages(count)
    )

    expect(out.results.size).toBe(MAX_BATCH_MESSAGES)
    expect(out.results.get('0.0')).toEqual({ sentiment: 'positive', score: 1 })
    expect(out.results.has(`${MAX_BATCH_MESSAGES}.0`)).toBe(false)
  })

  /**
   * The mirror of the test above: isolation is a property of a chunk, not of its
   * position. A first-chunk failure must not cost the chunks after it.
   */
  it('keeps the results of later chunks when the first chunk fails', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockImplementation(async (_url: unknown, init: unknown) => {
        const sent = sentBatch([_url, init])
        return echoLabels(sent, { sentiment: 'positive', score: 1 })
      })
    vi.stubGlobal('fetch', fetchMock)

    const out = await analyzerWith(new OpenAiProvider({ apiKey: 'k' })).analyzeBatch(
      messages(MAX_BATCH_MESSAGES + 1)
    )

    expect(out.results.size).toBe(1)
    expect(out.results.has('0.0')).toBe(false)
    expect(out.results.get(`${MAX_BATCH_MESSAGES}.0`)).toEqual({
      sentiment: 'positive',
      score: 1
    })
  })

  it('still sends one request for a batch that fits in a single chunk', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init: unknown) => {
      const sent = sentBatch([_url, init])
      return echoLabels(sent, { sentiment: 'neutral', score: 0 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await analyzerWith(new OpenAiProvider({ apiKey: 'k' })).analyzeBatch(
      messages(MAX_BATCH_MESSAGES)
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.results.size).toBe(MAX_BATCH_MESSAGES)
  })

  /**
   * A revoked key is rejected by every chunk that follows, so a multi-chunk
   * batch would otherwise spend one futile request — and one warn line — per
   * chunk. A 20k-message first sync is ~200 chunks.
   */
  it('stops after the first chunk when the key is rejected', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 401))
    const warn = spyOnWarnings()
    vi.stubGlobal('fetch', fetchMock)

    const out = await analyzerWith(new OpenAiProvider({ apiKey: 'k' })).analyzeBatch(
      messages(MAX_BATCH_MESSAGES * 3)
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual(new Map())
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps going after a 429, because a later chunk can still succeed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429))
      .mockImplementation(async (_url: unknown, init: unknown) => {
        const sent = sentBatch([_url, init])
        return echoLabels(sent, { sentiment: 'positive', score: 1 })
      })
    vi.stubGlobal('fetch', fetchMock)

    const out = await analyzerWith(new OpenAiProvider({ apiKey: 'k' })).analyzeBatch(
      messages(MAX_BATCH_MESSAGES + 1)
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(out.results.size).toBe(1)
  })
})

describe('AiAnalyzer results', () => {
  it('keys results by message ts', async () => {
    const provider = recordingProvider(
      new Map([
        ['1700000001.0', { sentiment: 'positive', score: 0.8 }],
        ['1700000002.0', { sentiment: 'negative', score: -0.6, completionHint: 'rollback shipped' }]
      ])
    )

    const out = await analyzerWith(provider).analyzeBatch(MESSAGES)

    expect(out.results.get('1700000001.0')).toEqual({ sentiment: 'positive', score: 0.8 })
    expect(out.results.get('1700000002.0')).toEqual({
      sentiment: 'negative',
      score: -0.6,
      completionHint: 'rollback shipped'
    })
    expect(out.results.size).toBe(2)
  })

  it('is available once a provider is wired in', () => {
    expect(analyzerWith(recordingProvider(new Map())).isAvailable()).toBe(true)
  })

  /**
   * `isAvailable()` is a configuration question, not a health question. It
   * answers "is a provider wired", so it stays true while every batch returns
   * nothing. Task 7 therefore cannot use it to drive an "AI unavailable" badge
   * on its own.
   */
  it('stays available after every batch fails', async () => {
    const provider: AiProvider = {
      analyze: vi.fn(async () => {
        throw new Error('401 invalid_api_key')
      })
    }
    const analyzer = analyzerWith(provider)

    expect((await analyzer.analyzeBatch(MESSAGES)).results).toEqual(new Map())

    expect(analyzer.isAvailable()).toBe(true)
  })
})

describe('AiAnalyzer reports how much was worth analysing', () => {
  /**
   * Task 8's unavailable rule is `!configured || results === 0`. With a channel
   * that has no messages worth sending, both of those are permanently true and
   * the UI would retry forever with nothing to retry. `eligible` is what tells
   * "nothing to analyse" apart from "analysis failed".
   */
  it('reports zero eligible when every message is blank', async () => {
    const provider = recordingProvider(new Map())

    const out = await analyzerWith(provider).analyzeBatch([
      { ts: '1.0', text: '' },
      { ts: '2.0', text: '   \n\t  ' }
    ])

    expect(out).toEqual(nothingToDo())
    expect(provider.analyze).not.toHaveBeenCalled()
  })

  it('counts only the messages that had text as eligible', async () => {
    const provider = recordingProvider(new Map([['2.0', { sentiment: 'positive', score: 0.1 }]]))

    const out = await analyzerWith(provider).analyzeBatch([
      { ts: '1.0', text: '' },
      { ts: '2.0', text: 'shipping it' },
      { ts: '3.0', text: '  ' }
    ])

    expect(out.eligible).toBe(1)
    expect(out.results.size).toBe(1)
  })

  it('counts eligible even when the analysis then failed', async () => {
    const provider: AiProvider = { analyze: vi.fn(async () => Promise.reject(new Error('down'))) }

    const out = await analyzerWith(provider).analyzeBatch([
      { ts: '1.0', text: '' },
      { ts: '2.0', text: 'shipping it' }
    ])

    // eligible describes the input, not the outcome: this is what separates
    // "the AI failed" from "there was nothing to analyse".
    expect(out.eligible).toBe(1)
    expect(out.results).toEqual(new Map())
  })

  /**
   * Task 7's IPC surface and Task 8's whole state table are built on exactly
   * these two fields. If either is dropped or renamed, nothing downstream
   * compiles — but nothing downstream would *notice* that the distinction went
   * with it. This is the guard for that.
   */
  it('exposes exactly the results and the analysable count', async () => {
    const provider = recordingProvider(
      new Map([['1700000002.0', { sentiment: 'positive', score: 0.1 }]])
    )

    const out = await analyzerWith(provider).analyzeBatch(MESSAGES)

    expect(Object.keys(out).sort()).toEqual(['eligible', 'results'])
    expect(out.eligible).toBe(2)
    expect(out.results.get('1700000002.0')).toEqual({ sentiment: 'positive', score: 0.1 })
  })
})

describe('AiAnalyzer input filtering', () => {
  /**
   * Asserted on the provider's call count, not on the result map: a blank
   * message that is sent and then silently dropped still costs tokens, and the
   * cost shows up on someone else's bill.
   */
  it('never sends messages whose text is empty after trimming', async () => {
    const provider = recordingProvider(new Map([['3.0', { sentiment: 'neutral', score: 0 }]]))

    await analyzerWith(provider).analyzeBatch([
      { ts: '1.0', text: '' },
      { ts: '2.0', text: '   \n\t  ' },
      { ts: '3.0', text: 'real content' }
    ])

    expect(provider.analyze).toHaveBeenCalledTimes(1)
    expect(provider.calls[0]).toEqual(['real content'])
  })

  it('does not call the provider when every message is blank', async () => {
    const provider = recordingProvider(new Map())

    await expect(
      analyzerWith(provider).analyzeBatch([
        { ts: '1.0', text: '' },
        { ts: '2.0', text: '  ' }
      ])
    ).resolves.toEqual(nothingToDo())

    expect(provider.analyze).not.toHaveBeenCalled()
  })

  /**
   * Filtering happens before the provider is called, so a map keyed by the
   * *filtered* ts has to come back under the same ts the caller passed in.
   */
  it('keys the map by the ts of the messages actually sent', async () => {
    const provider = recordingProvider(new Map([['2.0', { sentiment: 'positive', score: 0.1 }]]))

    const out = await analyzerWith(provider).analyzeBatch([
      { ts: '1.0', text: '' },
      { ts: '2.0', text: 'shipping it' }
    ])

    expect([...out.results.keys()]).toEqual(['2.0'])
  })
})

describe('OpenAiProvider request shape', () => {
  it('posts to the chat completions endpoint in JSON mode on the default model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(results([labelled('1.0')]))
    vi.stubGlobal('fetch', fetchMock)

    await new OpenAiProvider({ apiKey: 'k' }).analyze(SINGLE)

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.openai.com/v1/chat/completions')
    const body = requestBody(fetchMock.mock.calls[0] as unknown[])
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(chatMessages(fetchMock.mock.calls[0] as unknown[])[0].role).toBe('system')
  })

  it('honours an explicit model override', async () => {
    const fetchMock = vi.fn().mockResolvedValue(results([labelled('1.0')]))
    vi.stubGlobal('fetch', fetchMock)

    await new OpenAiProvider({ apiKey: 'k', model: 'gpt-4o' }).analyze(SINGLE)

    expect(requestBody(fetchMock.mock.calls[0] as unknown[]).model).toBe('gpt-4o')
  })

  it('authenticates with a bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(results([labelled('1.0')]))
    vi.stubGlobal('fetch', fetchMock)

    await new OpenAiProvider({ apiKey: 'k' }).analyze(SINGLE)

    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer k')
  })

  /**
   * 1000 chars caps what one Slack message can cost. Slack messages run longer
   * than that all the time (pasted stack traces, incident threads), and this is
   * the only place that bound exists.
   */
  it('truncates every message to 1000 characters before sending', async () => {
    const fetchMock = vi.fn().mockResolvedValue(results([labelled('1.0'), labelled('2.0')]))
    vi.stubGlobal('fetch', fetchMock)

    await new OpenAiProvider({ apiKey: 'k' }).analyze([
      { ts: '1.0', text: 'x'.repeat(2500) },
      { ts: '2.0', text: 'short' }
    ])

    const sent = sentBatch(fetchMock.mock.calls[0] as unknown[])
    expect(sent[0].text).toHaveLength(1000)
    expect(sent[0].text).toBe('x'.repeat(1000))
    expect(sent[1].text).toBe('short')
    expect(sent[0].ts).toBe('1.0')
  })

  it('parses the wrapped result array out of JSON mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        results([
          labelled('1.0', {
            sentiment: 'positive',
            score: 0.9,
            completionHint: 'shipped the fix'
          })
        ])
      )
    )

    const out = await new OpenAiProvider({ apiKey: 'k' }).analyze(SINGLE)

    expect(out.get('1.0')).toEqual({
      sentiment: 'positive',
      score: 0.9,
      completionHint: 'shipped the fix'
    })
  })

  it('ignores a row for a message that was never sent', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          results([labelled('1.0', { sentiment: 'positive', score: 0.9 }), labelled('999.0')])
        )
    )
    const analyzer = new AiAnalyzer({ provider: new OpenAiProvider({ apiKey: 'k' }) })

    const out = await analyzer.analyzeBatch(SINGLE)

    expect(out.results.size).toBe(1)
    expect(out.results.get('1.0')).toEqual({ sentiment: 'positive', score: 0.9 })
  })

  it('drops rows with an unknown sentiment rather than inventing one', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          results([
            labelled('1700000001.0', { sentiment: 'elated', score: 3 }),
            labelled('1700000002.0', { sentiment: 'ok' })
          ])
        )
    )

    const out = await new OpenAiProvider({ apiKey: 'k' }).analyze(MESSAGES)

    expect(out.get('1700000001.0')).toEqual({ sentiment: 'neutral', score: 0 })
    expect(out.get('1700000002.0')).toEqual({ sentiment: 'neutral', score: 0 })
  })

  it('clamps an out-of-range score and drops a blank completion hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          results([labelled('1.0', { sentiment: 'negative', score: -9, completionHint: ' ' })])
        )
    )

    const out = await new OpenAiProvider({ apiKey: 'k' }).analyze(SINGLE)

    expect(out.get('1.0')).toEqual({ sentiment: 'negative', score: -1 })
    expect(out.get('1.0')?.completionHint).toBeUndefined()
  })

  it('keeps a numeric score of zero instead of treating it as missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(results([labelled('1.0', { score: undefined })]))
    )

    const out = await new OpenAiProvider({ apiKey: 'k' }).analyze(SINGLE)

    expect(out.get('1.0')?.score).toBe(0)
  })

  /**
   * An envelope with no usable content is a protocol violation like any other,
   * so it takes the same route as a malformed body and gets reported. Silently
   * returning nothing here is what made this case invisible.
   */
  it('reports a completion envelope that carries no message content', async () => {
    const warn = spyOnWarnings()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] })))

    const out = await analyzerWith(new OpenAiProvider({ apiKey: 'k' })).analyzeBatch(MESSAGES)

    expect(out.results).toEqual(new Map())
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
