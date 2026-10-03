import { afterEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  LLM_API_KEY:'synthetic-llm', LLM_BASE_URL:'https://api.deepseek.com', LLM_MODEL:'deepseek-flash',
  POSTHOG_API_KEY:'', GITHUB:'', EXA_API_KEY:'',
}));
vi.mock('../config.js',()=>({config:settings}));
vi.mock('../projects/index.js',()=>({getPostHogProjects:()=>[]}));
vi.mock('@ai-sdk/deepseek',()=>({createDeepSeek:()=>()=> 'openai/test-model'}));
vi.mock('../logger.js',()=>({logger:{info:vi.fn(),debug:vi.fn()}}));
import { createAgent } from './index.js';
afterEach(()=>{settings.EXA_API_KEY='';});
describe('production agent registration',()=>{
  it('makes web_fetch usable without any search/domain key',async()=>{
    const agent=createAgent();
    expect(Object.keys(await agent.listTools())).toEqual(['web_fetch']);
    expect(await agent.getInstructions()).toContain('검색 불가');
  });
  it('passes optional configured key to main direct search registration',async()=>{
    settings.EXA_API_KEY='synthetic-exa';
    const agent=createAgent();
    expect(Object.keys(await agent.listTools())).toEqual(['web_fetch','web_search']);
    expect(await agent.getInstructions()).toContain('web_search 등록됨 (Exa)');
  });
});
