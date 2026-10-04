import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, Agent } from "node:http";
import type { Socket } from "node:net";
import { WebClient, LogLevel, type WebClientOptions } from "@slack/web-api";
import { createCancellationSlackClient, SLACK_TRANSPORT_TIMEOUT_MS } from "./slack-transport.js";

type RequestConfig = Parameters<NonNullable<WebClientOptions["requestInterceptor"]>>[0];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { resolve, promise };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local fixture address");
  const options = { slackApiUrl: `http://127.0.0.1:${address.port}/api/`, logLevel: LogLevel.ERROR };
  return { options, sockets };
}
function source(options: WebClientOptions) {
  return { client: new WebClient("test-only-slack-token", { ...options, retryConfig: { retries: 0 } }), webClientOptions: options };
}

describe("dedicated Slack transport (real localhost HTTP, no Slack E2E)", () => {
  it("aborts the actual underlying socket on shared cancellation, without SDK retry", async () => {
    const received = deferred();
    const closed = deferred();
    let requests = 0;
    const h = await fixture(req => {
      requests++;
      req.socket.once("close", () => closed.resolve());
      req.resume(); received.resolve(); // deliberately never send a response
    });
    const controller = new AbortController();
    const original = source(h.options);
    const client = createCancellationSlackClient(original, controller.signal);
    const request = client.conversations.replies({ channel: "C1", ts: "1.1" });
    const assertion = expect(request).rejects.toBeDefined();
    await received.promise;
    expect(h.sockets.size).toBe(1);
    controller.abort();
    await assertion;
    await closed.promise;
    expect(requests).toBe(1);
    expect(h.sockets.size).toBe(0);
    expect(original.client).not.toBe(client);
  });

  it("pre-aborted calls never open a socket and signal is never serialized as Slack body data", async () => {
    let calls = 0;
    const h = await fixture(() => { calls++; });
    const controller = new AbortController(); controller.abort();
    const client = createCancellationSlackClient(source(h.options), controller.signal);
    await expect(client.conversations.replies({ channel: "C1", ts: "1.1" })).rejects.toBeDefined();
    expect(calls).toBe(0);
    expect(h.sockets.size).toBe(0);
  });

  it("preserves authentication/headers and shared client usability across isolated signals", async () => {
    const bodies: string[] = [];
    const auth: (string | undefined)[] = [];
    const marker: (string | string[] | undefined)[] = [];
    const h = await fixture((req, res) => {
      auth.push(req.headers.authorization); marker.push(req.headers["x-test-marker"]);
      let body = ""; req.on("data", data => { body += data; });
      req.on("end", () => { bodies.push(body); res.setHeader("content-type", "application/json"); res.end('{"ok":true,"messages":[]}'); });
    });
    const inherited = { ...h.options, headers: { "X-Test-Marker": "preserved" } };
    const original = source(inherited);
    const headersBefore = { ...inherited.headers };
    const first = new AbortController(); first.abort();
    const second = new AbortController();
    await expect(createCancellationSlackClient(original, first.signal).conversations.replies({ channel: "C1", ts: "1.1" })).rejects.toBeDefined();
    await createCancellationSlackClient(original, second.signal).conversations.replies({ channel: "C1", ts: "1.1" });
    await original.client.conversations.replies({ channel: "C1", ts: "1.1" });
    expect(auth).toEqual(["Bearer test-only-slack-token", "Bearer test-only-slack-token"]);
    expect(marker).toEqual(["preserved", "preserved"]);
    expect(bodies.every(body => !body.includes("signal"))).toBe(true);
    expect(inherited.headers).toEqual(headersBefore);
    expect(second.signal.aborted).toBe(false);
  });

  it("rejects 429 immediately instead of sleeping/retrying even with inherited unlimited settings", async () => {
    let calls = 0;
    const h = await fixture((_req, res) => { calls++; res.writeHead(429, { "retry-after": "3600" }); res.end(); });
    const original = source({ ...h.options, retryConfig: { retries: 10 }, timeout: 0, rejectRateLimitedCalls: false });
    const client = createCancellationSlackClient(original, new AbortController().signal);
    await expect(client.conversations.replies({ channel: "C1", ts: "1.1" })).rejects.toMatchObject({ code: "slack_webapi_rate_limited_error" });
    expect(calls).toBe(1);
  });

  it("has a real finite HTTP timeout and closes a nonresponding socket", async () => {
    const received = deferred(); const closed = deferred();
    let calls = 0;
    const h = await fixture(req => {
      calls++; req.resume(); req.socket.once("close", () => closed.resolve()); received.resolve();
    });
    const client = createCancellationSlackClient(source({ ...h.options, timeout: 0 }), new AbortController().signal);
    const request = client.conversations.replies({ channel: "C1", ts: "1.1" });
    const assertion = expect(request).rejects.toBeDefined();
    await received.promise;
    await assertion;
    await closed.promise;
    expect(calls).toBe(1);
    expect(h.sockets.size).toBe(0);
  }, SLACK_TRANSPORT_TIMEOUT_MS + 5_000);

  it("preserves public TLS/agent/endpoint and upstream interceptor configuration without allowing unbounded timeout", async () => {
    const requests: RequestConfig[] = [];
    const h = await fixture((_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); });
    const agent = new Agent({ keepAlive: false });
    cleanups.push(async () => { agent.destroy(); });
    const options = {
      ...h.options, agent, tls: { ca: "test-ca", cert: "test-cert", key: "test-key" },
      requestInterceptor: async (request: RequestConfig) => {
        requests.push(request); request.timeout = 0; request.headers.set("X-Upstream", "retained"); return request;
      },
    };
    const client = createCancellationSlackClient(source(options), new AbortController().signal);
    await client.apiCall("auth.test");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      baseURL: h.options.slackApiUrl, httpAgent: agent, httpsAgent: agent,
      ca: "test-ca", cert: "test-cert", key: "test-key", timeout: SLACK_TRANSPORT_TIMEOUT_MS, proxy: false, maxRedirects: 0,
    });
    expect(requests[0].headers.get("X-Upstream")).toBe("retained");
    expect(client.slackApiUrl).toBe(h.options.slackApiUrl);
  });

  it("keeps an inherited interceptor's signal effective too", async () => {
    const received = deferred(); const closed = deferred();
    const h = await fixture(req => { req.resume(); req.socket.once("close", () => closed.resolve()); received.resolve(); });
    const ancestor = new AbortController(); const shared = new AbortController();
    const original = source({ ...h.options, requestInterceptor: config => { config.signal = ancestor.signal; return config; } });
    const client = createCancellationSlackClient(original, shared.signal);
    const request = client.conversations.replies({ channel: "C1", ts: "1.1" });
    const assertion = expect(request).rejects.toBeDefined();
    await received.promise;
    ancestor.abort();
    await assertion; await closed.promise;
    expect(shared.signal.aborted).toBe(false);
  });

  it("does not allow dynamic absolute URLs to bypass the inherited Slack endpoint", async () => {
    const paths: (string | undefined)[] = [];
    const h = await fixture((req, res) => {
      paths.push(req.url); res.setHeader("content-type", "application/json"); res.end('{"ok":true}');
    });
    const client = createCancellationSlackClient(source(h.options), new AbortController().signal);
    await client.apiCall("https://outside.invalid/auth.test");
    expect(paths).toEqual(["/api/https://outside.invalid/auth.test"]);
  });

  it("rejects unknown custom adapters that could ignore transport cancellation", () => {
    const adapter = vi.fn();
    expect(() => createCancellationSlackClient(source({ adapter }), new AbortController().signal)).toThrow("standard Slack transport adapter");
    expect(adapter).not.toHaveBeenCalled();
  });
});
