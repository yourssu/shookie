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

  it("forbids echoing user messages at response start", () => {
    expect(instructions).toContain("사용자 메시지 반복 금지");
    expect(instructions).toContain("곧바로 본론");
  });

  it("lists PostHog in domain catalog", () => {
    expect(instructions).toContain("PostHog Analyst");
  });

  it("lists Code Explorer in domain catalog", () => {
    expect(instructions).toContain("Code Explorer");
  });

  it("routes domain knowledge updates to sequential PostHog → Code Explorer delegation", () => {
    expect(instructions).toContain("도메인 지식 업데이트");
    expect(instructions).toContain("순차 위임");
    expect(instructions).toContain("7.1 도메인 지식 업데이트 워크플로우");
    // 핵심 트리거 키워드 포함 확인
    expect(instructions).toMatch(/기억해줘|저장해줘/);
    expect(instructions).toContain("변경 제안");
    expect(instructions).toContain("실제 저장/적용은 수행하지 않았음");
    expect(instructions).not.toContain("업데이트하고 PR 생성해줘");
    expect(instructions).not.toContain("반환한 PR URL");
  });

  it("includes current timestamp", () => {
    expect(instructions).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
