import type { ConversationEvent, ConversationRepository } from "database";
import { InMemoryConversationStore, budgetMessages, type Message } from "../services/memory/in-memory.js";
import { conversationLimits as limits } from "../services/memory/limits.js";

export class ConversationBusyError extends Error {}
export class ConversationInputError extends Error {}

export class ConversationRuntime {
  private pending = new Map<string, Promise<void>>();
  private threads = new Map<string, { tail: Promise<void>; count: number }>();
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(
    private repository: ConversationRepository,
    private cache = new InMemoryConversationStore(),
  ) {}

  run(
    event: ConversationEvent,
    text: string,
    execute: (messages: Message[], commit: (answer: string) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const duplicate = this.pending.get(event.requestId);
    // The original delivery owns error reporting; retries must not emit duplicate errors.
    if (duplicate) return duplicate.catch(() => {});
    if (Buffer.byteLength(text, "utf8") > limits.inputBytes) {
      return Promise.reject(new ConversationInputError());
    }
    const previous = this.threads.get(event.sessionId);
    if (this.pending.size >= limits.admittedRuns || (previous?.count ?? 0) >= limits.perThreadRuns) {
      return Promise.reject(new ConversationBusyError());
    }
    const thread = previous ?? { tail: Promise.resolve(), count: 0 };
    thread.count++;
    const task = thread.tail.then(async () => {
      await this.acquire();
      let claimed = false;
      try {
        claimed = await this.repository.claim(event);
        if (!claimed) return;
        let history = this.cache.get(event.sessionId);
        if (!history) {
          const turns = await this.repository.recent(event.sessionId, limits.recentTurns);
          history = turns.flatMap(turn => [
            { role: "user" as const, content: turn.userContent },
            { role: "assistant" as const, content: turn.assistantContent },
          ]);
        }
        const messages = budgetMessages(history, text);
        let committed = false;
        await execute(messages, async answer => {
          if (committed) throw new Error("Conversation already committed");
          await this.repository.complete(event, { userContent: text, assistantContent: answer });
          committed = true;
          // Cache only the bounded context, not potentially huge model outputs.
          this.cache.set(event.sessionId, budgetMessages([...messages, { role: "assistant", content: answer }], "").slice(0, -1));
        });
        if (!committed) throw new Error("Conversation did not commit");
      } catch (error) {
        this.cache.clear(event.sessionId);
        if (claimed) {
          try { await this.repository.fail(event.requestId); } catch { /* original failure stays visible */ }
        }
        throw error;
      } finally {
        this.release();
      }
    });
    const result = task.finally(() => {
      this.pending.delete(event.requestId);
      thread.count--;
      if (thread.count === 0) this.threads.delete(event.sessionId);
    });
    thread.tail = result.catch(() => {});
    this.threads.set(event.sessionId, thread);
    this.pending.set(event.requestId, result);
    return result;
  }

  private async acquire(): Promise<void> {
    if (this.active < limits.activeRuns) { this.active++; return; }
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}
