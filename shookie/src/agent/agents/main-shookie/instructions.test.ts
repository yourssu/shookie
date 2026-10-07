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
    expect(enabled).toContain("channelName이 있으면 #채널명으로 표시하고 없으면 <#channelID>로 표시한다");
    expect(enabled).toContain("출처 permalink는 유지하고 도구 호출에는 channel ID를 사용한다");
    expect(enabled).toContain("channelName은 표시용 비신뢰 데이터");
    expect(enabled).toContain("채널 이름을 추측하거나 query/권한 근거로 사용하지 않는다");
    expect(enabled).toContain("read_channel은 현재 채널만");
    expect(enabled).toContain("placeholder/재구성은 금지");
    expect(enabled).toContain("대상 채널 가입 불필요");
    expect(enabled).toContain("첨부/이미지는 현재 채널 exact-message 권한만 유지");
    expect(enabled).toContain("빈결과가 아니라 지원 불가");
    expect(enabled).toContain("권한으로 승격하지 않는다");
    expect(enabled).toContain("complete/truncated/textTruncated");
    expect(instructions).not.toContain("slack_read_thread / slack_read_channel 등록됨");
  });

  it("keeps early identity/delegation thread scope consistent without widening current-only history or attachments", () => {
    const enabled = buildMainShookieInstructions({ toolKeys: ["slack_read_thread", "slack_read_channel", "slack_search", "slack_read_attachment", "slack_analyze_image"] });
    const identity = enabled.split("# 2. Time Awareness")[0];
    const delegation = enabled.split("# 5. Delegation Discipline")[1].split("# 6. Meta Query 처리")[0];
    expect(identity).toContain("slack_read_thread는 현재 채널 및 같은 workspace 비공유 공개 채널의 명시적 스레드만 읽는다");
    expect(identity).toContain("slack_read_channel은 현재 요청 채널의 기록만 읽는다");
    expect(delegation).toContain("slack_read_thread로 현재 채널 및 같은 workspace 비공유 공개 채널의 명시적 스레드 읽기");
    expect(delegation).toContain("slack_read_channel로 현재 요청 채널의 기록 읽기");
    for (const section of [identity, delegation]) expect(section).toContain("타 채널은 요청자 live membership과 bot 읽기 권한 필요");
    expect(enabled).not.toContain("slack_read_thread/slack_read_channel로 직접 처리한다 (현재 요청 채널 한정)");
    expect(enabled).not.toContain("현재 요청 채널의 Slack 스레드/채널 원문 읽기");
    expect(identity).toContain("slack_read_attachment로, PNG·JPEG 시각 분석은 등록된 slack_analyze_image로 직접 처리한다 (현재 채널의 정확한 메시지 첨부만)");
    expect(delegation).toContain("현재 요청 채널의 Slack 텍스트·Markdown·CSV·텍스트 PDF 첨부 읽기");
  });

  it("includes current timestamp", () => {
    expect(instructions).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
