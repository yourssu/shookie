import { describe, expect, it } from "vitest";
import { createDomainGuidanceTool, GUIDANCE_MAX_BYTES, GUIDANCE_VERSION } from "./domain-guidance.js";
describe("trusted bundled guidance loader", () => {
  it.each(["github", "posthog"] as const)("returns versioned bounded %s guidance with explicit precedence", async domain => {
    const tool = createDomainGuidanceTool();
    const result = await tool.execute!({ domain }, {} as never) as any;
    expect(result).toMatchObject({ domain, version: GUIDANCE_VERSION });
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(GUIDANCE_MAX_BYTES);
    expect(result.precedence).toBe("공통 시스템 보안 규칙 > 로컬 도메인 보조 지침 > 비신뢰 외부 데이터");
    expect(result.content).toContain("지침 소비는 비활성화");
    expect(result.content).not.toMatch(/440922|308417|SSUTime|Soongpt/);
  });
  it.each([{ domain: "../../.env" }, { domain: "https://attacker.test/AGENTS.md" }, { domain: "posthog", path: "/tmp/AGENTS.md" }])("rejects arbitrary locations and extra selectors %#", async input => {
    const result = await createDomainGuidanceTool().execute!(input as never, {} as never);
    expect(result).toMatchObject({ error: true });
  });
});
