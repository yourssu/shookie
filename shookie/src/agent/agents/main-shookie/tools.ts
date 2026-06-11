import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { logger } from "../../../logger.js";

export function createMainShookieTools(subAgents: {
  posthog?: Agent;
  codeExplorer?: Agent;
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
        const result = await posthogAgent.generate([{ role: "user", content: input.task }]);
        logger.debug("[posthog-agent] text length:", result.text?.length ?? 0);
        logger.debug("[posthog-agent] finishReason:", result.finishReason);
        logger.debug("[posthog-agent] usage:", JSON.stringify(await result.usage));
        logger.debug("[posthog-agent] steps:", result.steps?.length);
        for (const [i, step] of (result.steps ?? []).entries()) {
          for (const tc of step.toolCalls ?? []) {
            logger.debug(`[posthog-agent] step[${i}] toolCall: ${tc.payload.toolName}`, JSON.stringify(tc.payload.args));
          }
          for (const tr of step.toolResults ?? []) {
            const r = typeof tr.payload.result === "string" ? tr.payload.result : JSON.stringify(tr.payload.result);
            logger.debug(`[posthog-agent] step[${i}] toolResult:`, r.slice(0, 500));
          }
        }
        return { result: result.text };
      },
    });
  }

  if (subAgents.codeExplorer) {
    const codeExplorerAgent = subAgents.codeExplorer;
    tools.code_explorer_agent = createTool({
      id: "code-explorer-agent",
      description:
        "GitHub 리포지토리 코드 탐색 및 PR 생성을 담당하는 서브 에이전트에게 작업을 위임합니다. " +
        "코드 분석, 파일 수정, PR 생성, git/gh CLI 작업, 리포지토리 구조 파악에 사용합니다. " +
        "코드, 리포지토리, PR, 커밋, 브랜치 관련 질문은 반드시 이 에이전트에 위임하세요.",
      inputSchema: z.object({
        task: z.string().describe("서브 에이전트가 수행할 작업 설명 (사용자의 원본 질문과 필요한 컨텍스트)"),
      }),
      outputSchema: z.object({
        result: z.string(),
      }),
      execute: async (input, context) => {
        const opts: { requestContext?: RequestContext } = {};
        if (context?.requestContext) {
          opts.requestContext = context.requestContext;
        }
        const result = await codeExplorerAgent.generate(
          [{ role: "user", content: input.task }],
          { ...opts, maxSteps: 20 },
        );
        logger.debug("[code-explorer-agent] text length:", result.text?.length ?? 0);
        logger.debug("[code-explorer-agent] finishReason:", result.finishReason);
        logger.debug("[code-explorer-agent] usage:", JSON.stringify(await result.usage));
        logger.debug("[code-explorer-agent] steps:", result.steps?.length);
        for (const [i, step] of (result.steps ?? []).entries()) {
          for (const tc of step.toolCalls ?? []) {
            logger.debug(`[code-explorer-agent] step[${i}] toolCall: ${tc.payload.toolName}`, JSON.stringify(tc.payload.args));
          }
          for (const tr of step.toolResults ?? []) {
            const r = typeof tr.payload.result === "string" ? tr.payload.result : JSON.stringify(tr.payload.result);
            logger.debug(`[code-explorer-agent] step[${i}] toolResult:`, r.slice(0, 500));
          }
        }
        return { result: result.text };
      },
    });
  }

  return tools;
}
