import { describe, expect, it } from "vitest";
import { getPostHogKnowledge, getAllPostHogKnowledge } from "./index.js";

describe("PostHog knowledge registry", () => {
  it("returns knowledge for SSUTime-Prod", () => {
    const knowledge = getPostHogKnowledge("SSUTime-Prod");
    expect(knowledge).not.toBeNull();
    expect(knowledge).toContain("SSU-Time");
  });

  it("returns knowledge for soongpt-prod", () => {
    const knowledge = getPostHogKnowledge("soongpt-prod");
    expect(knowledge).not.toBeNull();
    expect(knowledge).toContain("Soongpt");
  });

  it("returns null for unknown project", () => {
    expect(getPostHogKnowledge("nonexistent")).toBeNull();
  });

  it("getAllPostHogKnowledge returns all entries", () => {
    const all = getAllPostHogKnowledge();
    expect(all.size).toBe(2);
    expect(all.has("SSUTime-Prod")).toBe(true);
    expect(all.has("soongpt-prod")).toBe(true);
  });
});
