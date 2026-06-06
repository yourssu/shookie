export interface Message {
  role: "user" | "assistant";
  content: string;
}

export class InMemoryConversationStore {
  private conversations = new Map<string, Message[]>();
  private maxMessages: number;

  constructor(maxMessages = 30) {
    this.maxMessages = maxMessages;
  }

  get(sessionId: string): Message[] {
    return this.conversations.get(sessionId) ?? [];
  }

  add(sessionId: string, message: Message): void {
    const history = this.conversations.get(sessionId) ?? [];
    history.push(message);
    if (history.length > this.maxMessages) {
      history.splice(0, history.length - this.maxMessages);
    }
    this.conversations.set(sessionId, history);
  }

  clear(sessionId: string): void {
    this.conversations.delete(sessionId);
  }

  buildMessages(sessionId: string): Message[] {
    return this.get(sessionId);
  }
}
