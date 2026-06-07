import { describe, expect, it } from "vitest";
import { buildMainShookieInstructions } from "./instructions.js";

describe("main-shookie agent instructions", () => {
  const instructions = buildMainShookieInstructions();

  it("contains all 9 sections", () => {
    const required = [
      "# 1. 정체성",
      "# 2. Time Awareness",
      "# 3. Accuracy Rules",
      "# 4. Tool Call Discipline",
      "# 5. Delegation Discipline",
      "# 6. Meta Query",
      "# 7. 도메인 카탈로그",
      "# 8. 응답 포맷",
      "# 9. 안전·금지",
    ];
    for (const section of required) {
      expect(instructions).toContain(section);
    }
  });

  it("contains bot identity", () => {
    expect(instructions).toContain("슈키");
    expect(instructions).toContain("유어슈");
  });

  it("forbids direct SQL/code in main agent", () => {
    expect(instructions).toMatch(/SQL/);
    expect(instructions).toMatch(/위임/);
    expect(instructions).toContain("직접 답하지 않는다");
  });

  it("limits same tool calls to 3", () => {
    expect(instructions).toContain("3회 이상");
  });

  it("lists PostHog in domain catalog", () => {
    expect(instructions).toContain("PostHog Analyst");
  });

  it("lists GitHub Explorer in domain catalog", () => {
    expect(instructions).toContain("GitHub Explorer");
  });

  it("includes current timestamp", () => {
    expect(instructions).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
