# Paginate conversation history

Type: task
Status: ready-for-agent
Plan: Task 2

## Problem

`listMessages()` fetches exactly one page. `response_metadata.next_cursor` is
declared in `SlackHistoryResponse` and never read. `has_more` appears nowhere
in the codebase. No way to request page 2 through any IPC channel.

## Why it matters

Slack caps at 1000 messages. Every dashboard metric would silently truncate at
the same place, forever.

## Acceptance

- follows `next_cursor` until empty
- hard `maxPages` cap so a stuck cursor cannot loop
- results sorted newest-first
- `oldest` parameter supported for incremental fetch
