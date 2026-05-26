import type { App } from "@slack/bolt";
import type { Agent } from "@mastra/core/agent";
import { InMemoryConversationStore, type Message } from "../services/memory/in-memory.js";
import { buildSessionId, extractText } from "./thread-context.js";
import { convertMarkdownToBlocks } from "./markdown-to-blocks.js";
import { logger } from "../logger.js";

const store = new InMemoryConversationStore();

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

    await handleConversation(app, agent, text, event.channel, event.thread_ts ?? event.ts);
  });

  app.event("message", async ({ event, client }) => {
    if ("bot_id" in event && event.bot_id) return;
    if ("channel_type" in event && event.channel_type !== "im") return;

    const text = extractText((event as { text?: string }).text);
    if (!text) return;

    const msgEvent = event as { channel: string; thread_ts?: string; ts: string };
    await handleConversation(app, agent, text, msgEvent.channel, msgEvent.thread_ts ?? msgEvent.ts);
  });
}

async function handleConversation(
  app: App,
  agent: Agent,
  userText: string,
  channel: string,
  threadTs: string,
): Promise<void> {
  const sessionId = buildSessionId(channel, threadTs);

  try {
    logger.info(`📩 메시지 수신: "${userText.slice(0, 100)}"`);

    store.add(sessionId, { role: "user", content: userText });

    const history = store.buildMessages(sessionId);
    const prompt = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");

    logger.info("🤖 응답 생성 시작...");
    const result = await agent.generate([{ role: "user", content: prompt }], {
      maxSteps: 8,
    });
    logger.info("🤖 응답 생성 완료");

    const responseText = result.text || "응답을 생성하지 못했습니다.";

    const usage = await result.usage;
    const steps = result.steps ?? [];
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;

    logger.info(`📤 응답 전송: "${responseText.slice(0, 150)}..."`);
    logger.debug("result.usage:", JSON.stringify(usage));
    logger.debug("result.steps count:", steps.length);
    logger.debug("result.text length:", result.text?.length ?? 0);
    logger.debug("result.finishReason:", result.finishReason);

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

    const toolNames = steps
      .flatMap((step) => (step.toolCalls ?? []).map((tc) => tc.payload.toolName));
    const cost = (inputTokens * 0.435 + outputTokens * 0.87) / 1_000_000;

    const debugFooter = [
      `🔧 사용 도구: ${toolNames.length > 0 ? [...new Set(toolNames)].join(", ") : "없음"}`,
      `💰 토큰: 입력 ${inputTokens.toLocaleString()} / 출력 ${outputTokens.toLocaleString()}`,
      `💵 비용: $${cost.toFixed(4)}`,
    ].join("\n");

    const { blocks, fallbackText } = convertMarkdownToBlocks(responseText, debugFooter);

    store.add(sessionId, { role: "assistant", content: responseText });

    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: fallbackText,
      blocks,
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
