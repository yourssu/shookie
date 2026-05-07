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
    store.add(sessionId, { role: "assistant", content: responseText });

    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: responseText,
    });
  } catch (error) {
    logger.error("Error processing message:", error);
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
    });
  }
}
