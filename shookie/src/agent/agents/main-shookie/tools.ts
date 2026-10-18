import { createTool } from "@mastra/core/tools";
import { createDomainGuidanceTool } from "../../domain-guidance.js";
import { executionTools, executionSignal, executionCheckpoint } from "../../../cancellation/execution-context.js";
import { z } from "zod";
import type { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createWebTools } from "../../../tools/web/tools.js";
import { createSlackReadTools } from "../../../tools/slack/tools.js";
import { createAttachmentTools, type AttachmentToolOptions } from "../../../tools/attachments/tools.js";
import { createImageTools, type ImageToolOptions } from "../../../tools/images/tools.js";
import type { SlackReadClient } from "../../../tools/slack/client.js";
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

const researchInput = z.object({
  task: z.string().max(8000).describe("명시적 조사 목표"),
  context: z.string().max(12000).describe("필요한 대화 맥락과 근거, 선택한 대상·기간·ref"),
  outputScope: z.string().max(2000).describe("요청 결과 범위와 제외 범위"),
});
const researchOutput = z.object({
  status: z.enum(["success", "partial", "error"]), result: z.string(),
  evidence: z.array(z.string()), limitations: z.array(z.string()),
});
async function delegateToSubAgent(opts: SubAgentDelegateOptions): Promise<z.infer<typeof researchOutput>> {
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
    executionCheckpoint();
    const generateOpts: { maxSteps?: number; requestContext?: RequestContext; abortSignal?: AbortSignal } = { abortSignal: executionSignal() };
    if (opts.maxSteps) generateOpts.maxSteps = opts.maxSteps;
    if (opts.requestContext) generateOpts.requestContext = opts.requestContext;

    const result = await opts.agent.generate(
      [{ role: "user", content: opts.task }],
      generateOpts,
    );
    executionCheckpoint();
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
        status: result.finishReason === "error" || !result.text ? "error" : "success",
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cachedInputTokens: usage?.cachedInputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        finishReason: typeof result.finishReason === "string" ? result.finishReason : String(result.finishReason ?? ""),
      });
    }

    const failedTool = (result.steps ?? []).some(step => (step.toolResults ?? []).some(tr => {
      let value = tr.payload.result as { status?: string; success?: boolean; error?: unknown } | string | undefined;
      if (typeof value === "string") { try { value = JSON.parse(value); } catch { return false; } }
      return typeof value === "object" && value !== null &&
        (value.status === "error" || value.success === false || value.error === true);
    }));
    const status = result.finishReason === "error" || !result.text ? "error"
      : failedTool || result.finishReason !== "stop" ? "partial" : "success";
    return { status, result: result.text ?? "", evidence: (result.steps ?? []).flatMap(step =>
      (step.toolResults ?? []).map(tr => tr.payload.toolName)),
      limitations: status === "success" ? ["근거 목록은 호출 도구명이며 원문 출처와 한계는 result에서 확인해야 합니다."] : ["조사 미완료 또는 도구 실패; 완전한 성공으로 해석하지 마세요."] };
  } catch (err) {
    if (invocationId) {
      await completeInvocation(invocationId, {
        status: "error",
        error: "Subagent execution failed",
        finishReason: "error",
      });
    }
    executionCheckpoint();
    return { status: "error", result: "전문 조사를 완료하지 못했습니다.", evidence: [], limitations: ["조회 실패; 빈 데이터로 해석하지 마세요."] };
  }
}

export function createMainShookieTools(subAgents: {
  posthog?: Agent;
  codeExplorer?: Agent;
}, webOptions: Parameters<typeof createWebTools>[0] = {}, slackClient?: SlackReadClient, attachments?: AttachmentToolOptions, images?: ImageToolOptions, directTools: Record<string, ReturnType<typeof createTool>> = {}) {
  const tools: Record<string, ReturnType<typeof createTool>> = {
    load_domain_guidance: createDomainGuidanceTool(),
    ...directTools,
    ...createWebTools(webOptions),
    ...(slackClient ? createSlackReadTools(slackClient) : {}),
    ...(attachments ? createAttachmentTools(attachments) : {}),
    ...(images ? createImageTools(images) : {}),
  };

  if (subAgents.posthog) {
    const posthogAgent = subAgents.posthog;
    tools.posthog_agent = createTool({
      id: "posthog-agent",
      description:
        "깊고 맥락이 큰 PostHog 조사에만 선택적으로 사용합니다. 일반 조회·목록은 직접 도구를 사용하세요.",
      inputSchema: researchInput,
      outputSchema: researchOutput,
      execute: async (input, context) => {
        const result = await delegateToSubAgent({
          agentName: "posthog",
          agent: posthogAgent,
          task: JSON.stringify(input),
          requestContext: context?.requestContext,
        });
        return result;
      },
    });
  }

  if (subAgents.codeExplorer) {
    const codeExplorerAgent = subAgents.codeExplorer;
    tools.code_explorer_agent = createTool({
      id: "code-explorer-agent",
      description:
        "깊고 맥락이 큰 코드 조사에만 선택적으로 사용합니다. 일반 GitHub 조회·목록은 직접 도구를 사용하세요. " +
        (codeExplorerAgent.getDescription?.() ?? "상세 지원 범위는 도구 결과로 확인") +
        " 파일 수정·명령 실행·push·PR 생성/병합/삭제 권한은 없습니다.",
      inputSchema: researchInput,
      outputSchema: researchOutput,
      execute: async (input, context) => {
        const opts: { requestContext?: RequestContext; maxSteps: number } = { maxSteps: 40 };
        if (context?.requestContext) {
          opts.requestContext = context.requestContext;
        }
        const result = await delegateToSubAgent({
          agentName: "code-explorer",
          agent: codeExplorerAgent,
          task: JSON.stringify(input),
          ...opts,
        });
        return result;
      },
    });
  }

  return executionTools(tools);
}
