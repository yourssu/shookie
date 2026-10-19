import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMainShookieInstructions } from "./instructions.js";
afterEach(() => vi.useRealTimers());
describe("single main policy (prompt contract, not live routing proof)", () => {
  it("keeps existing KST time handling and actual registered capabilities", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const first = buildMainShookieInstructions({ toolKeys: ["github_read", "listProjects"] });
    vi.setSystemTime(9_999_999_999_999);
    expect(buildMainShookieInstructions({ toolKeys: ["github_read", "listProjects"] })).toBe(first);
    expect(first).toContain("신뢰된 요청 시각");
    expect(first).toContain("github_read, listProjects");
    expect(first).toContain("Asia/Seoul");
  });
  it("uses only direct tools with proportional answers", () => {
    const text = buildMainShookieInstructions();
    for (const rule of ["깊은 조사 모두 등록된 직접 서비스 도구", "별도 대화 에이전트나 위임 도구는 없다", "status/source/limitations", "질문에 비례해 간결", "단순 목록", "충분한 근거", "관련된 한계만"]) expect(text).toContain(rule);
    for (const obsolete of ["반드시 sub-agent에 위임", "조정자(orchestrator)", "trusted request context"]) expect(text).not.toContain(obsolete);
  });
  it("limits routine internal format disclosure while preserving operational selection and visible limitations", () => {
    const text = buildMainShookieInstructions();
    for (const rule of ["입력 형식과 선택 제약은 일상적으로 노출하지", "확인 질문·입력 정정", "결과의 중요한 해석", "프로젝트 목록에 'ID/URL 선택 불가'를 덧붙이지", "접근 거부·부분/잘린 결과·불확실성·실패는 숨기지", "project는 반환된 이름이며 ID/URL로 선택하지", "unknown_project/no_registered_projects는 접근 불가", "정책 차단은 우회하지"]) expect(text).toContain(rule);
  });
  it("keeps live registration and security, disables Radar guidance workflows", () => {
    const text = buildMainShookieInstructions();
    for (const rule of ["유일한 live 리소스 등록", "모든 동작에서 최신 등록", "preview 소비는 비활성화", "제공하거나 약속하지", "AGENTS.md", "읽기 전용이 강제되지", "Slack 스레드 신뢰 경계", "live membership", "action_token", "nextCursor", "derived_image_interpretation", "search_snippets", "fetched_text", "비신뢰 데이터"]) expect(text).toContain(rule);
    expect(text).not.toContain("지침 업데이트 제안 워크플로우");
  });
});
