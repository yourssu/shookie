import { AsyncLocalStorage } from "node:async_hooks";
import type { createTool } from "@mastra/core/tools";
import { ConversationControl } from "./conversation-control.js";

/** Runtime ownership survives Mastra stream abort while nested tools are still settling. */
export class ExecutionScope {
  readonly control = new ConversationControl();
  private readonly pending = new Set<Promise<unknown>>();
  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    // Consume cleanup-chain rejection; the original work's rejection stays with its caller.
    void work.finally(() => this.pending.delete(work)).catch(() => {});
    return work;
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
export const executionStorage = new AsyncLocalStorage<ExecutionScope>();
const toolSignals = new AsyncLocalStorage<AbortSignal>();
export function executionCheckpoint(): void {
  executionStorage.getStore()?.control.checkpoint();
  toolSignals.getStore()?.throwIfAborted();
}
export function executionSignal(explicit?: AbortSignal): AbortSignal | undefined {
  const shared = executionStorage.getStore()?.control.signal;
  const tool = explicit ?? toolSignals.getStore();
  return shared && tool && shared !== tool ? AbortSignal.any([shared, tool]) : shared ?? tool;
}
export function trackExecution<T>(work: Promise<T>): Promise<T> {
  return executionStorage.getStore()?.track(work) ?? work;
}
export async function executionOperation<T>(work: () => Promise<T>, explicit?: AbortSignal): Promise<T> {
  executionCheckpoint();
  const signal = executionSignal(explicit);
  signal?.throwIfAborted();
  try {
    const result = await trackExecution(signal ? toolSignals.run(signal, work) : work());
    executionCheckpoint();
    signal?.throwIfAborted();
    return result;
  } catch (error) { executionCheckpoint(); signal?.throwIfAborted(); throw error; }
}

/** Wrap the public Tool.execute API once; preserve every tool/schema and RequestContext identity. */
export function executionTools<T extends Record<string, ReturnType<typeof createTool>>>(tools: T): T {
  for (const tool of Object.values(tools)) {
    const execute = tool.execute;
    if (execute) tool.execute = (input, context) => executionOperation(
      async () => execute.call(tool, input, context), context?.abortSignal,
    );
  }
  return tools;
}
