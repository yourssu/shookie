import type { App } from "@slack/bolt";
import { CancellationRegistry } from "../cancellation/request-registry.js";
import { registerCancellationAction, SlackRequestControls, STOP_TEXT } from "../cancellation/slack-controls.js";
import { scopedSlackClient, slackDelivery } from "../cancellation/slack-transport.js";
import { executionCheckpoint, executionSignal, executionOperation, type ExecutionScope } from "../cancellation/execution-context.js";
import { ConversationStoppedError } from "../cancellation/conversation-control.js";
import type { KnownBlock } from "@slack/types";
import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { createHash } from "node:crypto";
import type { Message } from "../services/memory/in-memory.js";
import { ConversationRuntime, ConversationBusyError, ConversationInputError } from "./conversation-runtime.js";
import { convertMarkdownToBlocks } from "./markdown-to-blocks.js";
import {
  startPlanStream,
  appendTaskUpdate,
  stopStreamWithBlocks,
  type StreamSession,
} from "./streaming.js";
import { getCurrentChannel } from "./assistant.js";
import type { ShookieBlock } from "../types/block.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
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
import { invocationStorage } from "../agent/invocation-context.js";
import { budgetSlackThread, readSlackThread, SlackThreadContextError, THREAD_CONTEXT_ERROR_TEXT,
  type ThreadSummarizer } from "./slack-thread-source.js";
import { summarizeThread } from "./thread-summarizer.js";
import { bindSlackReadContext } from "../tools/slack/context.js";
import { logSlackTokenReceive, logSlackTokenSelection, logSlackTokenBinding } from "../tools/slack/action-token-diagnostics.js";
import { projectEventAttachments, type AttachmentCandidates } from "../tools/attachments/event-metadata.js";

const TOOL_PROGRESS_MESSAGES: Record<string, string> = {
  posthog_agent: "🔍 PostHog 데이터 분석 중...",
  code_explorer_agent: "🔬 코드 탐색 중...",
  slack_read_thread: "💬 현재 채널 스레드 읽는 중...",
  slack_read_channel: "💬 현재 채널 기록 읽는 중...",
  slack_search: "💬 Slack 검색 지원 확인 중...",
  slack_read_attachment: "📎 Slack 첨부 텍스트 읽는 중...",
  slack_analyze_image: "🖼️ Slack 이미지 분석 중...",
};

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
  await slackDelivery(app, client => client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
    ...(blocks ? { blocks: blocks as KnownBlock[] } : {}),
  }));
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
    logSlackTokenReceive(requestId, kind, raw, body, context);
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
          await commit(greeting);
          await postToThread(app, identity.channel, threadTs, greeting);
          return;
        }
        // Keep the original event-only selection and its single read; diagnostics never supply a fallback.
        const actionToken = event.action_token;
        logSlackTokenSelection(requestId, kind, actionToken);
        await handleConversation(app, agent, text, identity, messages, commit, scope, actionToken, attachments, kind);
      }, slackContext, scope => controls.start(scope));
    } catch (error) {
      logger.error("대화 처리 실패", { requestId, kind: error instanceof Error ? error.name : "unknown" });
      const errorText = error instanceof ConversationStoppedError ? STOP_TEXT[error.reason]
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
    } finally { await controls.finish(); }
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
  eventKind: "app_mention" | "message" = "message",
): Promise<void> {
  const { channel, threadTs, userId, teamId, requestId } = identity;
  let mainInvocationId: number | null = null;
  let streamSession: StreamSession | null = null;
  const client = scopedSlackClient(app, scope.control.signal);

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

    // Slack plan 스트림 열기 (실패 시 폴백: 이후 도구/최종 응답은 chat.postMessage로)
    try {
      logger.info(`[streaming] startPlanStream 호출: channel=${channel} threadTs=${threadTs} teamId=${teamId ?? "(없음)"} userId=${userId}`);
      const openedSession = await executionOperation(async () => {
        const session = await startPlanStream(client, channel, threadTs, teamId, userId);
        // Retain a known successful creation before the post-operation deadline check.
        // Even a late result must be stopped using its actual Slack timestamp.
        streamSession = session;
        return session;
      });
      logger.info(`[streaming] plan 스트림 열림: ts=${openedSession.messageTs}`);
    } catch (err) {
      executionCheckpoint(); // Stopped execution goes to bounded cleanup, not model/fallback work.
      logger.warn(
        "[streaming] startPlanStream 실패, postMessage 폴백 모드:",
        err instanceof Error ? err.message : String(err),
      );
      // Keep any session already returned by Slack; null only means creation never succeeded.
    }

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
      // Only authenticated event metadata authorizes explicit Slack reads, never model/user text
      // or the threadTs-only Assistant view hint. Missing team fails closed for read tools.
      if (teamId) bindSlackReadContext(requestContext, { channel, userId, teamId, requestId }, actionToken);
      logSlackTokenBinding(requestContext, requestId, eventKind, actionToken, !!teamId);
      // Preserve Assistant current-view hints without flattening conversation roles.
      // This is a hint, never an actor identity or authorization source (the legacy map is threadTs-only).
      const modelMessages = currentChannel && /^[A-Z][A-Z0-9]{1,63}$/.test(currentChannel)
        ? [{ role: "system" as const, content: `[사용자가 현재 보고 있는 채널 ID (참고 정보): ${currentChannel}]` }, ...messages]
        : messages;
      // Candidate metadata is ephemeral user data, never trusted identity or a persisted file grant.
      const withAttachments = attachments?.files.length
        ? [...modelMessages, { role: "user" as const, content: JSON.stringify(attachments) }]
        : modelMessages;
      const streamResult = await agent.stream(withAttachments, {
        maxSteps: config.MAX_TOOL_ITERATIONS,
        requestContext,
        abortSignal: scope.control.signal,
      });

      const toolNamesSeen: string[] = [];

      const reader = streamResult.fullStream.getReader();
      try {
        while (true) {
          executionCheckpoint();
          const { done, value } = await reader.read();
          executionCheckpoint();
          if (done) break;

          if (value.type === "error") throw new Error("Agent stream failed");
          if (value.type === "tool-call") {
            const payload = (value as {
              payload: { toolName: string; id?: string; toolCallId?: string; args?: unknown };
            }).payload;
            const toolName = payload.toolName;
            // tool-call과 tool-result가 같은 taskId로 매핑되려면 안정적 ID 필수.
            // Date.now() fallback은 두 이벤트가 다른 ID를 만들어 plan 블록이 깨짐.
            const taskId = payload.id ?? payload.toolCallId;
            if (!toolNamesSeen.includes(toolName)) {
              toolNamesSeen.push(toolName);
            }

            if (streamSession && taskId) {
              const argsSummary = payload.args
                ? JSON.stringify(safeToolLog(toolName, payload.args)).slice(0, 200)
                : undefined;
              try {
                await appendTaskUpdate(streamSession, client, {
                  id: taskId,
                  title: TOOL_PROGRESS_MESSAGES[toolName] ?? toolName,
                  status: "in_progress",
                  details: argsSummary,
                });
              } catch (err) {
                logger.warn(
                  `[streaming] appendTaskUpdate(in_progress) 실패 (${toolName}):`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            } else if (streamSession && !taskId) {
              logger.warn(
                `[streaming] tool-call 이벤트에 id/toolCallId 없음 — task_update 스킵 (${toolName})`,
              );
            }
          } else if (value.type === "tool-result") {
            const payload = (value as {
              payload: {
                toolName: string;
                id?: string;
                toolCallId?: string;
                result?: unknown;
              };
            }).payload;
            const toolName = payload.toolName;
            const taskId = payload.id ?? payload.toolCallId;

            if (streamSession && taskId) {
              // output 필드로 긴 결과 본문 전송 (rich_text, ~3000자).
              // 도구 결과가 JSON/문자열 혼합이라 문자열로 정규화 후 슬라이스.
              const rawResult = payload.result;
              const resultStr = toolName === "slack_analyze_image"
                ? "이미지 분석 결과를 확인했습니다. 파생 해석의 출처·불확실성·한계는 최종 답변에 반영합니다."
                : toolName === "slack_read_attachment"
                ? "첨부 읽기 결과를 확인했습니다. 출처·지원 여부·잘림은 최종 답변에 반영합니다."
                : rawResult
                ? (typeof rawResult === "string"
                    ? rawResult
                    : JSON.stringify(rawResult)
                  ).slice(0, 2000)
                : undefined;

              try {
                await appendTaskUpdate(streamSession, client, {
                  id: taskId,
                  title: TOOL_PROGRESS_MESSAGES[toolName] ?? toolName,
                  status: "complete",
                  ...(resultStr ? { output: resultStr } : {}),
                });
              } catch (err) {
                logger.warn(
                  `[streaming] appendTaskUpdate(complete) 실패 (${toolName}):`,
                  err instanceof Error ? err.message : String(err),
                );
              }
            } else if (streamSession && !taskId) {
              logger.warn(
                `[streaming] tool-result 이벤트에 id/toolCallId 없음 — task_update 스킵 (${toolName})`,
              );
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      logger.info("🤖 응답 스트리밍 완료");

      const responseText = await streamResult.text;
      if (!responseText) throw new Error("Agent returned no answer");
      const usage = await streamResult.usage;
      const steps = await streamResult.steps;
      const finishReason = await streamResult.finishReason;
      if (finishReason === "error") throw new Error("Agent run failed");

      return { streamResult, responseText, usage, steps, finishReason, toolNamesSeen };
    };

    const alsCtx = callCtx && mainInvocationId
      ? { agentCallId: callCtx.agentCallId, parentInvocationId: mainInvocationId }
      : undefined;

    const conv = alsCtx
      ? await invocationStorage.run(alsCtx, runConversation)
      : await runConversation();

    const { responseText, usage, steps, finishReason, toolNamesSeen } = conv;
    executionCheckpoint();
    // Save the complete successful turn before ancillary logging or final Slack delivery.
    // Neither delivery nor logging failures may discard an already generated answer.
    await commit(responseText);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const debugFooter = [
      `🔧 사용 도구: ${toolNamesSeen.length > 0 ? [...new Set(toolNamesSeen)].join(", ") : "없음"}`,
      `💰 토큰: 입력 ${inputTokens.toLocaleString()} / 출력 ${outputTokens.toLocaleString()}`,
      `💵 비용: $${((inputTokens * 0.435 + outputTokens * 0.87) / 1_000_000).toFixed(4)}`,
    ].join("\n"); // Existing diagnostics only; no new cost policy.
    const { blocks, fallbackText } = convertMarkdownToBlocks(responseText, debugFooter, { withFeedback: true });
    // Deliver before ancillary DB logging, but delivery failure must not skip success logging.
    let delivered = false;
    try {
      await slackDelivery(app, async (deliveryClient, signal) => {
        if (streamSession) {
          try { await stopStreamWithBlocks(streamSession, deliveryClient, fallbackText, blocks); }
          catch {
            signal.throwIfAborted(); // No late fallback after delivery deadline.
            await deliveryClient.chat.postMessage({ channel, thread_ts: threadTs, text: fallbackText, blocks: blocks as KnownBlock[] });
          }
        } else await deliveryClient.chat.postMessage({ channel, thread_ts: threadTs, text: fallbackText, blocks: blocks as KnownBlock[] });
      });
      delivered = true;
    } catch {
      logger.warn("성공 대화 저장 이후 최종 응답 전송 실패", { requestId });
      // No misleading failure reply or state reversal; persist-success logging continues below.
    }

    if (delivered) {
      if (toolNamesSeen.some(isSlackReadTool)) logger.info("📤 Slack 조회 응답 전송", { textLen: responseText.length });
      else logger.info(`📤 응답 전송: "${responseText.slice(0, 150)}..."`);
    }
    // 진단용 INFO 한 줄 — 잘림 원인 파악 (LOG_LEVEL=info에서도 보임)
    // finishReason=length → LLM 토큰 한도, =steps → maxSteps 도달, =stop → 정상, =error → 예외
    const finishReasonLabel = typeof finishReason === "string" ? finishReason : String(finishReason ?? "?");
    logger.info(
      `[diagnostic] finishReason=${finishReasonLabel} steps=${steps.length} textLen=${responseText.length} inputTokens=${inputTokens} outputTokens=${outputTokens}`,
    );
    if (finishReasonLabel === "length" || finishReasonLabel === "steps") {
      logger.warn(
        `[diagnostic] 응답이 ${finishReasonLabel === "length" ? "LLM 토큰 한도(length)" : "maxSteps 도달(steps)"}로 잘렸을 수 있음`,
      );
    }

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
    logger.error("대화 실행 실패", { requestId, kind: error instanceof Error ? error.name : "unknown" });
    if (mainInvocationId) {
      await completeInvocation(mainInvocationId, {
        status: "error",
        error: "Conversation execution failed",
        finishReason: "error",
      });
    }
    if (streamSession) {
      try { await slackDelivery(app, deliveryClient => stopStreamWithBlocks(streamSession!, deliveryClient, "요청을 완료하지 못했습니다.", [])); } catch { /* outer handler posts friendly error */ }
    }
    throw error;
  }
}
