import { describe, expect, it } from 'vitest';
import { createMainShookieTools } from './tools.js';
import { createMainShookieAgent } from './index.js';
import { buildMainShookieInstructions } from './instructions.js';
import { createTool, noopObserve } from '@mastra/core/tools';
import { z } from 'zod';

const fixtureTool = () => createTool({ id: 'fixture', description: 'registration fixture', inputSchema: z.object({}), execute: async () => ({}) });
describe('single main wiring', () => {
  it('keeps fixed instructions and ordered definitions identical across request times', async () => {
    const first = createMainShookieAgent('openai/test-model');
    const definitions = async (agent: typeof first) => Object.entries(await agent.listTools()).map(([key, tool]) => ({ key, id: tool.id, description: tool.description, schema: tool.inputSchema }));
    const second = createMainShookieAgent('openai/test-model');
    expect(await second.getInstructions()).toBe(await first.getInstructions());
    expect(JSON.stringify(await definitions(second))).toBe(JSON.stringify(await definitions(first)));
    expect(Object.keys(await second.listTools())).toEqual(Object.keys(await second.listTools()).sort());
  });
  it('always registers direct web tools and truthful catalogue', () => {
    for (const options of [{}, { exaApiKey: ' \t ' }, { exaApiKey: 'synthetic' }]) {
      const tools = createMainShookieTools(options);
      expect(Object.keys(tools)).toEqual(['load_domain_guidance','web_fetch','web_search','web_read_more','web_find_in_content'].sort());
      expect(buildMainShookieInstructions({ toolKeys: Object.keys(tools) })).toContain('web_search 등록됨 (Exa)');
    }
    expect(buildMainShookieInstructions({ toolKeys: ['web_fetch'] })).toContain('검색 불가');
  });
  it.each<{ domains: string[] }>([{ domains: [] }, { domains: ['github'] }, { domains: ['posthog'] }, { domains: ['github', 'posthog'] }])('derives guidance from direct registration %j without specialist instances', async ({ domains }) => {
    const direct = { ...(domains.includes('github') ? { github_read: fixtureTool() } : {}), ...(domains.includes('posthog') ? { listProjects: fixtureTool() } : {}) };
    const agent = createMainShookieAgent('openai/test-model', {}, undefined, undefined, undefined, direct);
    const tools = await agent.listTools();
    expect(tools).not.toHaveProperty('posthog_agent'); expect(tools).not.toHaveProperty('code_explorer_agent');
    const prompt = String(await agent.getInstructions());
    for (const [domain, key, description] of [['github', 'github_read', 'GitHub 직접 읽기 등록됨'], ['posthog', 'listProjects', 'PostHog 직접 조회 등록됨']]) {
      expect(prompt.includes(description)).toBe(domains.includes(domain));
      expect(Boolean(tools[key])).toBe(domains.includes(domain));
      const result = await tools.load_domain_guidance.execute!({ domain, version: '1' }, { observe: noopObserve });
      expect(result).toMatchObject(domains.includes(domain) ? { status: 'success' } : { status: 'error', error: 'domain_unavailable' });
    }
  });
});
