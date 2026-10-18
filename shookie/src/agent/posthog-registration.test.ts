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
  it("registers shared direct PostHog tools and optional specialist without startup catalog fetch", async () => {
    const main = createAgent();
    const mainTools = Object.keys(await main.listTools());
    expect(mainTools).toContain("posthog_agent");
    expect(mainTools).toContain("listProjects");
    const direct = await main.listTools();
    expect(direct.listProjects).toBe((await fixture.subagents[0].listTools()).listProjects);
    expect(fixture.subagents).toHaveLength(1);
    expect(Object.keys(await fixture.subagents[0].listTools())).toEqual(["listProjects", "queryEvents", "queryInsights", "listFeatureFlags",
      "listDashboards", "getDashboard", "queryHogQL", "listPersons", "listCohorts", "listExperiments"]);
    const instructions = String(await fixture.subagents[0].getInstructions());
    expect(instructions).toContain("listProjects");
    expect(instructions).not.toMatch(/SSUTime|Soongpt|440922|308417/);
    expect(String(await main.getInstructions())).toContain("실제 등록된 메인 도구: listProjects");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("ordinary project lists execute the registered main tool with live registry and no specialist", async () => {
    const main = createAgent(); const tools = await main.listTools();
    const specialist = vi.spyOn(fixture.subagents[0], "generate");
    const result = await tools.listProjects.execute!({}, {} as never);
    expect(result).toMatchObject({ status: "success", projects: [] });
    expect(fetcher).toHaveBeenCalledOnce(); expect(specialist).not.toHaveBeenCalled();
    fetcher.mockRejectedValueOnce(new Error("registry unavailable"));
    expect(await tools.listProjects.execute!({}, {} as never)).toMatchObject({ status: "error", error: { code: "registry_unavailable" } });
  });
  it.each([
    ["registry blank (no code-whitelist fallback)", { RADAR_POSTHOG_REGISTRY_API_URL: "", SHOOKIE_POSTHOG_REGISTRY_INTERNAL_API_KEY: "" }],
    ["PostHog account key blank", { POSTHOG_API_KEY: "" }],
  ])("disables the PostHog subagent when %s", async (_label, overrides) => {
    Object.assign(fixture.settings, overrides);
    const main = createAgent();
    expect(Object.keys(await main.listTools())).not.toContain("posthog_agent");
    expect(fixture.subagents).toHaveLength(0);
    expect(Object.keys(await main.listTools())).not.toContain("listProjects");
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
