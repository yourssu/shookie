import { describe, expect, it } from "vitest";
import { PostHogClientManager } from "../../../tools/posthog/client.js";
import { ssutimePostHogKnowledge } from "../../../projects/ssutime-prod/posthog.js";
import { soongptPostHogKnowledge } from "../../../projects/soongpt-prod/posthog.js";
import { buildPostHogInstructions } from "./instructions.js";

// Deterministic reference calculation, not execution against live HogQL.
const events = [
  { person: "returning", timestamp: "2025-12-20T03:00:00Z" },
  { person: "returning", timestamp: "2026-01-02T03:00:00Z" },
  { person: "new", timestamp: "2026-01-01T16:00:00Z" },
  { person: "new", timestamp: "2026-01-02T01:00:00Z" },
  { person: "start-boundary", timestamp: "2026-01-01T15:00:00Z" },
  { person: "before-start", timestamp: "2026-01-01T14:59:59.999Z" },
  { person: "before-start", timestamp: "2026-01-02T00:00:00Z" },
  { person: "last-in-range", timestamp: "2026-01-02T14:59:59.999Z" },
  { person: "end-boundary", timestamp: "2026-01-02T15:00:00Z" },
];
const start = Date.parse("2026-01-02T00:00:00+09:00");
const end = Date.parse("2026-01-03T00:00:00+09:00");
function firstSeen(input: typeof events) {
  const first = new Map<string, number>();
  for (const e of input) first.set(e.person, Math.min(first.get(e.person) ?? Infinity, Date.parse(e.timestamp)));
  return [...first].filter(([, time]) => time >= start && time < end).map(([person]) => person).sort();
}

describe("first-ever in available history, KST half-open interval", () => {
  it("excludes returning users and counts repeats only once", () => {
    expect(firstSeen(events)).toEqual(["last-in-range", "new", "start-boundary"]);
    // Regression counterexample: applying the date range before min() overcounts.
    expect(firstSeen(events.filter(e => Date.parse(e.timestamp) >= start && Date.parse(e.timestamp) < end)))
      .toEqual(["before-start", "last-in-range", "new", "returning", "start-boundary"]);
  });
  it("uses midnight KST boundaries and groups first-seen on the outer query", () => {
    expect(new Date(start).toISOString()).toBe("2026-01-01T15:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-01-02T15:00:00.000Z");
    const sql = ssutimePostHogKnowledge.match(/```sql\n([\s\S]*?)```/)![1];
    expect(sql).toMatch(/FROM events\s+GROUP BY person_id\s+\)\s+WHERE first_seen >=/);
    expect(sql).toContain("first_seen < toDateTime('2026-01-02 15:00:00', 'UTC')");
    expect(sql).toContain("toDate(toTimeZone(first_seen, 'Asia/Seoul'))");
    expect(sql).not.toMatch(/WHERE timestamp/);
    expect(ssutimePostHogKnowledge).toContain("보존 기간/수집 시작");
  });
  it("discloses ambiguity, structured errors, incomplete results and unverified knowledge", () => {
    const manager = new PostHogClientManager("dummy", [{ name: "SSUTime", projectId: "123", description: "fixture" }]);
    const instructions = buildPostHogInstructions(manager);
    for (const phrase of ["모호하면 먼저 확인", "status=error", "pagination.truncated", "source.project", "읽기 전용/안전성을 도구가 강제하지 않는다", "live HogQL 검증을 했다고 주장하지 않는다"])
      expect(instructions).toContain(phrase);
    expect(instructions).not.toContain("toDate(min(timestamp))");
    expect(instructions).not.toContain("SELECT * FROM persons");
    expect(ssutimePostHogKnowledge).not.toContain("절대 금지");
    expect(soongptPostHogKnowledge).toContain("추측하지 말고");
  });
});
