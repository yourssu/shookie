import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import { bindSlackReadContext } from "./context.js";
import { logSlackReadDiagnostic } from "./read-diagnostics.js";

afterEach(() => vi.restoreAllMocks());
describe("read failure primitive runtime allowlist", () => {
  it("rejects forged kind/reason without coercion/getters/proxy traps/toJSON; uses trusted WeakMap only", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const secret = "PRIVATE_BODY_TOKEN_METADATA";
    const execute = vi.fn(() => { throw new Error(secret); });
    const proxy = new Proxy({}, { get: execute, ownKeys: execute, getOwnPropertyDescriptor: execute, getPrototypeOf: execute });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const object = Object.defineProperty({ toJSON: execute, toString: execute }, "kind", { get: execute });
    for (const value of [secret, object, proxy, revoked.proxy, undefined, 1]) {
      logSlackReadDiagnostic(proxy, value as never, "message_ts_invalid");
      logSlackReadDiagnostic(proxy, "thread", value as never);
    }
    expect(spy).not.toHaveBeenCalled();
    const context = { requestId: secret, toJSON: execute, get: execute };
    logSlackReadDiagnostic(context, "thread", "message_ts_invalid");
    expect(spy.mock.calls.at(-1)?.[1]).toEqual({ kind: "thread", stage: "message", reason: "message_ts_invalid", correlationAvailable: false });
    bindSlackReadContext(context, { requestId: "trusted-event", userId: "USECRET", teamId: "TSECRET", channel: "CSECRET" }, secret);
    logSlackReadDiagnostic(context, "channel", "api_call_failed");
    expect(spy.mock.calls.at(-1)?.[1]).toEqual({ kind: "channel", stage: "transport", reason: "api_call_failed", correlationAvailable: true, requestId: "trusted-event" });
    for (const value of [secret, "USECRET", "TSECRET", "CSECRET"]) expect(JSON.stringify(spy.mock.calls)).not.toContain(value);
    expect(execute).not.toHaveBeenCalled();
    spy.mockImplementation(() => { throw new Error(secret); });
    expect(() => logSlackReadDiagnostic(context, "thread", "fingerprint_conflict")).not.toThrow();
  });
});
