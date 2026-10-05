import { executionSignal } from "../../cancellation/execution-context.js";
import { MAX_LIMIT, queryEventsSchema, type PostHogResult } from "./schemas.js";

const API = "https://app.posthog.com/api";
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_RESULT_BYTES = 24 * 1024;
const MAX_DATA_BYTES = 12 * 1024;
type Page = { limit?: number; continuation?: string };
export interface PostHogClientEntry {
  name: string;
  projectId: string;
  description: string;
}
class ResponseFailure extends Error {
  constructor(public code: string) { super(code); }
}

export class PostHogClient {
  constructor(private apiKey: string, private projectId: string, private name = projectId) {
    if (!/^[1-9][0-9]{0,15}$/.test(projectId)) throw new Error("잘못된 PostHog 프로젝트 ID");
    if (!name || name.length > 100) throw new Error("잘못된 PostHog 프로젝트 이름");
  }
  private url(resource: string) { return `${API}/projects/${this.projectId}/${resource}/`; }
  private source(resource: string, query?: string) {
    return {
      project: this.name, projectId: this.projectId, resource,
      ...(query ? { query: this.redactCredential(query) } : {}),
      fetchedAt: new Date().toISOString(),
    };
  }
  private redactCredential(text: string) { return this.apiKey ? text.split(this.apiKey).join("[credential masked]") : text; }
  private error(source: ReturnType<PostHogClient["source"]>, code: string, retryable = false, httpStatus?: number): PostHogResult {
    const messages: Record<string, string> = {
      invalid_input: "조회 입력의 범위와 형식을 확인해 주세요.",
      response_too_large: "응답이 조회 크기 제한을 초과했습니다. 기간이나 선택 필드를 줄여 주세요.",
      response_too_complex: "응답 구조가 너무 복잡합니다. 필요한 필드만 조회해 주세요.",
      invalid_response: "PostHog 응답 형식을 확인할 수 없어 조회를 완료하지 못했습니다.",
      upstream_error: "PostHog에서 조회 실패를 반환했습니다. 쿼리와 프로젝트 설정을 확인해 주세요.",
      rate_limited: "PostHog 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
      timeout: "PostHog 조회 시간이 초과되었습니다. 조회 범위를 줄이거나 잠시 후 다시 시도해 주세요.",
      network_error: "PostHog에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    };
    return {
      status: "error", data: null, source,
      error: {
        code, message: messages[code] ?? "PostHog 조회를 완료하지 못했습니다. 입력과 권한을 확인해 주세요.",
        retryable, ...(httpStatus ? { httpStatus } : {}),
      },
    };
  }
  queryEvents(params: { event?: string; after?: string; before?: string } & Page) {
    if (!queryEventsSchema.safeParse(params).success) return Promise.resolve(this.error(this.source("events"), "invalid_input"));
    return this.list("events", params, { event: params.event, after: params.after, before: params.before });
  }
  queryInsights(id?: string, page: Page = {}) { return id ? this.detail("insights", id) : this.list("insights", page); }
  listFeatureFlags(page: Page = {}) { return this.list("feature_flags", page); }
  listDashboards(page: Page = {}) { return this.list("dashboards", page); }
  getDashboard(id: string) { return this.detail("dashboards", id); }
  queryHogQL(query: string) {
    if (!query.trim() || Buffer.byteLength(query, "utf8") > 8000 ||
        Buffer.byteLength(JSON.stringify(this.redactCredential(query)), "utf8") > 8002) {
      return Promise.resolve(this.error(this.source("query"), "invalid_input"));
    }
    return this.request("query", this.url("query"), MAX_LIMIT, { query: { kind: "HogQLQuery", query } }, query);
  }
  listPersons(params: { distinctId?: string; email?: string } & Page) { return this.list("persons", params, { distinct_id: params.distinctId, email: params.email }); }
  listCohorts(limit = 100, continuation?: string) { return this.list("cohorts", { limit, continuation }); }
  listExperiments(limit = 100, continuation?: string) { return this.list("experiments", { limit, continuation }); }
  private detail(resource: string, id: string) {
    if (!/^[1-9][0-9]{0,15}$/.test(id)) return Promise.resolve(this.error(this.source(resource), "invalid_input"));
    return this.request(`${resource}/${id}`, `${this.url(resource)}${id}/`, 1);
  }
  private list(resource: string, page: Page, filters: Record<string, string | undefined> = {}) {
    const limit = page.limit ?? MAX_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT || (page.continuation && !/^offset:[0-9]{1,7}$/.test(page.continuation))) return Promise.resolve(this.error(this.source(resource), "invalid_input"));
    const url = new URL(this.url(resource));
    url.searchParams.set("limit", String(limit));
    if (page.continuation) url.searchParams.set("offset", page.continuation.slice(7));
    for (const [k, v] of Object.entries(filters)) if (v) {
      if (v.length > 254) return Promise.resolve(this.error(this.source(resource), "invalid_input"));
      url.searchParams.set(k, v);
    }
    return this.request(resource, url.toString(), limit);
  }
  // Only extract a bounded offset; never send credentials to a returned URL.
  private nextToken(next: unknown, requested: string): string | null {
    if (typeof next !== "string" || next.length > 2048) return null;
    try {
      const base = new URL(requested), url = new URL(next, base);
      if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash) return null;
      if ([...url.searchParams.keys()].some(k => ![...base.searchParams.keys(), "offset"].includes(k))) return null;
      for (const [k, v] of base.searchParams) if (k !== "offset" && url.searchParams.get(k) !== v) return null;
      const offset = url.searchParams.get("offset");
      if (!offset || !/^[0-9]{1,7}$/.test(offset) || Number(offset) <= Number(base.searchParams.get("offset") ?? 0)) return null;
      if ([...url.searchParams.keys()].some(k => url.searchParams.getAll(k).length !== 1)) return null;
      return `offset:${offset}`;
    } catch { return null; }
  }
  private async readBounded(response: Response): Promise<unknown> {
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new ResponseFailure("response_too_large"); }
    if (!response.body) throw new ResponseFailure("invalid_response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ResponseFailure("response_too_large"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new ResponseFailure("invalid_response"); }
  }
  private async request(resource: string, url: string, limit: number, body?: unknown, query?: string): Promise<PostHogResult> {
    const source = this.source(resource, query);
    try {
      const response = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: executionSignal(AbortSignal.timeout(30_000)),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return this.error(source, response.status === 429 ? "rate_limited" : "http_error",
          response.status === 429 || response.status >= 500, response.status);
      }
      const raw = await this.readBounded(response);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ResponseFailure("invalid_response");
      const payload = raw as Record<string, unknown>;
      if (payload.error || payload.detail || payload.status === "error" || payload.status === "failed") throw new ResponseFailure("upstream_error");
      if (resource === "query" && (!Array.isArray(payload.results) || !Array.isArray(payload.columns) || !payload.columns.every(c => typeof c === "string"))) throw new ResponseFailure("invalid_response");
      if (!resource.includes("/") && resource !== "query" && !Array.isArray(payload.results)) throw new ResponseFailure("invalid_response");
      const records = (Array.isArray(payload.results) ? payload.results : [payload]);
      const selected: unknown[] = [];
      let omitted = 0;
      const columns = resource === "query" ? payload.columns as string[] : undefined;
      if (columns && Buffer.byteLength(JSON.stringify(columns)) > 2048) throw new ResponseFailure("response_too_large");
      for (const record of records) {
        if (resource === "query" && (!Array.isArray(record) || record.length !== columns!.length)) throw new ResponseFailure("invalid_response");
        const item = resource === "query" ? mask(record) : selectRecord(resource, record);
        if (selected.length >= limit || Buffer.byteLength(JSON.stringify([...selected, item])) > MAX_DATA_BYTES) {
          omitted++;
          continue;
        }
        selected.push(item);
      }
      const hasNext = payload.next !== undefined && payload.next !== null && payload.next !== "";
      const continuation = hasNext && resource !== "query" ? this.nextToken(payload.next, url) : null;
      const reasons = [
        omitted ? "record_budget" : "",
        hasNext && !continuation ? "unsupported_next" : "",
        payload.hasMore === true || payload.complete === false ? "upstream_incomplete" : "",
      ].filter(Boolean);
      // Also prevent accidental reflection of the configured credential in selected fields.
      const safeSelected = mask(selected, 0, this.apiKey) as unknown[];
      const safeColumns = columns?.map(c => this.redactCredential(c));
      const result: PostHogResult = {
        status: "success",
        data: safeColumns ? { columns: safeColumns, rows: safeSelected }
          : { records: safeSelected as Record<string, unknown>[] },
        source,
        pagination: {
          continuation,
          hasMore: hasNext || payload.hasMore === true || payload.complete === false,
          truncated: reasons.length > 0,
          omittedRecords: omitted,
          ...(reasons.length ? { reason: reasons.join(",") } : {}),
        },
      };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) throw new ResponseFailure("response_too_large");
      return result;
    } catch (e) {
      const code = e instanceof ResponseFailure ? e.code
        : e instanceof Error && ["TimeoutError", "AbortError"].includes(e.name) ? "timeout" : "network_error";
      return this.error(source, code, !(e instanceof ResponseFailure));
    }
  }
}
// Deliberately omit arbitrary event/person properties and flag targeting conditions.
function selectRecord(resource: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResponseFailure("invalid_response");
  const fields = resource === "persons" ? ["id", "created_at", "is_identified"]
    : resource === "events" ? ["id", "event", "timestamp"]
    : ["id", "name", "derived_name", "key", "description", "created_at", "updated_at",
      "active", "deleted", "is_static", "start_date", "end_date", "result", "last_refresh", "short_id", "count"];
  const record = value as Record<string, unknown>;
  const selected = Object.fromEntries(fields.filter(k => k in record).map(k => [k, mask(record[k])]));
  if (!Object.keys(selected).length) throw new ResponseFailure("invalid_response");
  if (resource.startsWith("dashboards/") && Array.isArray(record.tiles)) selected.tiles = record.tiles.map(tile => {
    if (!tile || typeof tile !== "object" || Array.isArray(tile)) throw new ResponseFailure("invalid_response");
    const t = tile as Record<string, unknown>;
    return { id: mask(t.id ?? null), insight: t.insight ? selectRecord("insights", t.insight) : null };
  });
  return selected;
}
function mask(value: unknown, depth = 0, credential?: string): unknown {
  if (depth > 20) throw new ResponseFailure("response_too_complex");
  if (typeof value === "number" && !Number.isFinite(value)) throw new ResponseFailure("invalid_response");
  if (typeof value === "string") {
    const safe = credential ? value.split(credential).join("[credential masked]") : value;
    return safe.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email masked]");
  }
  if (Array.isArray(value)) return value.map(v => mask(v, depth + 1, credential));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      credential ? k.split(credential).join("[credential masked]") : k,
      /email|phone|token|password|secret|authorization/i.test(k) ? "[masked]" : mask(v, depth + 1, credential),
    ]));
  }
  return value;
}
export class PostHogClientManager {
  private clients = new Map<string, PostHogClient>();
  constructor(apiKey: string, private entries: PostHogClientEntry[]) {
    if (!entries.length) throw new Error("PostHogClientManager는 최소 1개의 entries가 필요합니다");
    for (const e of entries) {
      if (!e.name || e.name.length > 100) throw new Error("잘못된 PostHog 프로젝트 이름");
      this.clients.set(e.name, new PostHogClient(apiKey, e.projectId, e.name));
    }
  }
  getClient(projectName?: string): PostHogClient {
    const client = this.clients.get(projectName ?? this.getDefaultName());
    if (!client) throw new Error("알 수 없는 PostHog 프로젝트");
    return client;
  }
  getProjectNames() { return this.entries.map(p => p.name); }
  getProjectCatalog() { return this.entries.map(p => `- **${p.name}**: ${p.description}`).join("\n"); }
  getDefaultName() { return this.entries[0].name; }
}
