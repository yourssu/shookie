/** Mastra .text concatenates public prose from every step, including pre-tool text.
 * Only a normally stopped, last tool-free step is a completed answer.
 */
export class IncompleteAnswerError extends Error {
  constructor(readonly limited: boolean) { super("Agent returned no completed answer"); }
}
export function canonicalAnswer(steps: readonly { text?: string; toolCalls?: readonly unknown[] }[], finishReason: unknown): string {
  if (finishReason !== "stop") throw new IncompleteAnswerError(finishReason === "length" || finishReason === "steps");
  const last = steps.at(-1);
  if (!last || last.toolCalls?.length || !last.text?.trim()) throw new IncompleteAnswerError(false);
  return last.text;
}
