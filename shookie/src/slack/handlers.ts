import type { App } from "@slack/bolt";
import type { Agent } from "@mastra/core/agent";
import { InMemoryConversationStore, type Message } from "../services/memory/in-memory.js";
import { buildSessionId, extractText } from "./thread-context.js";
import { convertMarkdownToBlocks } from "./markdown-to-blocks.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { logAgentCall } from "database";

const store = new InMemoryConversationStore();

const TOOL_PROGRESS_MESSAGES: Record<string, string> = {
  posthog_agent: "🔍 PostHog 데이터 분석 중...",
  github_agent: "🐙 GitHub 리포지토리 탐색 중...",
};

export function registerHandlers(app: App, agent: Agent): void {
  app.event("app_mention", async ({ event, client }) => {
    if ("bot_id" in event && event.bot_id) return;

    const text = extractText(event.text);
    if (!text) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
        text: "네, 무엇을 도와드릴까요?",
      });
      return;
    }

    await handleConversation(app, agent, text, event.channel, event.thread_ts ?? event.ts, event.user ?? "unknown");
  });

  app.event("message", async ({ event, client }) => {
    if ("bot_id" in event && event.bot_id) return;
    if ("channel_type" in event && event.channel_type !== "im") return;

    const text = extractText((event as { text?: string }).text);
    if (!text) return;

    const msgEvent = event as { channel: string; thread_ts?: string; ts: string; user?: string };
    await handleConversation(app, agent, text, msgEvent.channel, msgEvent.thread_ts ?? msgEvent.ts, msgEvent.user ?? "unknown");
  });
}

async function handleConversation(
  app: App,
  agent: Agent,
  userText: string,
  channel: string,
  threadTs: string,
  userId: string,
): Promise<void> {
  const sessionId = buildSessionId(channel, threadTs);

  try {
    logger.info(`📩 메시지 수신: "${userText.slice(0, 100)}"`);

    store.add(sessionId, { role: "user", content: userText });

    const history = store.buildMessages(sessionId);
    const prompt = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");

    logger.info("🤖 응답 스트리밍 시작...");
    const streamResult = await agent.stream([{ role: "user", content: prompt }], {
      maxSteps: config.MAX_TOOL_ITERATIONS,
    });

    const toolNamesSeen: string[] = [];
    const sentProgressMessages = new Set<string>();

    const reader = streamResult.fullStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value.type === "tool-call") {
          const toolName = (value as { payload: { toolName: string } }).payload.toolName;
          if (!toolNamesSeen.includes(toolName)) {
            toolNamesSeen.push(toolName);
          }

          const progressMsg = TOOL_PROGRESS_MESSAGES[toolName];
          if (progressMsg && !sentProgressMessages.has(toolName)) {
            sentProgressMessages.add(toolName);
            await app.client.chat.postMessage({
              channel,
              thread_ts: threadTs,
              text: progressMsg,
            });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    logger.info("🤖 응답 스트리밍 완료");

    const responseText = (await streamResult.text) || "응답을 생성하지 못했습니다.";

    const usage = await streamResult.usage;
    const steps = await streamResult.steps;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;

    logger.info(`📤 응답 전송: "${responseText.slice(0, 150)}..."`);
    logger.debug("result.usage:", JSON.stringify(usage));
    logger.debug("result.steps count:", steps.length);
    logger.debug("result.text length:", responseText.length);
    logger.debug("result.finishReason:", await streamResult.finishReason);

    for (const [i, step] of steps.entries()) {
      logger.debug(`--- step[${i}] ---`);
      logger.debug(`step[${i}] text length:`, step.text?.length ?? 0);

      for (const tc of step.toolCalls ?? []) {
        logger.debug(`step[${i}] toolCall: ${tc.payload.toolName}`, JSON.stringify(tc.payload.args));
      }
      for (const tr of step.toolResults ?? []) {
        const r = typeof tr.payload.result === "string" ? tr.payload.result : JSON.stringify(tr.payload.result);
        logger.debug(`step[${i}] toolResult:`, r.slice(0, 500));
      }
    }

    const debugFooter = [
      `🔧 사용 도구: ${toolNamesSeen.length > 0 ? [...new Set(toolNamesSeen)].join(", ") : "없음"}`,
      `💰 토큰: 입력 ${inputTokens.toLocaleString()} / 출력 ${outputTokens.toLocaleString()}`,
      `💵 비용: $${((inputTokens * 0.435 + outputTokens * 0.87) / 1_000_000).toFixed(4)}`,
    ].join("\n");

    const { blocks, fallbackText } = convertMarkdownToBlocks(responseText, debugFooter);

    store.add(sessionId, { role: "assistant", content: responseText });

    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: fallbackText,
      blocks,
    });

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
  } catch (error) {
    logger.error("Error processing message:", error);
    if (error instanceof Error) {
      logger.error("Error message:", error.message);
      logger.error("Error stack:", error.stack);
      if ("cause" in error) {
        logger.error("Error cause:", JSON.stringify(error.cause, null, 2));
      }
    }
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
    });
  }
}
