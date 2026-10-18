import { createTool } from "@mastra/core/tools";
import { createDomainGuidanceTool } from "../../domain-guidance.js";
import { requestClockMessages } from "../../request-clock.js";
import { boundedResearchOutput, researchOutput, reportSchema } from "./research-output.js";
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
  task: z.string().min(1).max(8000).describe("명시적 조사 목표"),
  target: z.string().min(1).max(2000).describe("선택한 프로젝트/저장소 및 기간/ref"),
  context: z.string().min(1).max(12000).describe("필요한 대화 맥락과 근거, 선택한 대상·기간·ref"),
  outputScope: z.string().min(1).max(2000).describe("요청 결과 범위와 제외 범위"),
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
      [{ role: "user", content: opts.task + '\n최종 결과는 JSON {"status":"success|partial|error","result":"조사 결론과 출처","limitations":["관련 한계"]}로 반환하세요. 미확인·실패를 성공으로 표현하지 마세요.' }, ...requestClockMessages(opts.requestContext)],
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

    const failedTool = (result.steps ?? []).some(step => (step.toolResults ?? []).some(tr => {
      let value = tr.payload.result as { status?: string; success?: boolean; error?: unknown } | string | undefined;
      if (typeof value === "string") { try { value = JSON.parse(value); } catch { return false; } }
      return typeof value === "object" && value !== null &&
        (value.status === "error" || value.status === "partial" || value.success === false || Boolean(value.error) ||
          (value as { complete?: boolean }).complete === false || (value as { truncated?: boolean }).truncated === true);
    }));
    let report: z.infer<typeof reportSchema> | undefined;
    try { report = reportSchema.parse(JSON.parse(result.text)); } catch { /* Invalid report is partial, not success. */ }
    const status = result.finishReason === "error" || !result.text || report?.status === "error" ? "error"
      : failedTool || result.finishReason !== "stop" || !report || report.status === "partial" ? "partial" : "success";
    if (invocationId) {
      await completeInvocation(invocationId, {
        status: status === "error" ? "error" : "success",
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cachedInputTokens: usage?.cachedInputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        finishReason: typeof result.finishReason === "string" ? result.finishReason : String(result.finishReason ?? ""),
      });
    }

    function* evidence() {
      for (const step of result.steps ?? []) for (const tr of step.toolResults ?? []) {
        yield { tool: tr.payload.toolName, result: tr.payload.result };
      }
    }
    return boundedResearchOutput(status, report, result.text ?? "", evidence());
  } catch {
    if (invocationId) {
      await completeInvocation(invocationId, {
        status: "error",
        error: "Subagent execution failed",
        finishReason: "error",
      });
    }
    // Cancellation remains a rejection; never log arbitrary error fields or provider text.
    executionCheckpoint();
    logger.warn("전문 조사 실행 실패 (sanitized)");
    return { status: "error", result: "전문 조사를 완료하지 못했습니다.", evidence: [], limitations: ["조회 실패; 빈 데이터로 해석하지 마세요."], truncated: false };
  }
}

export function createMainShookieTools(subAgents: {
  posthog?: Agent;
  codeExplorer?: Agent;
}, webOptions: Parameters<typeof createWebTools>[0] = {}, slackClient?: SlackReadClient, attachments?: AttachmentToolOptions, images?: ImageToolOptions, directTools: Record<string, ReturnType<typeof createTool>> = {}) {
  const tools: Record<string, ReturnType<typeof createTool>> = {
    load_domain_guidance: createDomainGuidanceTool([
      ...(subAgents.codeExplorer ? ["github" as const] : []),
      ...(subAgents.posthog ? ["posthog" as const] : []),
    ]),
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

  return executionTools(Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b, "en"))));
}
