# Fix unbounded Slack rate-limit retry

Type: task
Status: ready-for-agent
Plan: Task 1

## Problem

`slack-api-client.ts:50-53` is the entire rate-limit implementation:

    if (body.error === 'ratelimited') {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '1')
      await sleep(retryAfter * 1000)
      return callSlack(method, token, params)
    }

Three defects: unbounded recursion (no attempt cap), Slack's body-level
`retry_after` ignored, HTTP 429 never inspected (`res.ok` unused in the file).

## Why it matters here

Automatic sync (D6) depends on this. Bounded backoff is a prerequisite, not an
afterthought.

## Acceptance

- HTTP 429 and body `ratelimited` both detected
- body `retry_after` preferred over header
- delay capped at 60s, never negative or NaN
- max 4 attempts then throw
- non-rate-limit errors are not retried
