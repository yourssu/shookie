import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ settings: {
  LLM_API_KEY: "synthetic-llm", LLM_BASE_URL: "https://api.deepseek.com", LLM_MODEL: "deepseek-flash",
  POSTHOG_API_KEY: "phx-synthetic", GITHUB: "synthetic-github", EXA_API_KEY: "", GITHUB_OWNER: 'example',
  RADAR_POSTHOG_REGISTRY_API_URL: "https://radar.test/internal/v1/shookie/posthog/projects",
  SHOOKIE_POSTHOG_REGISTRY_INTERNAL_API_KEY: "dedicated-posthog-registry-key",
  RADAR_GITHUB_REGISTRY_API_URL: 'https://radar.test/internal/v1/shookie/github/repositories',
  SHOOKIE_GITHUB_REGISTRY_INTERNAL_API_KEY: 'synthetic-github-registry',
  THREAD_WORKSPACE_BASE_PATH: '/unused', THREAD_WORKSPACE_MAX_GB: 1,
}, agents: [] as string[] }));
vi.mock("../config.js", () => ({ config: fixture.settings }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => "openai/test-model" }));
vi.mock('@mastra/core/agent', async importOriginal => {
  const { Agent } = await importOriginal<typeof import('@mastra/core/agent')>();
  return { Agent: class extends Agent { constructor(options: ConstructorParameters<typeof Agent>[0]) { super(options as any); fixture.agents.push(options.id); } } };
});
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { createAgent } from "./index.js";
const reset = { ...fixture.settings };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Object.assign(fixture.settings, reset); fixture.agents = [];
  fetcher = vi.fn(async () => Response.json({ projects: [] })); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());
describe('production single conversational Agent registration', () => {
  it.each([[true, true], [true, false], [false, true], [false, false]])('config GitHub=%s PostHog=%s creates exactly one Agent', async (github, posthog) => {
    fixture.settings.GITHUB = github ? reset.GITHUB : ''; fixture.settings.POSTHOG_API_KEY = posthog ? reset.POSTHOG_API_KEY : '';
    const main = createAgent(); const tools = await main.listTools();
    expect(fixture.agents).toEqual(['main-shookie']);
    expect(tools).not.toHaveProperty('posthog_agent'); expect(tools).not.toHaveProperty('code_explorer_agent');
    expect(Boolean(tools.github_read)).toBe(github); expect(Boolean(tools.listProjects)).toBe(posthog);
    expect(tools.load_domain_guidance.description).toContain(github ? 'github' : posthog ? 'posthog' : '없음');
    expect(String(await main.getInstructions())).toContain(`실제 등록된 메인 도구: ${Object.keys(tools).sort().join(', ')}`);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('direct project lists revalidate live registry; failure is not empty data', async () => {
    const tools = await createAgent().listTools();
    expect(await tools.listProjects.execute!({}, {} as never)).toMatchObject({ status: 'success', projects: [] });
    expect(fetcher).toHaveBeenCalledOnce(); fetcher.mockRejectedValueOnce(new Error('registry unavailable'));
    expect(await tools.listProjects.execute!({}, {} as never)).toMatchObject({ status: 'error', error: { code: 'registry_unavailable' } });
  });
  it('does not fall back when PostHog registry is blank', async () => {
    fixture.settings.RADAR_POSTHOG_REGISTRY_API_URL = ''; fixture.settings.SHOOKIE_POSTHOG_REGISTRY_INTERNAL_API_KEY = '';
    expect(await createAgent().listTools()).not.toHaveProperty('listProjects');
  });
  it.each([{ SHOOKIE_POSTHOG_REGISTRY_INTERNAL_API_KEY: '' }, { RADAR_POSTHOG_REGISTRY_API_URL: '' },
    { RADAR_POSTHOG_REGISTRY_API_URL: 'https://radar.test/internal/v1/shookie/posthog/projects?x=1' }])('rejects partial/malformed registry %#', overrides => {
    Object.assign(fixture.settings, overrides); expect(() => createAgent()).toThrow(/PostHog registry/);
  });
});
