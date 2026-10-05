import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { setLogLevel } from "../../logger.js";
import { bindSlackReadContext, getSlackSearchActionToken } from "./context.js";
import { isUsableSlackActionToken } from "./action-token-validation.js";
import { logSlackTokenReceive, logSlackTokenSelection, logSlackTokenBinding, logSlackTokenSearch } from "./action-token-diagnostics.js";

const secret = "DIAGNOSTIC_SECRET_not_a_standard_slack_token";
const identity = { userId: "U1", teamId: "T1", channel: "C1", requestId: "slack-event:synthetic" };
afterEach(() => { vi.restoreAllMocks(); setLogLevel("info"); });

function capture() {
  setLogLevel("info");
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  const records = () => spy.mock.calls.map(call => call[1] as Record<string, unknown>);
  return { spy, records };
}

describe("temporary action-token safe diagnostics", () => {
  it.each([
    [undefined, false], [null, false], [42, false], [{}, false], ["", false], ["white space", false],
    ["tab\t", false], ["\u0000", false], ["a".repeat(16_385), false], [secret, true], ["a".repeat(16_384), true],
    ["\u007f", true], ["\u00a0", true],
  ] as const)(
    "uses exactly the existing binding validation without logging values", (value, expected) => {
      const { spy, records } = capture();
      const context = new RequestContext();
      bindSlackReadContext(context, identity, value);
      logSlackTokenReceive(identity.requestId, "message", { action_token: value }, {}, {});
      logSlackTokenSelection(identity.requestId, "message", value);
      logSlackTokenBinding(context, identity.requestId, "message", value, true);
      logSlackTokenSearch(context);
      const accepted = !!getSlackSearchActionToken(context);
      expect(accepted).toBe(expected);
      expect(isUsableSlackActionToken(value)).toBe(expected);
      expect(records().map(r => r.stage)).toEqual(["receive", "selection", "binding", "search"]);
      expect(records()[0]).toMatchObject({ eventTokenPresent: true, eventTokenUsable: accepted });
      expect(records()[1]).toMatchObject({ selectedUsable: accepted, selectedSource: "event.action_token" });
      expect(records()[2]).toMatchObject({ identityBound: true, tokenBound: accepted });
      expect(records()[3]).toMatchObject({ identityBound: true, tokenBound: accepted, correlationAvailable: true });
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
      expect(context.get("action_token")).toBeUndefined();
      expect(context.get("stage")).toBeUndefined();
    },
  );

  it("observes only four fixed paths, separately, without supplying a fallback", () => {
    const { spy, records } = capture();
    logSlackTokenReceive(identity.requestId, "app_mention", {}, { action_token: secret, event: { action_token: secret } }, { action_token: secret });
    expect(records()[0]).toEqual({ stage: "receive", eventKind: "app_mention", requestId: identity.requestId,
      eventTokenObservation: "absent", eventTokenPresent: false, eventTokenUsable: false,
      bodyEventTokenObservation: "data", bodyEventTokenPresent: true, bodyEventTokenUsable: true,
      bodyTokenObservation: "data", bodyTokenPresent: true, bodyTokenUsable: true,
      contextTokenObservation: "data", contextTokenPresent: true, contextTokenUsable: true });
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  });

  it("never executes getters, proxy traps, arbitrary key enumeration or object serialization", () => {
    const { spy, records } = capture();
    const execute = vi.fn(() => { throw new Error(secret); });
    const event = Object.defineProperties({ text: secret, files: [{ content: secret }], action_token: { toJSON: execute } }, {
      unrelated: { enumerable: true, get: execute },
    });
    const body = Object.defineProperties({}, {
      event: { enumerable: true, get: execute }, action_token: { enumerable: true, get: execute }, toJSON: { get: execute },
    });
    const proxy = new Proxy({}, { get: execute, getOwnPropertyDescriptor: execute, ownKeys: execute, getPrototypeOf: execute });
    logSlackTokenReceive(identity.requestId, "message", event, body, proxy);
    logSlackTokenSelection(identity.requestId, "message", { toJSON: execute });
    logSlackTokenReceive(identity.requestId, "message", Object.create({ action_token: secret }), { event: proxy }, {});
    const revocable = Proxy.revocable({}, {}); revocable.revoke();
    logSlackTokenReceive(identity.requestId, "message", revocable.proxy, null, undefined);
    logSlackTokenBinding(proxy, identity.requestId, "message", { toJSON: execute }, true);
    logSlackTokenSearch(proxy);
    logSlackTokenReceive(identity.requestId, "message", Object.defineProperty({}, "action_token", { get: execute }), {}, {});
    expect(records().at(-1)).toMatchObject({ eventTokenObservation: "accessor", eventTokenPresent: true, eventTokenUsable: false });
    expect(execute).not.toHaveBeenCalled();
    expect(records()[0]).toMatchObject({ eventTokenUsable: false, bodyEventTokenObservation: "blocked",
      bodyTokenObservation: "accessor", bodyTokenPresent: true, bodyTokenUsable: false, contextTokenObservation: "blocked" });
    expect(records()[2]).toMatchObject({ eventTokenObservation: "absent", bodyEventTokenObservation: "blocked" });
    expect(records()[3]).toMatchObject({ eventTokenObservation: "blocked" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
    const allowed = new Set(["stage", "eventKind", "requestId", "selectedSource", "selectedUsable",
      "eventTokenObservation", "eventTokenPresent", "eventTokenUsable", "bodyEventTokenObservation", "bodyEventTokenPresent", "bodyEventTokenUsable",
      "bodyTokenObservation", "bodyTokenPresent", "bodyTokenUsable", "contextTokenObservation", "contextTokenPresent", "contextTokenUsable",
      "bindingAttempted", "identityBound", "tokenBound", "correlationAvailable"]);
    const enums = new Set(["receive", "selection", "binding", "search", "message", "event.action_token", "absent", "data", "accessor", "blocked"]);
    for (const record of records()) for (const [key, value] of Object.entries(record)) {
      expect(allowed.has(key)).toBe(true);
      expect(key === "requestId" ? value === identity.requestId : typeof value === "boolean" || enums.has(value as string)).toBe(true);
    }
  });

  it("distinguishes missing team binding and lost propagation without trusting context.get", () => {
    const { records } = capture();
    const context = new RequestContext();
    context.set("action_token", secret); context.set("requestId", "FORGED");
    logSlackTokenBinding(context, identity.requestId, "app_mention", secret, false);
    logSlackTokenSearch(context);
    logSlackTokenSearch(new RequestContext());
    expect(records()[0]).toMatchObject({ bindingAttempted: false, selectedUsable: true, identityBound: false, tokenBound: false });
    expect(records()[1]).toMatchObject({ requestId: identity.requestId, eventKind: "app_mention", identityBound: false, tokenBound: false });
    expect(records()[2]).toEqual({ stage: "search", eventKind: "unknown", correlationAvailable: false, identityBound: false, tokenBound: false });
  });
});
