import { z } from "zod";

export const RESEARCH_LIMITS = Object.freeze({ items: 8, entryBytes: 1400, evidenceBytes: 9000,
  excerptBytes: 512, resultBytes: 4096, limitationItems: 7, limitationBytes: 256, totalBytes: 16384 });
const sourceSchema = z.record(z.union([z.string(), z.number()]));
export const researchOutput = z.object({
  status: z.enum(["success", "partial", "error"]), result: z.string(),
  evidence: z.array(z.object({ tool: z.string(), source: sourceSchema, status: z.enum(["success", "partial", "error", "unknown"]), excerpt: z.string(), truncated: z.boolean() })),
  limitations: z.array(z.string()), truncated: z.boolean(),
});
export const reportSchema = researchOutput.pick({ status: true, result: true, limitations: true });
type Report = z.infer<typeof reportSchema>;
type Evidence = z.infer<typeof researchOutput>["evidence"][number];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
// Budget serialized UTF-8, including JSON escaping; never split a Unicode code point.
function clip(text: string, budget: number): string {
  let output = "";
  for (const point of text) { if (bytes(output + point) > budget) break; output += point; }
  return output;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const sourceKeys = ["owner", "repo", "ref", "commitSha", "path", "startLine", "endLine", "permalink", "url", "project", "projectId", "resource", "fetchedAt", "channelId", "messageTs", "threadTs", "fileId", "snapshotId"];
function project(tool: string, raw: unknown): Evidence {
  let value = raw;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { /* Text-only result. */ } }
  const data = object(value), supplied = object(data.source);
  const source: Evidence["source"] = {};
  let truncated = Array.isArray(value) || (typeof value !== "string" && (value === null || typeof value !== "object"));
  // Only existing result fields, never arguments, model-generated citations, or inferred URLs.
  for (const key of sourceKeys) {
    const field = supplied[key] ?? data[key];
    if (typeof field !== "string" && !(typeof field === "number" && Number.isFinite(field))) continue;
    // Never shorten a provenance value into a different ref/path/URL.
    if ((typeof field === "string" && bytes(field) > 256) || bytes({ ...source, [key]: field }) > 600) { truncated = true; continue; }
    source[key] = field;
  }
  if (typeof data.source === "string") {
    if (bytes(data.source) <= 256 && bytes({ ...source, source: data.source }) <= 600) source.source = data.source;
    else truncated = true;
  }
  const status = data.status === "error" || Boolean(data.error) || data.success === false ? "error"
    : data.status === "partial" || data.complete === false || data.truncated === true ? "partial"
    : data.status === "success" || data.complete === true || data.success === true ? "success" : "unknown";
  // Excerpts are text, not recursive raw-result serialization.
  const text = typeof value === "string" ? value : typeof data.text === "string" ? data.text
    : typeof data.data === "string" ? data.data : Array.isArray(data.lines) ? data.lines.slice(0, 32).filter(v => typeof v === "string").join("\n") : "";
  const excerpt = clip(text, RESEARCH_LIMITS.excerptBytes);
  truncated ||= excerpt !== text || (Array.isArray(data.lines) && data.lines.length > 32) || status === "partial";
  const textKey = typeof data.text === "string" ? "text" : typeof data.data === "string" ? "data" : Array.isArray(data.lines) ? "lines" : undefined;
  if (Object.keys(data).some(key => !sourceKeys.includes(key) && key !== textKey && !["source", "status", "complete", "truncated", "success"].includes(key))) truncated = true;
  const entry = { tool: clip(tool, 128), source, status, excerpt, truncated } as Evidence;
  if (entry.tool !== tool) entry.truncated = true;
  // Fixed source + excerpt budgets keep every entry below entryBytes, with a fail-safe.
  if (bytes(entry) > RESEARCH_LIMITS.entryBytes) { entry.excerpt = ""; entry.truncated = true; }
  return entry;
}
export function boundedResearchOutput(status: Report["status"], report: Report | undefined, fallback: string,
  results: Iterable<{ tool: string; result: unknown }>): z.infer<typeof researchOutput> {
  const evidence: Evidence[] = [];
  let truncated = false;
  for (const item of results) {
    if (evidence.length >= RESEARCH_LIMITS.items) { truncated = true; break; }
    const entry = project(item.tool, item.result);
    if (bytes([...evidence, entry]) > RESEARCH_LIMITS.evidenceBytes) { truncated = true; break; }
    evidence.push(entry); truncated ||= entry.truncated;
  }
  const text = report?.result ?? fallback;
  const result = clip(text, RESEARCH_LIMITS.resultBytes);
  const original = report?.limitations ?? [];
  const limitations = original.slice(0, RESEARCH_LIMITS.limitationItems - 3).map(value => clip(value, RESEARCH_LIMITS.limitationBytes));
  truncated ||= result !== text || original.length > limitations.length || limitations.some((v, i) => v !== original[i]);
  if (!report) limitations.push("보고서 형식 미확인; 제한된 텍스트만 반환했습니다.");
  if (truncated) limitations.push("근거/보고서 예산에 따라 일부 내용을 생략했습니다. 전체 조사 결과가 아닙니다.");
  if (status !== "success") limitations.push("조사 미완료 또는 도구 실패; 완전한 성공으로 해석하지 마세요.");
  const output = { status: truncated && status === "success" ? "partial" as const : status, result, evidence, limitations, truncated };
  // Defense against future projection/schema growth bypassing the total serialized budget.
  if (bytes(output) > RESEARCH_LIMITS.totalBytes) {
    return { status: status === "error" ? "error" : "partial", result: clip(result, 1024), evidence: [],
      limitations: ["전체 출력 예산 초과로 근거와 보고서를 생략했습니다. 전체 결과가 아닙니다."], truncated: true };
  }
  return output;
}
