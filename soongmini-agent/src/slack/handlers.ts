import type { App } from "@slack/bolt";
import type { Agent } from "@mastra/core/agent";
import { InMemoryConversationStore, type Message } from "../services/memory/in-memory.js";
import { buildSessionId, extractText } from "./thread-context.js";
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
    store.add(sessionId, { role: "user", content: userText });

    const history = store.buildMessages(sessionId);
    const prompt = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");

    const result = await agent.generateLegacy(prompt, {
      maxSteps: 8,
    });

    const responseText = result.text || "응답을 생성하지 못했습니다.";

    logger.debug("generateLegacy result keys:", Object.keys(result));
    logger.debug("result.usage:", JSON.stringify(result.usage));
    logger.debug("result.steps count:", result.steps?.length);
    if (result.steps?.length) {
      logger.debug("result.steps[0] keys:", Object.keys(result.steps[0]));
    }

    const toolNames = (result.steps ?? [])
      .flatMap((step) => (step.toolCalls ?? []).map((tc) => tc.toolName));

    const usage = result.usage ?? { promptTokens: 0, completionTokens: 0 };
    const cost = (usage.promptTokens * 0.15 + usage.completionTokens * 0.6) / 1_000_000;

    const debugFooter = [
      "\n---",
      `🔧 사용 도구: ${toolNames.length > 0 ? [...new Set(toolNames)].join(", ") : "없음"}`,
      `💰 토큰: 입력 ${usage.promptTokens.toLocaleString()} / 출력 ${usage.completionTokens.toLocaleString()}`,
      `💵 비용: $${cost.toFixed(4)}`,
    ].join("\n");

    const finalText = responseText + debugFooter;

    store.add(sessionId, { role: "assistant", content: responseText });

    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: finalText,
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
