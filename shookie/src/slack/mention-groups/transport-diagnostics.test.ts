import { createServer } from "node:http";
import { channel } from "node:diagnostics_channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startRadarTransportDiagnostics,
  type RadarTransportEvent,
} from "./transport-diagnostics.js";

const requestCreate = channel("undici:request:create");
const requestBodySent = channel("undici:request:bodySent");
const requestHeaders = channel("undici:request:headers");
const requestError = channel("undici:request:error");
const clientSendHeaders = channel("undici:client:sendHeaders");

const privateUrl = "https://private.example/192.0.2.1/private-path";
const privateHeader = "private-api-key";
const privateBody = "private-response-body";

afterEach(() => {
  vi.restoreAllMocks();
});

function request(headers: unknown): object {
  return { headers };
}

function stages(events: RadarTransportEvent[]): string[] {
  return events.map((event) => event.stage);
}

describe("Radar transport diagnostics", () => {
  it("correlates the Node fetch request channels without exposing the request target", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server did not start");
      }
      const url = `http://127.0.0.1:${address.port}/private-path`;
      const events: RadarTransportEvent[] = [];
      const diagnostics = startRadarTransportDiagnostics(
        "radar-request-id",
        (event) => events.push(event),
      );
      const response = await fetch(url, {
        headers: {
          "X-Request-Id": "radar-request-id",
          "X-Radar-Internal-Key": privateHeader,
        },
      });
      await response.text();
      diagnostics.stop();

      const observedStages = stages(events);
      expect(observedStages).toEqual(
        expect.arrayContaining([
          "dispatch",
          "request_created",
          "request_sent",
          "response_headers",
        ]),
      );
      expect(observedStages.indexOf("request_created")).toBeLessThan(
        observedStages.indexOf("response_headers"),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: "response_headers",
            httpStatus: 200,
          }),
        ]),
      );
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(url);
      expect(serialized).not.toContain(privateHeader);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("emits request lifecycle events in order with correlated timing and status", () => {
    let time = 100;
    const events: RadarTransportEvent[] = [];
    const diagnostics = startRadarTransportDiagnostics(
      "radar-request-id",
      (event) => events.push(event),
      () => time,
    );
    const undiciRequest = request([
      "X-Request-Id",
      "radar-request-id",
      "X-Radar-Internal-Key",
      privateHeader,
    ]);

    time = 105;
    requestCreate.publish({ request: undiciRequest });
    time = 125;
    clientSendHeaders.publish({ request: undiciRequest, headers: privateBody });
    requestBodySent.publish({ request: undiciRequest });
    time = 240;
    requestHeaders.publish({
      request: undiciRequest,
      response: { statusCode: 200 },
    });
    diagnostics.stop();

    expect(stages(events)).toEqual([
      "dispatch",
      "request_created",
      "request_sent",
      "response_headers",
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        requestId: "radar-request-id",
        stage: "dispatch",
        elapsedMs: 0,
      }),
      expect.objectContaining({
        requestId: "radar-request-id",
        stage: "request_created",
        elapsedMs: 5,
      }),
      expect.objectContaining({
        requestId: "radar-request-id",
        stage: "request_sent",
        elapsedMs: 25,
      }),
      expect.objectContaining({
        requestId: "radar-request-id",
        stage: "response_headers",
        elapsedMs: 140,
        httpStatus: 200,
      }),
    ]);
  });

  it("filters unrelated requests and never forwards transport request data", () => {
    let time = 0;
    const events: RadarTransportEvent[] = [];
    const diagnostics = startRadarTransportDiagnostics(
      "radar-request-id",
      (event) => events.push(event),
      () => time,
    );
    const unrelatedRequest = request([
      "X-Request-Id",
      "other-request-id",
      "X-Radar-Internal-Key",
      privateHeader,
    ]);
    const correlatedRequest = request([
      "x-request-id",
      "radar-request-id",
      "x-private-url",
      privateUrl,
    ]);

    requestCreate.publish({ request: unrelatedRequest });
    clientSendHeaders.publish({
      request: unrelatedRequest,
      headers: privateBody,
    });
    requestCreate.publish({ request: correlatedRequest });
    time = 20;
    clientSendHeaders.publish({
      request: correlatedRequest,
      headers: privateHeader,
    });
    diagnostics.stop();

    expect(stages(events)).toEqual([
      "dispatch",
      "request_created",
      "request_sent",
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(privateUrl);
    expect(serialized).not.toContain(privateHeader);
    expect(serialized).not.toContain(privateBody);

    requestHeaders.publish({
      request: correlatedRequest,
      response: { statusCode: 503 },
    });
    expect(stages(events)).toEqual(["dispatch", "request_created", "request_sent"]);
  });

  it("records only a sanitized error class and code, once per Radar request", () => {
    const events: RadarTransportEvent[] = [];
    const diagnostics = startRadarTransportDiagnostics(
      "radar-request-id",
      (event) => events.push(event),
      () => 50,
    );
    const error = Object.assign(new Error(privateBody), {
      code: "ECONNREFUSED",
      secret: privateHeader,
    });
    const undiciRequest = request(["x-request-id", "radar-request-id"]);

    requestCreate.publish({ request: undiciRequest });
    requestError.publish({ request: undiciRequest, error });
    diagnostics.recordError(error);
    diagnostics.recordError(
      Object.assign(new Error(privateUrl), { code: "private-code" }),
    );
    diagnostics.stop();

    expect(events).toEqual([
      expect.objectContaining({ stage: "dispatch", elapsedMs: 0 }),
      expect.objectContaining({ stage: "request_created", elapsedMs: 0 }),
      expect.objectContaining({
        stage: "request_error",
        elapsedMs: 0,
        errorClass: "Error",
        errorCode: "ECONNREFUSED",
      }),
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(privateUrl);
    expect(serialized).not.toContain(privateHeader);
    expect(serialized).not.toContain(privateBody);
    expect(serialized).not.toContain("private-code");
  });
});
