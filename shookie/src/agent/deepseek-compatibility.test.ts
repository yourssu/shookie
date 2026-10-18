import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { completion, response } from './deepseek-transport.test-helper.js';
const provider = (fetch: typeof globalThis.fetch) => createDeepSeek({ apiKey: 'synthetic-only', fetch })('deepseek-flash');
afterEach(() => vi.restoreAllMocks());

describe('DeepSeek Flash real wire compatibility (offline only)', () => {
  it('preserves reasoning before the last user turn and emits required empty reasoning for tool history', async () => {
    let wire: any;
    const model = provider(async (_url, init) => { wire = JSON.parse(String(init?.body)); return response(completion(), false); });
    await model.doGenerate({ prompt: [
      { role: 'user', content: [{ type: 'text', text: 'synthetic-first' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'synthetic-prior-reasoning' }, { type: 'text', text: 'synthetic-answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'synthetic-next' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'empty', toolName: 'lookup', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'empty', toolName: 'lookup', output: { type: 'text', value: 'synthetic-result' } }] },
    ] });
    expect(wire.model).toBe('deepseek-flash');
    expect.soft(wire.messages[1].reasoning_content).toBe('synthetic-prior-reasoning');
    expect.soft(wire.messages[3].reasoning_content).toBe('');
  });

  it('keeps reasoning continuous across empty tool_calls arrays', async () => {
    const chunks = ['A', 'B'].map(reasoning_content => ({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta: { reasoning_content, tool_calls: [] }, finish_reason: null }] }));
    const model = provider(async () => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }] });
    const parts = []; for await (const part of stream) parts.push(part);
    expect(parts.filter(p => p.type === 'reasoning-start')).toHaveLength(1);
    expect(parts.filter(p => p.type === 'reasoning-end')).toHaveLength(1);
    expect(parts.filter(p => p.type === 'reasoning-delta').map(p => p.delta).join('')).toBe('AB');
  });

  it.each(['generate', 'stream'] as const)('%s uses the real Mastra tool loop and preserves reasoning', async mode => {
    const requests: any[] = [];
    const model = provider(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)); requests.push(wire);
      return response(requests.length === 1 ? completion('', 'lookup') : completion(), !!wire.stream);
    });
    const execute = vi.fn(async () => ({ value: 'synthetic-result' }));
    const agent = new Agent({ id: 'synthetic', name: 'synthetic', instructions: 'synthetic-only', model,
      tools: { lookup: createTool({ id: 'lookup', description: 'synthetic lookup', inputSchema: z.object({}), execute }) } });
    const result = await agent[mode]('synthetic-request', { maxSteps: 3 });
    expect(await result.text).toBe('synthetic-final');
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    const history = requests[1].messages.find((m: any) => m.tool_calls?.length);
    expect(history.reasoning_content).toBe('synthetic-reasoning');
    expect(requests[1].messages.some((m: any) => m.role === 'tool')).toBe(true);
  });
});
