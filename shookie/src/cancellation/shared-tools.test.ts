import { expect, it } from "vitest";
import { createTool, noopObserve } from "@mastra/core/tools";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { ExecutionScope, executionSignal, executionStorage, executionTools } from "./execution-context.js";
it("wraps shared tools once and isolates concurrent identity/cancellation per request", async () => {
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const tool = createTool({ id: "shared-identity", description: "synthetic", inputSchema: z.object({ wait: z.boolean() }),
    execute: async ({ wait }, context) => {
      const identity = context?.requestContext;
      if (wait) { enter(); await new Promise<void>(resolve => executionSignal()!.addEventListener("abort", () => resolve(), { once: true })); }
      return identity;
    } });
  executionTools({ tool }); const wrapped = tool.execute;
  executionTools({ tool }); expect(tool.execute).toBe(wrapped);
  const first = new RequestContext(), second = new RequestContext();
  first.set("userId", "U1"); second.set("userId", "U2");
  const scope = new ExecutionScope();
  const pending = executionStorage.run(scope, () => tool.execute!({ wait: true }, { requestContext: first, observe: noopObserve }));
  const rejected = expect(pending).rejects.toMatchObject({ reason: "cancelled" });
  await entered;
  expect(await tool.execute!({ wait: false }, { requestContext: second, observe: noopObserve })).toBe(second);
  scope.control.cancel(); await rejected; await scope.drain();
  expect(await tool.execute!({ wait: false }, { requestContext: second, observe: noopObserve })).toBe(second);
});
