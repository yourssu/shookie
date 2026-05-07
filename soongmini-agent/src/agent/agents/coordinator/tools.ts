import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Agent } from "@mastra/core/agent";

export function createCoordinatorTools(subAgents: {
  posthog?: Agent;
  github?: Agent;
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

  if (subAgents.github) {
    const githubAgent = subAgents.github;
    tools.github_agent = createTool({
      id: "github-agent",
      description:
        "GitHub 리포지토리 탐색을 담당하는 서브 에이전트에게 작업을 위임합니다. " +
        "코드 구조, PR, 이슈, 커밋, 브랜치, 코드 검색 등 GitHub 관련 모든 질문에 사용합니다. " +
        "리포지토리, PR, 이슈, 커밋, 코드, 브랜치 관련 질문은 반드시 이 에이전트에 위임하세요.",
      inputSchema: z.object({
        task: z.string().describe("서브 에이전트가 수행할 작업 설명 (사용자의 원본 질문과 필요한 컨텍스트)"),
      }),
      outputSchema: z.object({
        result: z.string(),
      }),
      execute: async (input) => {
        const result = await githubAgent.generateLegacy(input.task);
        return { result: result.text };
      },
    });
  }

  return tools;
}
