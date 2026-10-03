# Wave 1: Slack conversation runtime

## Boundary and identity

`registerHandlers` accepts original human `app_mention` events and original human `message` events with `channel_type=im`. Bot events, all message subtypes (including edits/deletes), and events missing channel, timestamp or user are ignored. Replies remain in the originating thread. Only the bot's own mention is removed when Bolt supplies its bot user ID; other mentions remain intact. Without that ID, mentions remain intact rather than removing arbitrary identities.

RequestContext contains `channel`, `threadTs`, `userId`, optional `teamId`, and `requestId`. These come from Slack/Bolt, never message content or model tool arguments. Team resolution prefers envelope `team_id`, then event `team`, then Bolt `teamId`. No actor is invented for events without a user. The existing Assistant current-view hint is a bounded system message, not an identity or authorization source; its legacy threadTs-only map is unchanged.

Conversation session keys include the available team, channel and thread timestamp. Native `user` and `assistant` message arrays go to Mastra; role-looking text in user messages stays user content. Author (`user_id`), Slack event ID, channel, thread, team and request ID live separately from dialogue text in `conversation_events`. `conversation_turns` references that metadata and stores a complete user/assistant pair atomically.

## Persistence and failure

Additive migration `007_conversation_runtime.sql` creates the event ledger and paired-turn table. Applied migrations are unchanged. Startup now runs migrations unconditionally before Slack starts; existing OAuth and reminder setup is otherwise unchanged. Missing/unavailable DB prevents startup. Runtime DB failures prevent execution or final answer delivery as appropriate and produce a friendly Korean error, not raw exception details.

Only successful agent output is committed. Stream errors, missing answers and error finish reasons do not become dialogue. Failed user input is not appended to future context. A successful turn is persisted **before** ancillary logging/final Slack delivery, so those failures cannot discard it. A delivery failure may leave a saved answer the user did not see; there is no automatic delivery replay in this wave. Plan/progress streaming can already have appeared before a run or save failure; it is not saved dialogue.

New runtimes hydrate the most recent 15 complete turns from PostgreSQL in chronological order. A read-through cache is only an optimization; it does not pretend to save dialogue. All repository errors propagate. Tests use synthetic data and mocked queries only; no migration was applied to a real DB during implementation.

## Admission and bounds

Local limits live in `shookie/src/services/memory/limits.ts`, not shared config:

- 4 simultaneous runs, 64 admitted runs total, 8 admitted runs per thread (active included).
- Admission happens before adding a thread/queue entry. Duplicate pending events share the original work; only its owner reports errors.
- FIFO serialization per thread; waiting on a thread does not occupy an active global slot. Other threads can progress.
- Thread, pending-event and waiter maps release entries after settlement.
- Cache: 256 sessions, 15-minute absolute TTL, at most 30 messages/session. Entries and returns are copied; the oldest used session is evicted. Expiration is lazy on cache operations.
- Current user input: 16,000 UTF-8 bytes maximum, rejected with a friendly request to split the message.
- Model dialogue: 48,000 UTF-8 bytes maximum, newest complete turns only. No Unicode slicing, partial turns or semantic summaries. A small validated Assistant current-view hint is separate from this dialogue budget.

These are application byte/character safeguards, **not exact token counts**. The byte ceiling is conservative for application-supplied text; tokenizer overhead, agent/system instructions, tools/results and provider context limits are separate. This wave does not implement provider-wide token budgets or cancellation. A stalled provider retains its slot (rather than releasing it while work still runs); admission remains bounded but availability can degrade.

## Retry and crash semantics — not exactly once

Slack's globally unique `event_id` produces a `slack-event:` request key, even if retry team metadata is missing. Without an event ID, a SHA-256 key derives from available team, channel, original timestamp and user, not message text or a generated random ID. Missing team is represented explicitly. Fallback dedupe assumes these identity fields remain consistent on retries; inconsistent/missing envelope fields cannot be perfectly reconciled. Distinct channels/timestamps/users remain distinct. Session hydration also cannot infer an absent workspace identity.

The DB atomically inserts a unique claim **before** executing agent/tools. Completed, failed and processing claims all suppress later deliveries. Claims do not expire or automatically restart: a process crash after claiming leaves an abandoned processing record, and a retry is suppressed. A user can send a new event to try again. There is deliberately no lease that might expire while the original tool still runs.

Crash windows remain honest:

1. Before claim: no work performed; retry can claim.
2. After claim, before/during agent/tool execution: retry is suppressed, but work might have partially happened. No automatic recovery.
3. After model output, before transaction commit: output may be lost; tool side effects are not rolled back.
4. After commit, before Slack delivery: dialogue is saved but final reply may be missing.
5. Slack stream-stop/post failure can be ambiguous; the existing fallback can result in duplicate Slack output.

Admission/input rejections are not persisted claims. Retrying a rejected event can get another rejection or be admitted later. The durable ledger has no automatic retention deletion in this wave, so dedupe does not silently expire; operational retention/recovery policy is future work.

Execution queues/caches are **single-process**. The durable event key prevents two processes claiming the same event, but distinct events in one thread are not serialized across replicas, and caches are not invalidated across replicas. Run one bot runtime per installation for ordering guarantees. This is not a distributed queue or an exactly-once guarantee for tools or Slack delivery.

## Not included

No Slack remote thread fetch/search, semantic summarization, durable long-term user knowledge, distributed task queue, provider cancellation, model routing, web tools or broad prompt/tool changes. Only bot-observed successful turns after migration are restored. Historical Slack messages and the old volatile cache are not backfilled.
