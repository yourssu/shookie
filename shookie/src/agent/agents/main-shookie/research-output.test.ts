import { expect, it } from "vitest";
import { boundedResearchOutput, RESEARCH_LIMITS } from "./research-output.js";
const report = { status: "success" as const, result: "short finding", limitations: [] };
it("preserves small evidence and exact supplied sources without an opaque nested dump", () => {
  const output = boundedResearchOutput("success", report, "", [{ tool: "github_read", result: {
    source: "https://api.github.com/repos/example/sample", owner: "example", repo: "sample", ref: "abc123", path: "a.ts", complete: true, data: "verified excerpt",
  } }]);
  expect(output).toMatchObject({ status: "success", truncated: false, limitations: [], evidence: [{
    tool: "github_read", source: { source: "https://api.github.com/repos/example/sample", owner: "example", repo: "sample", ref: "abc123", path: "a.ts" },
    status: "success", excerpt: "verified excerpt", truncated: false,
  }] });
});
it("enforces aggregate evidence bytes as well as item limits with multibyte and escaped text", () => {
  const output = boundedResearchOutput("success", report, "", Array.from({ length: 100 }, () => ({
    tool: "tool".repeat(100), result: { status: "success", source: { owner: "소".repeat(80), repo: "😀".repeat(50), ref: "r".repeat(100) }, text: '😀슈키\n"\\'.repeat(1000) },
  })));
  expect(output.status).toBe("partial");
  expect(output.truncated).toBe(true);
  expect(output.evidence.length).toBeGreaterThan(0);
  expect(output.evidence.length).toBeLessThan(RESEARCH_LIMITS.items);
  expect(Buffer.byteLength(JSON.stringify(output.evidence))).toBeLessThanOrEqual(RESEARCH_LIMITS.evidenceBytes);
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(RESEARCH_LIMITS.totalBytes);
  for (const entry of output.evidence) {
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(RESEARCH_LIMITS.entryBytes);
    expect(Buffer.from(entry.excerpt).toString("utf8")).toBe(entry.excerpt);
    expect(Buffer.byteLength(JSON.stringify(entry.excerpt))).toBeLessThanOrEqual(RESEARCH_LIMITS.excerptBytes);
  }
  expect(output.limitations.join(" ")).toContain("전체 조사 결과가 아닙니다");
});
it("omits oversized provenance rather than manufacturing shortened references; reports missing content", () => {
  const output = boundedResearchOutput("success", report, "", [{ tool: "read", result: {
    source: { repo: "sample", path: "long/".repeat(200), permalink: "https://example.org/" + "x".repeat(1000) },
    data: { deeply: { nested: "RAW_SENTINEL" } }, status: "success",
  } }]);
  expect(output).toMatchObject({ status: "partial", truncated: true, evidence: [{ source: { repo: "sample" }, excerpt: "", truncated: true }] });
  expect(output.evidence[0].source).not.toHaveProperty("path");
  expect(output.evidence[0].source).not.toHaveProperty("permalink");
  expect(JSON.stringify(output)).not.toContain("RAW_SENTINEL");
});
