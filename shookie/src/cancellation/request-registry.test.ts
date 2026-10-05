import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationControl } from "./conversation-control.js";
import { CancellationRegistry, type TrustedCancellationAction } from "./request-registry.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const owner = { requestId: "request-1", teamId: "T1", channel: "C1", threadTs: "1.1", userId: "U1" };
const action: TrustedCancellationAction = { ...owner, messageTs: "2.2" };
function setup() {
  const registry = new CancellationRegistry();
  const control = new ConversationControl();
  registry.register(owner, control);
  registry.bindMessage(owner.requestId, control, action.messageTs);
  return { registry, control };
}

describe("requester-only server registry", () => {
  it("accepts the matching verified requester once", () => {
    const { registry, control } = setup();
    expect(registry.cancel(action)).toBe("accepted");
    expect(control.stopReason).toBe("cancelled");
    expect(registry.cancel(action)).toBe("unavailable");
    registry.remove(owner.requestId, control); control.finish();
    expect(registry.cancel(action)).toBe("unavailable");
  });

  it.each([
    { userId: "U2" }, { teamId: "T2" }, { channel: "C2" },
    { messageTs: "forged" }, { threadTs: "other-thread" }, { requestId: "request-2" },
    { userId: "" }, { teamId: "" }, { channel: "" }, { messageTs: "" },
  ])("does not reveal or cancel other user/team/channel/thread/message/unknown entries: %j", mismatch => {
    const { registry, control } = setup();
    expect(registry.cancel({ ...action, ...mismatch })).toBe("unavailable");
    expect(control.signal.aborted).toBe(false);
    expect(registry.cancel(action)).toBe("accepted");
    // An attacker still gets the identical response after the true owner's cancellation.
    expect(registry.cancel({ ...action, ...mismatch })).toBe("unavailable");
    control.finish();
  });

  it("ignores forged button actor/approval metadata", () => {
    const { registry, control } = setup();
    const forged = { ...action, userId: "attacker", actor: owner.userId, approved: true, team: owner.teamId };
    expect(registry.cancel(forged)).toBe("unavailable");
    expect(control.signal.aborted).toBe(false);
    control.finish();
  });

  it("allows verified message linkage without an optional thread hint, never without a message", () => {
    const { registry, control } = setup();
    const { threadTs: _threadTs, ...noHint } = action;
    expect(registry.cancel(noHint)).toBe("accepted");
    control.finish();
  });

  it("cannot cancel before the server binds its own control message", () => {
    const registry = new CancellationRegistry();
    const control = new ConversationControl();
    registry.register(owner, control);
    expect(registry.cancel(action)).toBe("unavailable");
    expect(control.signal.aborted).toBe(false);
    const wrong = new ConversationControl();
    expect(() => registry.bindMessage(owner.requestId, wrong, "2.2")).toThrow();
    wrong.finish();
    registry.bindMessage(owner.requestId, control, "2.2");
    expect(() => registry.bindMessage(owner.requestId, control, "3.3")).toThrow();
    control.finish();
  });

  it("rejects missing trusted team/identity instead of trusting a button actor field", () => {
    const registry = new CancellationRegistry();
    const control = new ConversationControl();
    expect(() => registry.register({ ...owner, teamId: "" }, control)).toThrow();
    control.finish();
  });

  it("takes an immutable identity snapshot and rejects duplicate registrations", () => {
    const registry = new CancellationRegistry();
    const control = new ConversationControl();
    const event = { ...owner };
    registry.register(event, control);
    event.userId = "attacker";
    registry.bindMessage(owner.requestId, control, "2.2");
    expect(() => registry.register(owner, control)).toThrow();
    expect(registry.cancel({ ...action, userId: "attacker" })).toBe("unavailable");
    expect(registry.cancel(action)).toBe("accepted");
    control.finish();
  });

  it.each(["expired", "committing", "completed", "failed", "removed"])("uses the same unavailable result for %s", async state => {
    const { registry, control } = setup();
    let resolve!: () => void;
    let commit: Promise<void> | undefined;
    if (state === "expired") await vi.advanceTimersByTimeAsync(180_000);
    if (state === "committing") commit = control.commit(() => new Promise<void>(yes => { resolve = yes; }));
    if (state === "completed") await control.commit(async () => {});
    if (state === "failed") control.finish();
    if (state === "removed") registry.remove(owner.requestId, control);
    expect(registry.cancel(action)).toBe("unavailable");
    expect(registry.cancel({ ...action, userId: "attacker" })).toBe("unavailable");
    if (commit) { resolve(); await commit; }
    control.finish();
  });

  it("does not let stale cleanup remove a later request controller", () => {
    const { registry, control } = setup();
    registry.remove(owner.requestId, control); control.finish();
    const next = new ConversationControl();
    registry.register(owner, next);
    registry.bindMessage(owner.requestId, next, "2.2");
    registry.remove(owner.requestId, control);
    expect(registry.cancel(action)).toBe("accepted");
    next.finish();
  });
});
