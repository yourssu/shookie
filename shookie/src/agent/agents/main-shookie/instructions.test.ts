import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMainShookieInstructions } from "./instructions.js";
afterEach(() => vi.useRealTimers());
describe("compact common policy", () => {
  it("keeps a stable common prefix across time, advertises only registered tool keys", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const first = buildMainShookieInstructions({ toolKeys: ["github_read", "listProjects"] });
    vi.setSystemTime(9_999_999_999_999);
    expect(buildMainShookieInstructions({ toolKeys: ["github_read", "listProjects"] })).toBe(first);
    expect(first).toContain("등록 도구(고정 순서): github_read, listProjects");
    expect(buildMainShookieInstructions()).toContain("등록 도구(고정 순서): 없음");
    expect(Buffer.byteLength(first)).toBeLessThan(10_000);
  });
  it("uses direct routine tools, optional bounded research and proportional concise replies", () => {
    const text = buildMainShookieInstructions();
    for (const rule of ["메인이 직접", "의무 위임은 없다", "목표·필요한 맥락·출력 범위", "status/evidence/limitations", "질문에 비례해 간결", "별도 모델 재작성 없이", "사용자 질문 반복"]) expect(text).toContain(rule);
    expect(text).not.toContain("반드시 sub-agent에 위임");
  });
  it("keeps live registry authorization but defers project guidance and forbids arbitrary AGENTS ingestion", () => {
    const text = buildMainShookieInstructions();
    for (const rule of ["유일한 live 리소스 등록/인가", "매 동작 새로 확인", "지침 소비는 꺼져", "프로젝트별 지침 관리 재설계는 보류", "AGENTS.md 자동 실행", "저장·업데이트·다음 조회 반영을 약속하지"]) expect(text).toContain(rule);
  });
  it("preserves Slack authority, fresh reference permissions and transport security boundaries", () => {
    const text = buildMainShookieInstructions();
    for (const rule of ["Slack 원문이 대화 권위", "선택 대상·기간·ref", "만료·생략", "최신 데이터는 다시 조회", "RequestContext", "private/DM·공유", "live membership", "action_token", "nextCursor", "unsupported", "exact-message", "derived_image_interpretation", "후보 메타데이터만", "search_snippets", "fetched_text", "비신뢰 데이터", "channelName/author.displayName", "진행/제어 메시지", "stack trace"]) expect(text).toContain(rule);
  });
});
