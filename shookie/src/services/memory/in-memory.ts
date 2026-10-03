import { conversationLimits as limits } from "./limits.js";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

/** Bounded read-through cache; never the authoritative dialogue store. */
export class InMemoryConversationStore {
  private conversations = new Map<string, { messages: Message[]; expires: number }>();
  constructor(
    private maxMessages = limits.recentTurns * 2,
    private maxSessions: number = limits.cacheSessions,
    private ttlMs: number = limits.cacheTtlMs,
    private now: () => number = Date.now,
  ) {}
  get(sessionId: string): Message[] | undefined {
    this.prune();
    const entry = this.conversations.get(sessionId);
    if (!entry) return undefined;
    this.conversations.delete(sessionId);
    this.conversations.set(sessionId, entry);
    return entry.messages.map(message => ({ ...message }));
  }
  set(sessionId: string, messages: Message[]): void {
    this.prune();
    this.conversations.delete(sessionId);
    this.conversations.set(sessionId, {
      messages: messages.slice(-this.maxMessages).map(message => ({ ...message })),
      expires: this.now() + this.ttlMs,
    });
    while (this.conversations.size > this.maxSessions) {
      this.conversations.delete(this.conversations.keys().next().value!);
    }
  }
  clear(sessionId: string): void { this.conversations.delete(sessionId); }
  private prune(): void {
    for (const [key, entry] of this.conversations) {
      if (entry.expires <= this.now()) this.conversations.delete(key);
    }
  }
}

export function budgetMessages(history: Message[], current: string): Message[] {
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  if (bytes(current) > limits.inputBytes) throw new Error("Conversation input too large");
  let remaining = limits.contextBytes - bytes(current);
  const selected: Message[] = [];
  // Keep complete turns only. Never slice Unicode or manufacture partial assistant turns.
  for (let i = history.length - 2; i >= 0; i -= 2) {
    const pair = history.slice(i, i + 2);
    const size = pair.reduce((sum, message) => sum + bytes(message.content), 0);
    if (size > remaining) break;
    remaining -= size;
    selected.unshift(...pair);
  }
  return [...selected, { role: "user", content: current }];
}
