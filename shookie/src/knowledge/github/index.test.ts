import { describe, expect, it } from "vitest";
import { getGitHubKnowledge, getAllGitHubKnowledge } from "./index.js";

describe("GitHub knowledge registry", () => {
  it("returns knowledge for soongpt-web", () => {
    const knowledge = getGitHubKnowledge("soongpt-web");
    expect(knowledge).not.toBeNull();
    expect(knowledge).toContain("soongpt-web");
  });

  it("returns knowledge for soongpt-backend", () => {
    const knowledge = getGitHubKnowledge("soongpt-backend");
    expect(knowledge).not.toBeNull();
    expect(knowledge).toContain("soongpt-backend");
  });

  it("returns null for unknown repo", () => {
    expect(getGitHubKnowledge("nonexistent")).toBeNull();
  });

  it("getAllGitHubKnowledge returns all entries", () => {
    const all = getAllGitHubKnowledge();
    expect(all.size).toBe(2);
    expect(all.has("soongpt-web")).toBe(true);
    expect(all.has("soongpt-backend")).toBe(true);
  });
});
