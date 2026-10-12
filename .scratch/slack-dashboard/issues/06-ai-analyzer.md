# Pluggable AI analyzer

Type: task
Status: ready-for-agent
Plan: Task 6

## Design

`AiProvider` interface + OpenAI adapter (default `gpt-4o-mini`). JSON mode.
Results keyed by message `ts` and cached in the store, so re-syncs never
re-bill the same message.

## Acceptance

- null provider returns an empty map and does not throw
- a provider that throws yields an empty map, never propagates
- empty-text messages never reach the provider
- completion estimates are labelled as estimates in the UI
