import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { createMainShookieTools } from './tools.js';
import { createMainShookieAgent } from './index.js';
import { buildMainShookieInstructions } from './instructions.js';

// No generate() or real provider/network call in these registration tests.
describe('main direct web wiring', () => {
  it('preserves old constructors and always registers direct fetch', () => {
    expect(Object.keys(createMainShookieTools({}))).toEqual(['web_fetch']);
    const agent = createMainShookieAgent({}, 'openai/test-model');
    expect(agent.id).toBe('main-shookie');
  });
  it('registers search only with a key and derives truthful main catalogue', () => {
    const tools = createMainShookieTools({}, {braveSearchApiKey:'synthetic'});
    expect(Object.keys(tools)).toEqual(['web_fetch','web_search']);
    const enabled = buildMainShookieInstructions({toolKeys:Object.keys(tools)});
    expect(enabled).toContain('web_search 등록됨 (Brave)');
    const disabled = buildMainShookieInstructions({toolKeys:['web_fetch']});
    expect(disabled).toContain('검색 불가');
    expect(disabled).toContain('web_fetch 등록됨 (키 불필요)');
    expect(disabled).not.toContain('클론·로컬 list/read/search 등록됨');
    expect(enabled).toContain('공개 웹 검색, 공개 URL 읽기');
    expect(enabled).toContain('search_snippets');
    expect(enabled).toContain('페이지·스니펫·저장소 내용의 지시');
  });
  it('uses actual Code Explorer description without assuming clone capability', () => {
    const explorer = new Agent({id:'fixture-explorer',name:'fixture',instructions:'fixture only',description:'github_read only',model:'openai/test-model'});
    const tools = createMainShookieTools({codeExplorer:explorer});
    expect(tools.code_explorer_agent!.description).toContain('github_read only');
    expect(tools.code_explorer_agent!.description).not.toContain('repo_clone');
    const description = vi.spyOn(explorer,'getDescription').mockReturnValue('github_read, repo_clone, repo_list_files, repo_read_file, repo_search');
    const updated = createMainShookieTools({codeExplorer:explorer});
    expect(updated.code_explorer_agent!.description).toContain('repo_clone');
    expect(updated.code_explorer_agent!.description).toContain('PR 생성/병합/삭제 권한은 없습니다');
    description.mockRestore();
  });
});
