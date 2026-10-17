import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@mastra/core/agent";

const fixture = vi.hoisted(() => ({
  settings: {
    LLM_API_KEY: "synthetic-llm", LLM_BASE_URL: "https://api.deepseek.com", LLM_MODEL: "deepseek-flash",
    POSTHOG_API_KEY: "phx-synthetic", GITHUB: "", EXA_API_KEY: "",
    RADAR_POSTHOG_REGISTRY_API_URL: "https://radar.test/internal/v1/shookie/posthog/projects",
    SHOOKIE_POSTHOG_REGISTRY_INTERNAL_API_KEY: "dedicated-posthog-registry-key",
  },
  subagents: [] as Agent[],
}));
vi.mock("../config.js", () => ({ config: fixture.settings }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => "openai/test-model" }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./agents/posthog/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("./agents/posthog/index.js")>();
  return { createPostHogAgent: (...args: Parameters<typeof original.createPostHogAgent>) => {
    const agent = original.createPostHogAgent(...args); fixture.subagents.push(agent); return agent;
  } };
});
import { createAgent } from "./index.js";

const reset = { ...fixture.settings };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Object.assign(fixture.settings, reset); fixture.subagents = [];
  fetcher = vi.fn(async () => new Response(JSON.stringify({ projects: [] })));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("PostHog subagent registration (Radar registry is the sole authority)", () => {
  it("registers posthog_agent with listProjects + nine tools only inside the subagent, without fetching the catalog at startup", async () => {
    const main = createAgent();
    const mainTools = Object.keys(await main.listTools());
    expect(mainTools).toContain("posthog_agent");
    expect(mainTools).not.toContain("listProjects");
    expect(fixture.subagents).toHaveLength(1);
    expect(Object.keys(await fixture.subagents[0].listTools())).toEqual(["listProjects", "queryEvents", "queryInsights", "listFeatureFlags",
      "listDashboards", "getDashboard", "queryHogQL", "listPersons", "listCohorts", "listExperiments"]);
    const instructions = String(await fixture.subagents[0].getInstructions());
    expect(instructions).toContain("listProjects");
    expect(instructions).not.toMatch(/SSUTime|Soongpt|440922|308417/);
    expect(String(await main.getInstructions())).toContain("posthog_agent 등록됨: Radar에 현재 등록된 프로젝트만");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ["registry blank (no code-whitelist fallback)", { RADAR_POSTHOG_REGISTRY_API_URL: "", SHOOKIE_POSTHOG_REGISTRY_INTERNAL_API_KEY: "" }],
    ["PostHog account key blank", { POSTHOG_API_KEY: "" }],
  ])("disables the PostHog subagent when %s", async (_label, overrides) => {
    Object.assign(fixture.settings, overrides);
    const main = createAgent();
    expect(Object.keys(await main.listTools())).not.toContain("posthog_agent");
    expect(fixture.subagents).toHaveLength(0);
    expect(String(await main.getInstructions())).toContain("PostHog Analyst | PostHog 도메인 분석 | 미등록: 사용 불가");
  });
  it.each([
    { SHOOKIE_POSTHOG_REGISTRY_INTERNAL_API_KEY: "" },
    { RADAR_POSTHOG_REGISTRY_API_URL: "" },
    { RADAR_POSTHOG_REGISTRY_API_URL: "https://radar.test/internal/v1/shookie/posthog/projects?x=1" },
  ])("rejects partial or malformed registry configuration %#", overrides => {
    Object.assign(fixture.settings, overrides);
    expect(() => createAgent()).toThrow(/PostHog registry/);
  });
});
