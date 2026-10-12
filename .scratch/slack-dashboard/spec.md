# Slack Dashboard — spec

Status: awaiting approval
Branch: `feat/slack-dashboard`

A "Slack Dashboard" button in the sidebar that reads every connected Slack
account via the stored user tokens, rolls up real activity metrics across all
workspaces, and adds AI-inferred sentiment and completion estimates.

## Decisions (locked during grilling)

| # | Decision | Why |
| --- | --- | --- |
| D1 | Single-operator app — **no per-client authorization** | One operator. The existing admin gate is enough. Per-client views would be SaaS thinking on a local tool. |
| D2 | Every connected account, always | Incremental sync makes ongoing cost near zero |
| D3 | Public + private channels, **no DMs** | Scopes already grant this; DMs are hidden by design |
| D4 | Real metrics **and** AI together in one release | One sync pipeline instead of two rewrites |
| D5 | AI-estimated completion % | The only way to get it; labelled as an estimate |
| D6 | Manual **and** automatic sync | User chose both |
| D7 | 90-day first-sync window | Bounded first run, covers quarterly trends |
| D8 | 90-day message-text retention, aggregates kept forever | No gap between fetched and readable |
| D9 | OpenAI, small model, behind a provider interface | Cheapest; swapping is a one-file change |
| D10 | Add `users:read` now, ship person metrics later | Adding the scope later means a second re-connect pass over every workspace |
| D11 | Build history pagination with a per-channel cap | Without it every metric silently truncates at 1000 messages |
| D12 | Fix the rate-limit retry loop as part of this work | Automatic sync on an infinite retry loop is a wedged app |

## Architecture

All privileged work stays in the main process (ADR 0005). The renderer never
calls the Slack API.

```
┌─ RENDERER ─────────────────────────────────────────┐
│  ProfileSidebar        existing — one button added  │
│  SlackDashboard.tsx    new — one screen, all clients│
│  useDashboard.ts       new — zustand slice           │
└────────────────┬─────────────────────────────────────┘
                 │ window.api.slackDashboard.*  (new, typed)
┌────────────────▼─────────────────────────────────────┐
│  MAIN                                               │
│  ipc/slack-dashboard.ipc.ts   new — 6 channels      │
│  slack/sync-engine.ts         new — queue, cursors   │
│  slack/rate-limiter.ts        new — bounded backoff  │
│  slack/dashboard-store.ts     new — JSON persistence │
│  slack/ai-analyzer.ts         new — provider iface   │
│  slack/slack-api-client.ts    modified — pagination  │
│  slack/token-store.ts         unchanged — reuse      │
└──────────────────────────────────────────────────────┘
```

## File structure

**Created**

| File | Responsibility |
| --- | --- |
| `src/main/slack/rate-limiter.ts` | Bounded retry, `Retry-After`/`retry_after`, HTTP 429. Pure, no I/O. |
| `src/main/slack/dashboard-store.ts` | `dashboard.json` read/write. Aggregates + 90-day message window. |
| `src/main/slack/sync-engine.ts` | Walks workspaces → channels → messages, one request at a time, incremental. |
| `src/main/slack/ai-analyzer.ts` | `AiProvider` interface + OpenAI adapter. Batches, caches by message `ts`. |
| `src/main/ipc/slack-dashboard.ipc.ts` | Registers the 6 new channels. |
| `src/renderer/src/components/SlackDashboard.tsx` | The dashboard screen. |
| `src/renderer/src/hooks/useDashboard.ts` | Zustand slice mirroring `useProfiles.ts`. |

**Modified (additive only)**

| File | Change |
| --- | --- |
| `src/shared/types.ts` | New `*Dashboard*` types. Nothing existing altered. |
| `src/shared/ipc-contract.ts` | New channel constants + API surface. |
| `src/main/slack/slack-api-client.ts` | Fix retry; add `listMessages` pagination, `listUsers`, `authTest`. |
| `src/main/slack/oauth-flow.ts` | Append `users:read` to `USER_SCOPES`. |
| `src/main/slack/types.ts` | New response interfaces. |
| `src/main/index.ts` | One `registerSlackDashboardIpc(...)` call. |
| `src/preload/index.ts` | `slackDashboard` namespace. |
| `src/renderer/src/App.tsx` | Mount `SlackDashboard` when active. |
| `src/renderer/src/components/ProfileSidebar.tsx` | One button. |

## Metrics

**Real — from Slack**

- Messages per channel, per day
- Active days (days with ≥1 message)
- Last activity timestamp
- Top channels by volume
- Message volume trend
- Response gap (time between consecutive messages in a channel)

**AI-inferred — labelled as estimates in the UI**

- Sentiment trend per channel (positive / neutral / negative)
- Completion estimate per channel, with the reasoning text shown

**Not in Slack — excluded**

- Days-in-target. No target dates exist in Slack. Not shipped. Revisit only if a
  tracker integration is added.

## Sync model

- **First run:** backfill 90 days per channel, paginating `next_cursor`.
- **After that:** incremental from the stored `lastSyncTs` per channel.
- **Manual:** "Sync now" button.
- **Automatic:** interval timer, user-configurable, default off until set.
- **Serialised:** one in-flight Slack request at a time per workspace. No
  concurrency — Tier 2 is 3 req/min and parallelism just burns the budget.

## Rate limiting (D12 — fixes a live bug)

Current code recurses unbounded on `ratelimited`, ignores the body's
`retry_after`, and never inspects HTTP 429. Replacement:

- Check `res.status === 429` **and** `body.error === 'ratelimited'`
- Prefer body `retry_after`, fall back to `Retry-After` header, cap at 60s
- Max 4 attempts per call, then throw a typed error
- Exponential backoff with jitter between attempts

## Storage

`userData/dashboard.json`:

```ts
{
  version: 1,
  workspaces: Record<teamId, {
    teamName: string
    profileId: string
    lastSyncAt: string
    channels: Record<channelId, {
      channelName: string
      isPrivate: boolean
      lastSyncTs: string        // incremental cursor
      totalMessages: number     // lifetime aggregate
      dailyCounts: Record<'YYYY-MM-DD', number>
      recentMessages: Array<{ ts, user, text, sentiment?, completionHint? }>  // pruned to 90d
      sentimentScore?: number   // -1..1
      completionEstimate?: number  // 0..100
    }>
  }>
}
```

Tokens are never touched — `token-store.ts` is reused exactly as it is.

## Non-goals

- Real-time updates via Socket Mode (would need an app token — not wanted)
- DMs
- Thread replies (`conversations.replies` — not implemented)
- Search
- Export to CSV/PDF
- Per-client authorization (D1)
- Days-in-target

## Review Focus

Failure modes a reasonable user would hit that the task tests must pin:

1. **Slack unreachable mid-sync** — sync must stop cleanly, keep partial progress,
   and not mark the channel as synced. A dropped connection must not silently
   skip a week of messages.
2. **Rate limit hit on automatic sync** — must back off and surface "rate limited,
   retrying in Ns" in the UI. Must never hang the app.
3. **Token revoked or expired** — `invalid_auth` must show "reconnect this
   workspace", not a generic failure.
4. **AI provider down or key missing** — dashboard must still render every real
   metric with AI sections marked unavailable. Real data is never blocked on AI.
5. **Workspace with 200+ channels** — first sync must make visible progress and
   report channel N of M, not appear frozen.
6. **Two syncs started at once** — second must be rejected, not doubled up.

## Known limitation

`users:read` is added to `USER_SCOPES`, but scopes are granted at consent time.
**Existing workspaces keep their old grant until the user re-connects each one.**
Person metrics therefore render raw IDs until then. The dashboard detects this
and shows a "reconnect for names" hint rather than displaying `U024BE7LH`.