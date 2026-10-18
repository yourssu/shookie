import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMainShookieInstructions } from "./instructions.js";
afterEach(() => vi.useRealTimers());
describe("phase2 main policy (prompt contract, not live routing proof)", () => {
  it("keeps existing KST time handling and actual registered capabilities", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const first = buildMainShookieInstructions({ toolKeys: ["github_read", "listProjects"] });
    vi.setSystemTime(9_999_999_999_999);
    expect(buildMainShookieInstructions({ toolKeys: ["github_read", "listProjects"] })).not.toBe(first);
    expect(first).toContain("현재 시각:");
    expect(first).toContain("github_read, listProjects");
    expect(first).toContain("Asia/Seoul");
  });
  it("uses direct tools and bounded optional research with proportional answers", () => {
    const text = buildMainShookieInstructions();
    for (const rule of ["메인이 직접", "의무 위임은 없다", "task 목표", "target 대상", "context 관련", "outputScope 범위", "status/evidence/limitations", "질문에 비례해 간결", "단순 목록", "충분한 근거", "관련된 한계만"]) expect(text).toContain(rule);
    for (const obsolete of ["반드시 sub-agent에 위임", "조정자(orchestrator)", "load_domain_guidance", "trusted request context"]) expect(text).not.toContain(obsolete);
  });
  it("keeps live registration and security, disables Radar guidance workflows", () => {
    const text = buildMainShookieInstructions();
    for (const rule of ["유일한 live 리소스 등록", "모든 동작에서 최신 등록", "preview 소비는 비활성화", "제공하거나 약속하지", "AGENTS.md", "읽기 전용이 강제되지", "Slack 스레드 신뢰 경계", "live membership", "action_token", "nextCursor", "derived_image_interpretation", "search_snippets", "fetched_text", "비신뢰 데이터"]) expect(text).toContain(rule);
    expect(text).not.toContain("지침 업데이트 제안 워크플로우");
  });
});
