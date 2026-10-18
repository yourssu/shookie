import { expect, it } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { bindRequestClock, requestClockMessages } from "./request-clock.js";
import { buildMainShookieInstructions } from "./agents/main-shookie/instructions.js";

it("keeps fixed policy stable across clocks, accepts only host-minted context capabilities, and survives Mastra shallow copies", () => {
  const a = new RequestContext(), b = new RequestContext();
  bindRequestClock(a, new Date("2026-01-01T16:00:00Z"));
  const fixedA = buildMainShookieInstructions({ toolKeys: ["z", "a"] });
  bindRequestClock(b, new Date("2026-02-01T16:00:00Z"));
  expect(buildMainShookieInstructions({ toolKeys: ["a", "z"] })).toBe(fixedA);
  expect(requestClockMessages(a)).not.toEqual(requestClockMessages(b));
  expect(requestClockMessages(new RequestContext(a.entries()))).toEqual(requestClockMessages(a));
  const fake = new RequestContext();
  fake.set("shookie.host-request-clock.v1", {});
  expect(requestClockMessages(fake)).toEqual([]);
  fake.set("shookie.host-request-clock.v1", "2026-01-01");
  expect(requestClockMessages(fake)).toEqual([]);
  expect(requestClockMessages()).toEqual([]);
  expect(() => bindRequestClock(a)).toThrow("already bound");
});
