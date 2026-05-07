import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Agent } from "@mastra/core/agent";

export function createCoordinatorTools(subAgents: {
  posthog?: Agent;
}) {
  const tools: Record<string, ReturnType<typeof createTool>> = {};

  if (subAgents.posthog) {
    const posthogAgent = subAgents.posthog;
    tools.posthog_agent = createTool({
      id: "posthog-agent",
      description:
        "PostHog 분석 데이터 조회를 담당하는 서브 에이전트에게 작업을 위임합니다. " +
        "이벤트, 인사이트, 대시보드, 기능 플래그, 사용자, 코호트, 실험, HogQL 쿼리 관련 질문에 사용합니다.",
      inputSchema: z.object({
        task: z.string().describe("서브 에이전트가 수행할 작업 설명 (사용자의 원본 질문과 필요한 컨텍스트)"),
      }),
      outputSchema: z.object({
        result: z.string(),
      }),
      execute: async (input) => {
        const result = await posthogAgent.generateLegacy(input.task);
        return { result: result.text };
      },
    });
  }

  return tools;
}
