import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { ChildProcess } from "node:child_process";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { download, pinnedRequest } from "../tools/web/network.js";
import { downloadAttachment } from "../tools/attachments/download.js";
import { parseAttachment } from "../tools/attachments/parser.js";
import { ExecutionScope, executionStorage, executionTools, executionOperation } from "./execution-context.js";
const summaryConfig = vi.hoisted(() => ({ LLM_API_KEY: "synthetic-key", LLM_BASE_URL: "http://127.0.0.1", LLM_MODEL: "deepseek-flash" }));
vi.mock("../config.js", () => ({ config: summaryConfig }));
import { summarizeThread } from "../slack/thread-summarizer.js";
import { createMainShookieTools } from "../agent/agents/main-shookie/tools.js";
import { RequestContext } from "@mastra/core/request-context";

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const sockets = new Set<Socket>(); const http = createServer(handler);
  http.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { sockets.forEach(s => s.destroy()); http.close(e => e ? reject(e) : resolve()); }));
  const addr = http.address(); if (!addr || typeof addr === "string") throw new Error("Missing fixture port");
  return { port: addr.port, sockets };
}

describe("actual shared-signal calls (local transport/SDK, not Slack/LLM E2E)", () => {
  it("cancels public web pinned HTTP during body read and drains actual socket close", async () => {
    const entered = deferred(); const closed = deferred();
    const h = await server((req, res) => { req.socket.once("close", () => closed.resolve()); res.writeHead(200, { "content-type": "text/plain" }); res.write("partial"); entered.resolve(); });
    const scope = new ExecutionScope();
    const work = executionStorage.run(scope, () => executionOperation(() => download("http://public-source.org/read", {
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      // Test-only connector routing. Production URL/address/TLS checks remain unchanged.
      connector: (_url, _ip, signal, headers, search) => pinnedRequest(new URL(`http://127.0.0.1:${h.port}/read`), { address: "127.0.0.1", family: 4 }, signal, headers, search),
    })));
    const assertion = expect(work).rejects.toMatchObject({ reason: "cancelled" });
    await entered.promise; scope.control.cancel(); await assertion; await scope.drain(); await closed.promise;
    expect(h.sockets.size).toBe(0); scope.control.finish();
  });

  it("cancels Slack-only attachment download HTTP and waits for request close without expanding credentials", async () => {
    const entered = deferred(); const closed = deferred(); let auth: string | undefined;
    const h = await server((req, res) => { auth = req.headers.authorization; req.socket.once("close", () => closed.resolve()); res.writeHead(200, { "content-type": "text/plain" }); res.write("partial"); entered.resolve(); });
    const scope = new ExecutionScope();
    const work = executionStorage.run(scope, () => executionOperation(() => downloadAttachment("https://files.slack.com/files-pri/T1-F1/file", "synthetic-bot-token", {
      resolve: (async () => [{ address: "93.184.216.34", family: 4 }]) as any,
      request: ((_url: unknown, options: any, callback: any) => request({ hostname: "127.0.0.1", port: h.port, path: "/file", method: "GET", headers: options.headers, signal: options.signal, agent: false }, callback)) as any,
    })));
    const assertion = expect(work).rejects.toMatchObject({ reason: "cancelled" });
    await entered.promise; scope.control.cancel(); await assertion; await scope.drain(); await closed.promise;
    expect(auth).toBe("Bearer synthetic-bot-token"); expect(h.sockets.size).toBe(0); scope.control.finish();
  });

  it("kills a real parser child, rejects only after its close event, and recovers the parser slot", async () => {
    const kill = vi.spyOn(ChildProcess.prototype, "kill");
    const controller = new AbortController();
    const work = parseAttachment(Buffer.from("parser fixture"), "text", controller.signal);
    const assertion = expect(work).rejects.toMatchObject({ code: "PARSER_LIMIT" });
    controller.abort(); await assertion;
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    const child = kill.mock.contexts[0] as unknown as ChildProcess;
    expect(child.signalCode).toBe("SIGKILL"); // OS termination, not only kill intent
    expect(await parseAttachment(Buffer.from("recovered"), "text")).toMatchObject({ kind: "text", units: [{ text: "recovered" }] });
  });

  it("propagates summary cancellation through actual AI SDK/DeepSeek HTTP and closes the socket", async () => {
    const entered = deferred(); const closed = deferred(); let calls = 0;
    const h = await server((req, res) => {
      calls++; req.resume(); req.socket.once("close", () => closed.resolve());
      res.writeHead(200, { "content-type": "application/json" }); res.write('{"partial":'); entered.resolve();
    });
    summaryConfig.LLM_BASE_URL = `http://127.0.0.1:${h.port}/v1`;
    const scope = new ExecutionScope();
    const work = executionStorage.run(scope, () => executionOperation(() => summarizeThread([{ role: "user", content: "local summary" }], 8000)));
    const assertion = expect(work).rejects.toMatchObject({ reason: "cancelled" });
    await entered.promise; scope.control.cancel(); await assertion; await scope.drain(); await closed.promise;
    expect(calls).toBe(1); // The request socket closed; undici may retain a separate idle pool socket.
    scope.control.finish();
  });

  it("propagates main delegation into actual Mastra.generate's provider abortSignal and retains trusted RequestContext", async () => {
    const entered = deferred(); let providerSignal: AbortSignal | undefined;
    const model = { specificationVersion: "v2", provider: "local-test", modelId: "synthetic", supportedUrls: {},
      doGenerate: vi.fn((options: any) => {
        providerSignal = options.abortSignal; entered.resolve();
        return new Promise((_resolve, reject) => {
          providerSignal!.addEventListener("abort", () => reject(providerSignal!.reason), { once: true });
        });
      }),
    };
    const subagent = new Agent({ id: "posthog", name: "posthog", instructions: "test", model: model as any });
    const generate = vi.spyOn(subagent, "generate");
    const tools = createMainShookieTools({ posthog: subagent });
    const requestContext = new RequestContext<unknown>([["requestId", "trusted-event"]]);
    const scope = new ExecutionScope();
    const work = executionStorage.run(scope, () => tools.posthog_agent.execute!({ task: "local delegate" }, { requestContext }));
    const assertion = expect(work).rejects.toMatchObject({ reason: "cancelled" });
    await entered.promise; scope.control.cancel();
    expect(providerSignal!.aborted).toBe(true);
    await assertion; await scope.drain();
    expect((generate.mock.calls as unknown as [unknown, unknown][])[0][1]).toMatchObject({ requestContext, abortSignal: scope.control.signal });
    expect(model.doGenerate).toHaveBeenCalledOnce(); scope.control.finish();
  });

  it("uses real Mastra stream + public tool abortSignal with one shared scope and tracks early-aborted tools", async () => {
    const entered = deferred(); const settled = deferred(); let signal: AbortSignal | undefined;
    const model = {
      specificationVersion: "v2", provider: "local-test", modelId: "synthetic", supportedUrls: {},
      doStream: vi.fn(async (options: any) => ({ stream: new ReadableStream({ start(c) {
        expect(options.abortSignal).toBeDefined();
        c.enqueue({ type: "stream-start", warnings: [] });
        c.enqueue({ type: "tool-call", toolCallId: "slow-1", toolName: "slow", input: "{}" });
        c.enqueue({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }); c.close();
      } }) })),
    };
    const scope = new ExecutionScope();
    const tools = executionTools({ slow: createTool({ id: "slow", description: "local cancellation fixture", inputSchema: z.object({}),
      execute: async (_input, context) => {
        signal = context?.abortSignal; entered.resolve();
        await settled.promise; return { text: "late" };
      } }) });
    const agent = new Agent({ id: "local-cancel", name: "local-cancel", instructions: "test", model: model as any, tools });
    const run = executionStorage.run(scope, async () => {
      const result = await agent.stream("test", { abortSignal: scope.control.signal, maxSteps: 5 });
      const reader = result.fullStream.getReader();
      try { while (!(await reader.read()).done) { /* consume real Mastra stream */ } } finally { reader.releaseLock(); }
    });
    const consume = run.catch(() => {});
    await entered.promise;
    scope.control.cancel(); expect(signal?.aborted).toBe(true);
    let drained = false; const drain = scope.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    settled.resolve(); await drain; await consume;
    expect(model.doStream).toHaveBeenCalledOnce(); scope.control.finish();
  });
});
