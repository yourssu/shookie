import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createWebTools } from "../../../tools/web/tools.js";
import { logger } from "../../../logger.js";
import { getCurrentContext } from "../../invocation-context.js";
import {
  startInvocation,
  completeInvocation,
  logToolCall,
  type AgentName,
} from "database";

interface SubAgentDelegateOptions {
  agentName: AgentName;
  agent: Agent;
  task: string;
  maxSteps?: number;
  requestContext?: RequestContext;
}

async function delegateToSubAgent(opts: SubAgentDelegateOptions): Promise<string> {
  const parent = getCurrentContext();
  const parentInvocationId = parent?.parentInvocationId ?? null;
  const agentCallId = parent?.agentCallId;

  const invocationId = agentCallId
    ? await startInvocation({
        agentCallId,
        parentInvocationId,
        agentName: opts.agentName,
        task: opts.task,
      })
    : null;

  try {
    const generateOpts: { maxSteps?: number; requestContext?: RequestContext } = {};
    if (opts.maxSteps) generateOpts.maxSteps = opts.maxSteps;
    if (opts.requestContext) generateOpts.requestContext = opts.requestContext;

    const result = await opts.agent.generate(
      [{ role: "user", content: opts.task }],
      generateOpts,
    );
    const usage = await result.usage;

    logger.debug(`[${opts.agentName}] text length:`, result.text?.length ?? 0);
    logger.debug(`[${opts.agentName}] finishReason:`, result.finishReason);
    logger.debug(`[${opts.agentName}] usage:`, JSON.stringify(usage));
    logger.debug(`[${opts.agentName}] steps:`, result.steps?.length);

    if (invocationId) {
      for (const [i, step] of (result.steps ?? []).entries()) {
        const toolCalls = step.toolCalls ?? [];
        const toolResults = step.toolResults ?? [];
        const resultsById = new Map<string, unknown>();
        for (const tr of toolResults) {
          const id = (tr.payload as { id?: string; toolCallId?: string }).id
            ?? (tr.payload as { toolCallId?: string }).toolCallId;
          if (id) resultsById.set(id, tr.payload.result);
        }
        for (const tc of toolCalls) {
          const id = (tc.payload as { id?: string; toolCallId?: string }).id
            ?? (tc.payload as { toolCallId?: string }).toolCallId;
          const toolName = tc.payload.toolName;
          const input = (tc.payload as { args?: unknown }).args;
          const output = id ? resultsById.get(id) : undefined;
          await logToolCall({
            invocationId,
            stepIndex: i,
            toolName,
            input,
            output,
          });
        }
      }
    }

    for (const [i, step] of (result.steps ?? []).entries()) {
      for (const tc of step.toolCalls ?? []) {
        logger.debug(`[${opts.agentName}] step[${i}] toolCall: ${tc.payload.toolName}`, JSON.stringify(tc.payload.args));
      }
      for (const tr of step.toolResults ?? []) {
        const r = typeof tr.payload.result === "string" ? tr.payload.result : JSON.stringify(tr.payload.result);
        logger.debug(`[${opts.agentName}] step[${i}] toolResult:`, r.slice(0, 500));
      }
    }

    if (invocationId) {
      await completeInvocation(invocationId, {
        status: "success",
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cachedInputTokens: usage?.cachedInputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        finishReason: typeof result.finishReason === "string" ? result.finishReason : String(result.finishReason ?? ""),
      });
    }

    return result.text;
  } catch (err) {
    if (invocationId) {
      await completeInvocation(invocationId, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        finishReason: "error",
      });
    }
    throw err;
  }
}

export function createMainShookieTools(subAgents: {
  posthog?: Agent;
  codeExplorer?: Agent;
}, webOptions: Parameters<typeof createWebTools>[0] = {}) {
  const tools: Record<string, ReturnType<typeof createTool>> = { ...createWebTools(webOptions) };

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
        const result = await delegateToSubAgent({
          agentName: "posthog",
          agent: posthogAgent,
          task: input.task,
        });
        return { result };
      },
    });
  }

  if (subAgents.codeExplorer) {
    const codeExplorerAgent = subAgents.codeExplorer;
    tools.code_explorer_agent = createTool({
      id: "code-explorer-agent",
      description:
        "코드 탐색은 이 서브 에이전트에 위임합니다. 실제 지원 범위: " + (codeExplorerAgent.getDescription?.() ?? "등록된 읽기 도구를 사용합니다. 상세 지원 범위는 도구 결과로 확인하세요.") +
        " 파일 수정·명령 실행·push·PR 생성/병합/삭제 권한은 없습니다.",
      inputSchema: z.object({
        task: z.string().describe("서브 에이전트가 수행할 작업 설명 (사용자의 원본 질문과 필요한 컨텍스트)"),
      }),
      outputSchema: z.object({
        result: z.string(),
      }),
      execute: async (input, context) => {
        const opts: { requestContext?: RequestContext; maxSteps: number } = { maxSteps: 40 };
        if (context?.requestContext) {
          opts.requestContext = context.requestContext;
        }
        const result = await delegateToSubAgent({
          agentName: "code-explorer",
          agent: codeExplorerAgent,
          task: input.task,
          ...opts,
        });
        return { result };
      },
    });
  }

  return tools;
}
