# PostHog agent result contract

## Scope and compatibility

All nine tool purposes remain: events, insights, feature flags, dashboards, dashboard detail (including selected tile/insight summaries), HogQL, persons, cohorts, experiments. `createPostHogAgent(manager, model)` is unchanged. Tool output intentionally changes from `{ result: string }` to the envelope below; the PostHog agent instructions consume this contract. No main-agent/runtime/config/database changes are needed.

```json
{
  "status": "success",
  "data": { "columns": ["day", "users"], "rows": [["2026-01-02", 3]] },
  "source": {
    "project": "fixture", "projectId": "123", "resource": "query",
    "query": "SELECT ...", "fetchedAt": "2026-01-03T00:00:00.000Z"
  },
  "pagination": {
    "continuation": null, "hasMore": false, "truncated": false,
    "omittedRecords": 0
  }
}
```

List/detail endpoints use `data.records` with selected fields, not raw payloads. Query rows preserve positional correspondence with columns; inconsistent row widths are errors. `source.query` is the submitted query evidence (configured credential reflections are masked), not a claim of enforced SQL safety. Source time is retrieval time, not the analyzed interval. Endpoint detail IDs appear in `resource`.

Errors use `status: "error", data: null, source, error: { code, message, retryable, httpStatus? }`. Empty success is distinct from failure. Messages are Korean-friendly; upstream bodies, headers, error stacks and configured credentials are not returned/logged. No automatic retries occur. Timeout/network errors, 429 and 5xx are retryable; other HTTP errors, invalid inputs/responses, upstream error envelopes and byte/complexity-budget errors are not. Retryable means a later bounded attempt may help, not guaranteed recovery.

## Budgets and incomplete data

- Input limits are integers 1–100 (default 100), enforced by schemas and client list methods. Dates require ISO 8601 timestamps with timezone, with start before end. Path IDs/project IDs are bounded positive decimal IDs. Query text is limited to 8,000 UTF-8 bytes, with an additional 8,002-byte JSON-encoded evidence budget (including quotes) so escaping/credential masking cannot expand error evidence without bound. Numeric insight detail IDs are supported; short IDs are returned as evidence, not accepted as path input.
- One request per call; 30-second timeout covers headers and streamed body. Redirects are refused, so credentials cannot follow a redirect.
- Downloaded bodies are read incrementally with a 256 KiB budget. Oversized Content-Length cancels before reading; missing/incorrect length still triggers streaming cancellation. No `response.text()`/`response.json()` allocates an unbounded complete body. A fetch implementation may deliver one chunk crossing the budget; it is rejected immediately, not retained/decoded. Already-buffered transport chunks cannot be retroactively undownloaded.
- Selected data has a 12 KiB budget, at most 100 records/rows; column metadata has a 2 KiB budget; the full serialized success envelope is checked against 24 KiB. JSON strings are never cut. Excess records, including oversized single records, are omitted and counted in `omittedRecords`; they cannot necessarily be recovered by pagination. Excess columns/complex nesting produce explicit errors. All accepted query evidence is byte-bounded, including error envelopes.
- A page with unsupported/invalid `next` is still useful but is marked `hasMore: true, truncated: true, reason: "unsupported_next"`. `record_budget` identifies selected records omitted locally; upstream `hasMore`/`complete: false` is marked `upstream_incomplete`. Missing/null/empty `next` means no advertised list continuation; it is not proof that the endpoint covers all historical data.
- The actual SQL LIMIT and filters also constrain analytics. `pagination.truncated: false` does not assert that arbitrary user-written SQL represents the entire population.

## Continuation authority

The client never requests API-returned URLs. It only extracts a strictly increasing bounded offset from a next link whose origin (including protocol), exact project/resource path, limit and filters match the original request. Credentials/userinfo, fragments, duplicate parameters, extra parameters and altered filters are rejected. Relative links must meet the same constraints. Unsupported cursor pagination is explicitly reported rather than guessed.

`continuation: "offset:N"` accepts at most seven decimal digits. The next tool call reconstructs the fixed configured API resource using that offset and the validated original inputs. Callers must reuse the same project/tool/filters/limit. Tokens are not cryptographically bound to those inputs, but cannot expand network authority: there is no URL, host or path in a token. Each subsequent page is an explicit bounded call, never an automatic pagination loop. Concurrent list mutations may cause duplicate/missing entries; these are not snapshot exports. HogQL is not automatically paginated.

## Personal data and authorization limits

Events omit arbitrary properties and person/distinct identifiers. Persons return internal ID, creation time and identification state, not properties/distinct IDs/email. Flag targeting conditions are omitted. Insight results and dashboard summaries are selected and size-bounded. Sensitive object keys (email/phone/token/password/secret/authorization) and recognizable email strings are masked recursively with a depth bound. Known configured API credentials are masked if reflected in data/query evidence.

This is **partial minimization, not a complete PII policy**: arbitrary SQL can return unlabeled identifiers, phone numbers/free text; project descriptions and user-supplied SQL can contain personal data. Columns, internal IDs and original query evidence are retained. Actor-based authorization, comprehensive redaction and actual read-only SQL enforcement are separate work. Do not describe arbitrary HogQL as safely/read-only enforced.

## Analytics definitions and knowledge provenance

SSUTime `new_users` means a person whose earliest event **in all available history** falls within the requested KST interval. Compute `min(timestamp)` grouped by person first, then filter first_seen in an outer query and group its KST date. Filtering event timestamps to the requested range before min incorrectly counts returning users. Midnight KST is 15:00 UTC on the previous day; intervals are start-inclusive, end-exclusive. The first event of any type is used by this definition; changing event filters changes the metric.

Collection start, retention/deletion and identity merges affect first-seen; this is not a guaranteed lifetime signup/install count. Active users/DAU is a separate period-local metric; SSUTime's registered event specification excludes automated `todo_snapshot` activity for DAU/retention. Existing app/event descriptions are repository-supplied domain specifications, not newly verified production facts. Person property semantics and persons aggregation support must be checked against actual settings/version rather than asserting blanket GROUP BY prohibitions. Widget-heavy-user and Kakao-new-user associations are hypotheses to validate. Soongpt knowledge remains explicitly unregistered; no missing facts have been invented.

## Local validation only

`shookie/src/tools/posthog/client.test.ts` uses dummy credentials and mocked fetch responses for success/empty/errors, malformed/non-JSON bodies, timeout/network/HTTP classification, streaming cancellation, record budgets, row/column mapping, selected fields, and next-link authority controls. `shookie/src/agent/agents/posthog/instructions.test.ts` uses deterministic historical fixtures (returning user, truly new user, repeat events, before/start/end KST boundaries) plus template structural checks.

These checks do **not** execute HogQL against a live PostHog project. Query function support and live performance remain unverified; no operational DB/Slack/PostHog data is accessed.
