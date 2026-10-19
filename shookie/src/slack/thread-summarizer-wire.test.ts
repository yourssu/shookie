import { afterEach, expect, it, vi } from 'vitest';
import { completion, response } from '../agent/deepseek-transport.test-helper.js';
vi.mock('../config.js', () => ({ config: {
  LLM_API_KEY: 'synthetic-only', LLM_BASE_URL: 'https://api.deepseek.com', LLM_MODEL: 'deepseek-flash',
} }));
import { summarizeThread } from './thread-summarizer.js';
afterEach(() => vi.unstubAllGlobals());
it('serializes explicit high through the real AI SDK summarizer without changing budgets or thinking', async () => {
  const wires: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
    wires.push(JSON.parse(String(init?.body)));
    return response(completion('synthetic summary'), false);
  }));
  expect(await summarizeThread([{ role: 'user', content: 'synthetic old message' }], 8000)).toBe('synthetic summary');
  expect(wires).toHaveLength(1);
  expect(wires[0]).toMatchObject({ model: 'deepseek-flash', reasoning_effort: 'high', max_tokens: 1500 });
  expect(wires[0]).not.toHaveProperty('thinking');
  expect(wires[0]).not.toHaveProperty('tools');
});
