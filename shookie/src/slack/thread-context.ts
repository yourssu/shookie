export function buildSessionId(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

export function extractText(text?: string): string {
  if (!text) return "";
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}
