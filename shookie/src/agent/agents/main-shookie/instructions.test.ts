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

  it("uses progress and step budgets instead of arbitrary call limits", () => {
    expect(instructions).toContain("maxSteps");
    expect(instructions).toContain("새로운 근거 없이");
    expect(instructions).not.toContain("3회 이상");
    expect(instructions).not.toContain("2턴 이내");
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

  it("advertises Slack reads only when registered and keeps bot-only search/permission boundaries honest", () => {
    const enabled = buildMainShookieInstructions({ toolKeys: ["slack_read_thread", "slack_read_channel", "slack_search"] });
    expect(enabled).toContain("slack_read_thread / slack_read_channel 등록됨");
    expect(enabled).toContain("assistant.search.context");
    expect(enabled).toContain("인증된 event action_token");
    expect(enabled).toContain("search:read.public");
    expect(enabled).toContain("요청자 live membership과 bot 읽기 권한 필요");
    expect(enabled).toContain("타 private/DM·공유 채널 불가");
    expect(enabled).toContain("channel 생략은 workspace_public 검색");
    expect(enabled).toContain("read_channel은 현재 채널만");
    expect(enabled).toContain("placeholder/재구성은 금지");
    expect(enabled).toContain("대상 채널 가입 불필요");
    expect(enabled).toContain("첨부/이미지는 현재 채널 exact-message 권한만 유지");
    expect(enabled).toContain("빈결과가 아니라 지원 불가");
    expect(enabled).toContain("권한으로 승격하지 않는다");
    expect(enabled).toContain("complete/truncated/textTruncated");
    expect(instructions).not.toContain("slack_read_thread / slack_read_channel 등록됨");
  });

  it("includes current timestamp", () => {
    expect(instructions).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
