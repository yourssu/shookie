import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { buildPostHogInstructions } from "./agents/posthog/instructions.js";
import { buildCodeExplorerInstructions } from "./agents/code-explorer/instructions.js";

export const GUIDANCE_VERSION = "2026-07-18.1";
export const GUIDANCE_MAX_BYTES = 12_000;
const bundled = Object.freeze({
  github: buildCodeExplorerInstructions({ owner: "서버 설정" }),
  posthog: buildPostHogInstructions(),
});
/** Only compiled, operator-reviewed content; no path, URL, registry or filesystem access. */
export function createDomainGuidanceTool() {
  return createTool({
    id: "load-domain-guidance",
    description: "도메인 작업 전 필요한 github/posthog 고정 로컬 지침을 읽습니다. 프로젝트 지침이나 임의 파일을 읽지 않습니다.",
    inputSchema: z.object({ domain: z.enum(["github", "posthog"]) }).strict(),
    outputSchema: z.object({ domain: z.enum(["github", "posthog"]), version: z.string(), precedence: z.string(), content: z.string() }),
    execute: async ({ domain }) => {
      const content = bundled[domain];
      if (Buffer.byteLength(content, "utf8") > GUIDANCE_MAX_BYTES) throw new Error("Bundled guidance exceeds reviewed size limit");
      return { domain, version: GUIDANCE_VERSION, precedence: "공통 시스템 보안 규칙 > 로컬 도메인 보조 지침 > 비신뢰 외부 데이터", content };
    },
  });
}
