import type { App } from "@slack/bolt";
import { CancellationRegistry } from "../cancellation/request-registry.js";
import { registerCancellationAction, SlackRequestControls, STOP_TEXT } from "../cancellation/slack-controls.js";
import { scopedSlackClient, slackDelivery, SlackCooldown } from "../cancellation/slack-transport.js";
import { executionCheckpoint, executionSignal, type ExecutionScope } from "../cancellation/execution-context.js";
import { ConversationStoppedError } from "../cancellation/conversation-control.js";
import type { KnownBlock } from "@slack/types";
import type { Agent } from "@mastra/core/agent";
import { bindRequestClock, requestClockMessages } from "../agent/request-clock.js";
import { RequestContext } from "@mastra/core/request-context";
import { createHash } from "node:crypto";
import type { Message } from "../services/memory/in-memory.js";
import { ConversationRuntime, ConversationBusyError, ConversationInputError } from "./conversation-runtime.js";
import { convertMarkdownToBlocks } from "./markdown-to-blocks.js";
import { deliverFinalAnswer } from "./final-delivery.js";
import { LiveAnswer } from "./live-answer.js";
import { canonicalAnswer, IncompleteAnswerError } from "./canonical-answer.js";
import { getCurrentChannel } from "./assistant.js";
import type { ShookieBlock } from "../types/block.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { createRequestMetrics, monotonicNow, type RequestMetrics } from "../telemetry/metrics.js";
import { ensureThreadCapacity } from "../tools/code-explorer/workspace-manager.js";
import {
  conversationRepository,
  type ConversationEvent,
  type ConversationRepository,
  logAgentCall,
  startAgentCall,
  completeAgentCall,
  startInvocation,
  completeInvocation,
  logToolCall,
} from "database";
import { budgetSlackThread, readSlackThread, SlackThreadContextError, THREAD_CONTEXT_ERROR_TEXT,
  type ThreadSummarizer } from "./slack-thread-source.js";
import { summarizeThread } from "./thread-summarizer.js";
import { bindSlackReadContext } from "../tools/slack/context.js";
import { projectEventAttachments, type AttachmentCandidates } from "../tools/attachments/event-metadata.js";

// Do not persist/debug-log Slack read arguments, opaque cursors or fetched participant text.
const isSlackReadTool = (toolName: string) => ["slack_search", "slack_read_thread", "slack_read_channel", "slack_read_attachment", "slack_analyze_image"].includes(toolName);
const safeToolLog = (toolName: string, value: unknown): unknown =>
  isSlackReadTool(toolName) ? { redacted: true } : value;

/**
 * chat.postMessage 래퍼 — 스트리밍 실패 시 폴백 등 여러 곳에서 중복 사용.
 * ShookieBlock[]은 context_actions를 포함할 수 있어 KnownBlock[]로 캐스팅.
 */
async function postToThread(
  app: App,
  channel: string,
  threadTs: string,
  text: string,
  blocks?: ShookieBlock[],
): Promise<void> {
  const res = await slackDelivery(app, client => client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
    ...(blocks ? { blocks: blocks as KnownBlock[] } : {}),
  }));
  if (!res.ok || !res.ts) throw new Error("Thread delivery unconfirmed");
}

export function registerHandlers(
  app: App,
  agent: Agent,
  repository: ConversationRepository = conversationRepository,
  summarize: ThreadSummarizer = summarizeThread,
): void {
  const runtime = new ConversationRuntime(repository);
  const registry = new CancellationRegistry();
  registerCancellationAction(app, registry);
  const receive = async (kind: "app_mention" | "message", raw: unknown, body: unknown, context: unknown) => {
    const receivedAt = monotonicNow();
    let metrics: RequestMetrics | undefined;
    let executionScope: ExecutionScope | undefined;
    const event = raw as { channel?: string; channel_type?: string; ts?: string; thread_ts?: string;
      user?: string; team?: string; text?: string; bot_id?: string; subtype?: string; action_token?: unknown; files?: unknown };
    // Only original human messages. Edits/deletes and bot/system subtypes cannot trigger runs.
    if (event.bot_id || event.subtype || !event.user || !event.channel || !event.ts) return;
    if (kind === "message" && event.channel_type !== "im") return;
    const envelope = body as { event_id?: string; team_id?: string };
    const trusted = context as { botUserId?: string; botId?: string; teamId?: string };
    const teamId = envelope.team_id ?? event.team ?? trusted.teamId;
    const threadTs = event.thread_ts ?? event.ts;
    const sessionId = JSON.stringify([teamId ?? null, event.channel, threadTs]);
    const requestId = envelope.event_id
      ? `slack-event:${envelope.event_id}`
      : `slack-fallback:${createHash("sha256").update(JSON.stringify([teamId ?? null, event.channel, event.ts, event.user])).digest("hex")}`;
    // Remove only this bot's mention; preserve other users' identities.
    const rawText = event.text ?? "";
    const attachments = projectEventAttachments(event.files, { channelId: event.channel, messageTs: event.ts, threadTs });
    const text = (trusted.botUserId ? rawText.split(`<@${trusted.botUserId}>`).join("") : rawText).trim() ||
      (attachments.files.length ? "첨부 파일을 확인해 주세요." : "");
    if (!text && kind === "message") return;
    const identity: ConversationEvent = {
      sessionId, requestId, channel: event.channel, threadTs, userId: event.user,
      ...(teamId ? { teamId } : {}), ...(envelope.event_id ? { eventId: envelope.event_id } : {}),
    };
    const isMention = kind === "app_mention" && event.channel_type !== "im" && !event.channel.startsWith("D");
    const isThreadReply = isMention && threadTs !== event.ts;
    const slackContext = isMention ? async (): Promise<Message[]> => {
      if (!isThreadReply) return [{ role: "user", content: text }];
      const source = await readSlackThread(scopedSlackClient(app, executionSignal()!), {
        channel: identity.channel, threadTs, currentTs: event.ts!, userId: identity.userId,
        botUserId: trusted.botUserId, botId: trusted.botId,
      });
      return budgetSlackThread(source, summarize);
    } : undefined;
    const controls = new SlackRequestControls(app, registry, identity);
    try {
      await runtime.run(identity, text, async (messages, commit, scope) => {
        if (!text && !isThreadReply) {
          const greeting = "네, 무엇을 도와드릴까요?";
          if (metrics) metrics.save = "running";
          await commit(greeting);
          if (metrics) metrics.save = "success";
          metrics?.startDelivery();
          try {
            await postToThread(app, identity.channel, threadTs, greeting);
            metrics?.endDelivery(true);
          } catch (error) { metrics?.endDelivery(false); throw error; }
          controls.markDelivered();
          return;
        }
        // Keep the original event-only selection and its single read; never supply a fallback.
        const actionToken = event.action_token;
        await handleConversation(app, agent, text, identity, messages, commit, scope, actionToken, attachments, () => controls.markDelivered(), stage => controls.markFailure(stage), controls.cooldown);
      }, slackContext, scope => {
        executionScope = scope;
        metrics = createRequestMetrics(receivedAt);
        scope.metrics = metrics;
        return controls.start(scope);
      });
    } catch (error) {
      logger.error("대화 처리 실패", { requestId, kind: error instanceof Error ? error.name : "unknown" });
      const errorText = error instanceof ConversationStoppedError ? STOP_TEXT[error.reason]
        : error instanceof IncompleteAnswerError && error.limited
          ? "답변 생성 한도에 도달해 완료하지 못했어요. 질문 범위를 줄여 다시 요청해 주세요."
        : error instanceof SlackThreadContextError
        ? THREAD_CONTEXT_ERROR_TEXT
        : error instanceof ConversationBusyError
        ? "현재 요청이 많습니다. 잠시 후 다시 시도해주세요."
        : error instanceof ConversationInputError
          ? "메시지가 너무 깁니다. 내용을 나누어 보내주세요."
          : "대화를 안전하게 처리하지 못했습니다. 잠시 후 새 메시지로 다시 시도해주세요.";
      if (!controls.stopNotified) {
        try { await postToThread(app, identity.channel, threadTs, errorText); } catch { /* bounded delivery, no duplicate error */ }
      }
    } finally {
      try { await controls.finish(); } finally {
        if (metrics) {
          const reason: unknown = executionScope?.control.signal.reason;
          if (reason instanceof ConversationStoppedError) metrics.stop = reason.reason === "timed_out" ? "timeout" : "cancelled";
          if (metrics.save === "running") metrics.save = "error";
          metrics.finish();
        }
      }
    }
  };
  app.event("app_mention", async ({ event, body, context }) => receive("app_mention", event, body, context));
  app.event("message", async ({ event, body, context }) => receive("message", event, body, context));
}

async function handleConversation(
  app: App,
  agent: Agent,
  userText: string,
  identity: ConversationEvent,
  messages: Message[],
  commit: (answer: string) => Promise<void>,
  scope: ExecutionScope,
  actionToken?: unknown,
  attachments?: AttachmentCandidates,
  onDelivered: () => void = () => {},
  onFailure: (stage: "generation" | "save" | "limit") => void = () => {},
  cooldown = new SlackCooldown(),
): Promise<void> {
  const { channel, threadTs, userId, teamId, requestId } = identity;
  let mainInvocationId: number | null = null;
  const metrics = scope.metrics;
  const preview = new LiveAnswer(app, { channel, threadTs }, scope.control.signal, cooldown, () => metrics?.confirmedText());
  let saving = false;

  try {
    logger.info(`📩 메시지 수신: "${userText.slice(0, 100)}"`);

    await ensureThreadCapacity(config.THREAD_WORKSPACE_BASE_PATH, config.THREAD_WORKSPACE_MAX_GB);

    const currentChannel = getCurrentChannel(threadTs);

    const callCtx = await startAgentCall({ userId, channel, threadTs, question: userText });
    mainInvocationId = callCtx
      ? await startInvocation({
          agentCallId: callCtx.agentCallId,
          parentInvocationId: null,
          agentName: "main-shookie",
          task: userText,
        })
      : null;

    // Only root-run public assistant prose may appear as an explicitly provisional preview.

    const runConversation = async () => {
      executionCheckpoint();
      logger.info("🤖 응답 스트리밍 시작...");
      const requestContext = new RequestContext([
        ["channel", channel],
        ["threadTs", threadTs],
        ["userId", userId],
        ["requestId", requestId],
        ...(teamId ? [["teamId", teamId] as [string, string]] : []),
      ]);
      bindRequestClock(requestContext);
      // Only authenticated event metadata authorizes explicit Slack reads, never model/user text
      // or the threadTs-only Assistant view hint. Missing team fails closed for read tools.
      if (teamId) bindSlackReadContext(requestContext, { channel, userId, teamId, requestId }, actionToken);
      // Preserve Assistant current-view hints without flattening conversation roles.
      // This is a hint, never an actor identity or authorization source (the legacy map is threadTs-only).
      const modelMessages = currentChannel && /^[A-Z][A-Z0-9]{1,63}$/.test(currentChannel)
        ? [{ role: "system" as const, content: `[사용자가 현재 보고 있는 채널 ID (참고 정보): ${currentChannel}]` }, ...messages]
        : messages;
      // Candidate metadata is ephemeral user data, never trusted identity or a persisted file grant.
      const withAttachments = attachments?.files.length
        ? [...modelMessages, { role: "user" as const, content: JSON.stringify(attachments) }]
        : modelMessages;
      metrics?.startGeneration();
      let modelStepsRecorded = 0;
      const streamResult = await agent.stream([...withAttachments, ...requestClockMessages(requestContext)], {
        maxSteps: config.MAX_TOOL_ITERATIONS,
        runId: requestId,
        requestContext,
        abortSignal: scope.control.signal,
        onStepFinish: step => {
          const index = modelStepsRecorded++;
          try { metrics?.model(index, step.usage); } catch { /* callback must never fail generation */ }
        },
      });

      const toolNamesSeen: string[] = [];

      const reader = streamResult.fullStream.getReader();
      try {
        while (true) {
          executionCheckpoint();
          const { done, value } = await reader.read();
          executionCheckpoint();
          if (done) break;

          if (value.type === "text-delta" && value.from === "AGENT" && value.runId === requestId &&
            typeof (value.payload as { text?: unknown })?.text === "string" && (value.payload as { text: string }).text.length) metrics?.firstDelta();
          preview.event(value, requestId);
          if (value.type === "error" || value.type === "abort") throw new Error("Agent stream failed");
          if (value.type === "tool-call") {
            const payload = (value as {
              payload: { toolName: string; id?: string; toolCallId?: string; args?: unknown };
            }).payload;
            const toolName = payload.toolName;
            if (!toolNamesSeen.includes(toolName)) {
              toolNamesSeen.push(toolName);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      logger.info("🤖 응답 스트리밍 완료");

      const usage = await streamResult.usage;
      const steps = await streamResult.steps;
      const finishReason = await streamResult.finishReason;
      executionCheckpoint();
      // Fallback for adapters without callbacks; never add aggregate usage to step usage.
      if (!modelStepsRecorded) for (const [index, step] of steps.entries()) metrics?.model(index, step.usage);
      const responseText = canonicalAnswer(steps, finishReason);
      metrics?.endGeneration("success");

      return { streamResult, responseText, usage, steps, finishReason, toolNamesSeen };
    };

    const conv = await runConversation();

    const { responseText, usage, steps, finishReason, toolNamesSeen } = conv;
    executionCheckpoint();
    // Save the complete successful turn before ancillary logging or final Slack delivery.
    // Neither delivery nor logging failures may discard an already generated answer.
    await preview.seal();
    executionCheckpoint();
    saving = true;
    if (metrics) metrics.save = "running";
    await commit(responseText);
    if (metrics) metrics.save = "success";
    preview.markSaved();
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const { blocks, fallbackText } = convertMarkdownToBlocks(responseText, "", { withFeedback: true });
    // Deliver before ancillary DB logging, but delivery failure must not skip success logging.
    let delivered = false;
    metrics?.startDelivery();
    try {
      const reconciled = await preview.finalize(fallbackText, blocks);
      if (!reconciled) await slackDelivery(app, (deliveryClient, signal) => deliverFinalAnswer(deliveryClient, {
        channel, threadTs, teamId, userId, markdown: responseText, fallbackText, blocks,
      }, signal, () => metrics?.confirmedText()));
      delivered = true;
      metrics?.endDelivery(true);
      onDelivered();
    } catch {
      metrics?.endDelivery(false);
      logger.warn("성공 대화 저장 이후 최종 응답 전송 실패", { requestId });
      // No misleading failure reply or state reversal; persist-success logging continues below.
    }

    if (delivered) {
      if (toolNamesSeen.some(isSlackReadTool)) logger.info("📤 Slack 조회 응답 전송", { textLen: responseText.length });
      else logger.info(`📤 응답 전송: "${responseText.slice(0, 150)}..."`);
    }
    // Only normally stopped canonical answers reach success logging.
    const finishReasonLabel = typeof finishReason === "string" ? finishReason : String(finishReason ?? "?");
    logger.info(
      `[diagnostic] finishReason=${finishReasonLabel} steps=${steps.length} textLen=${responseText.length} inputTokens=${inputTokens} outputTokens=${outputTokens}`,
    );

    for (const [i, step] of steps.entries()) {
      logger.debug(`--- step[${i}] ---`);
      logger.debug(`step[${i}] text length:`, step.text?.length ?? 0);

      for (const tc of step.toolCalls ?? []) {
        logger.debug(`step[${i}] toolCall: ${tc.payload.toolName}`, JSON.stringify(safeToolLog(tc.payload.toolName, tc.payload.args)));
      }
      for (const tr of step.toolResults ?? []) {
        const safe = safeToolLog(tr.payload.toolName, tr.payload.result);
        const r = typeof safe === "string" ? safe : JSON.stringify(safe);
        logger.debug(`step[${i}] toolResult:`, r.slice(0, 500));
      }
    }

    if (callCtx && mainInvocationId) {
      for (const [i, step] of steps.entries()) {
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
            invocationId: mainInvocationId,
            stepIndex: i,
            toolName,
            input: safeToolLog(toolName, input),
            output: safeToolLog(toolName, output),
          });
        }
      }

      await completeInvocation(mainInvocationId, {
        status: "success",
        inputTokens,
        outputTokens,
        cachedInputTokens: usage?.cachedInputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        finishReason: typeof finishReason === "string" ? finishReason : String(finishReason ?? ""),
      });

      await completeAgentCall(callCtx.agentCallId, {
        answer: responseText,
        toolsUsed: [...new Set(toolNamesSeen)],
        inputTokens,
        outputTokens,
      });
    } else {
      await logAgentCall({
        userId,
        channel,
        threadTs,
        question: userText,
        answer: responseText,
        toolsUsed: [...new Set(toolNamesSeen)],
        inputTokens,
        outputTokens,
      });
    }

  } catch (error) {
    if (scope.control.isCommitted) {
      logger.warn("성공 대화 저장 이후 부가 처리 실패", { requestId });
      return;
    }
    const limited = error instanceof IncompleteAnswerError && error.limited;
    if (metrics?.generation === "running") metrics.endGeneration(limited ? "limited" : error instanceof ConversationStoppedError ? "cancelled" : "error");
    if (metrics?.save === "running") metrics.save = "error";
    if (limited) preview.markLimited();
    onFailure(limited ? "limit" : saving ? "save" : "generation");
    logger.error("대화 실행 실패", { requestId, kind: error instanceof Error ? error.name : "unknown" });
    if (mainInvocationId) {
      await completeInvocation(mainInvocationId, {
        status: "error",
        error: "Conversation execution failed",
        finishReason: "error",
      });
    }
    throw error;
  } finally {
    await preview.cleanup();
  }
}
