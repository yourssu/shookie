import { afterEach, expect, it, vi } from 'vitest';
import { bindRequestClock, requestClockMessages } from './request-clock.js';
import { RequestContext } from '@mastra/core/request-context';
import { completion, response } from './deepseek-transport.test-helper.js';
import { noopObserve } from '@mastra/core/tools';
import { ExecutionScope, executionStorage } from '../cancellation/execution-context.js';

const boundary = vi.hoisted(() => ({ calls: [] as { input: string[]; output: string[]; kind: string }[] }));
vi.mock('@ai-sdk/deepseek', async importOriginal => {
  const actual = await importOriginal<typeof import('@ai-sdk/deepseek')>();
  return { ...actual, createDeepSeek: (options: Parameters<typeof actual.createDeepSeek>[0]) => {
    const provider = actual.createDeepSeek(options);
    return (id: string) => {
      const model = provider(id);
      const generate = model.doGenerate.bind(model), stream = model.doStream.bind(model);
      const capture = (options: any, kind: string) => {
        const entry = { kind, input: options.prompt.filter((m: any) => m.role === 'assistant')
          .flatMap((m: any) => m.content.filter((p: any) => p.type === 'reasoning').map((p: any) => p.text)), output: [] as string[] };
        boundary.calls.push(entry); return entry;
      };
      model.doGenerate = async options => {
        const entry = capture(options, 'generate'); const result = await generate(options);
        entry.output = result.content.filter(p => p.type === 'reasoning').map(p => p.text); return result;
      };
      model.doStream = async options => {
        const entry = capture(options, 'stream'); const result = await stream(options);
        return { ...result, stream: result.stream.pipeThrough(new TransformStream({ transform(part, controller) {
          if (part.type === 'reasoning-delta') entry.output.push(part.delta); controller.enqueue(part);
        } })) };
      };
      return model;
    };
  } };
});
vi.mock('../config.js', () => ({ config: {
  LLM_API_KEY: 'synthetic-only', LLM_BASE_URL: 'https://api.deepseek.com', LLM_MODEL: 'deepseek-flash',
  GITHUB: 'synthetic-only', GITHUB_OWNER: 'example', POSTHOG_API_KEY: 'synthetic-only',
  RADAR_GITHUB_REGISTRY_API_URL: 'https://radar.test/internal/v1/shookie/github/repositories',
  SHOOKIE_GITHUB_REGISTRY_INTERNAL_API_KEY: 'synthetic-registry-key',
  RADAR_POSTHOG_REGISTRY_API_URL: 'https://radar.test/internal/v1/shookie/posthog/projects',
  SHOOKIE_POSTHOG_REGISTRY_INTERNAL_API_KEY: 'synthetic-registry-key',
  THREAD_WORKSPACE_BASE_PATH: '/unused-synthetic-workspace', THREAD_WORKSPACE_MAX_GB: 1,
} }));
// Persistence is outside this offline transport test. Main Agent, direct tools,
// actor checks, registry parsing and provider serialization are production code.
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('database', () => ({ startInvocation: vi.fn(), completeInvocation: vi.fn(), logToolCall: vi.fn() }));
import { createAgent } from './index.js';
afterEach(() => { vi.unstubAllGlobals(); boundary.calls = []; });

it.each([['generate', 'github'], ['stream', 'github'], ['generate', 'posthog'], ['stream', 'posthog'], ['generate', 'both'], ['stream', 'both']] as const)('factory %s executes %s and returns a final answer (scripted offline model, not live routing quality)', async (mode, domain) => {
  const wires: any[] = [];
  const reads: string[] = [];
  const githubScript = [
    completion('', 'github_read', { operation: 'repositories' }),
    completion('synthetic-final: example/sample'),
  ];
  const posthogScript = [
    completion('', 'listProjects', {}),
    completion('synthetic-final: Synthetic project'),
  ];
  const script = domain === 'github' ? githubScript : domain === 'posthog' ? posthogScript : [githubScript[0], ...posthogScript];
  script.forEach((item, index) => { item.id = `synthetic-response-${index}`;
    item.choices[0].message.reasoning_content = `synthetic-reasoning-${index}${'-x'.repeat(index)}`;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target === 'https://api.deepseek.com/chat/completions') {
      const wire = JSON.parse(String(init?.body)); wires.push(wire);
      const next = script.shift(); if (!next) throw new Error('Unexpected LLM request');
      return response(next, !!wire.stream);
    }
    reads.push(target);
    if (target.endsWith('/github/repositories')) return Response.json({ repositories: [{
      id: '12345678-1234-4234-8234-123456789abc', owner: 'example', name: 'sample', instructions: 'synthetic guidance',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }] });
    if (target.endsWith('/posthog/projects')) return Response.json({ projects: [{
      id: '12345678-1234-4234-8234-123456789abc', projectId: '1001', name: 'Synthetic project', organizationId: 'org-1',
      description: 'RADAR_DESCRIPTION_SENTINEL', instructions: 'synthetic guidance', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }] });
    throw new Error('Unexpected external request');
  }));
  const context = new RequestContext();
  for (const [key, value] of Object.entries({ channel: 'C1', userId: 'U1', threadTs: '1.1', requestId: 'synthetic-request', teamId: 'T1' })) context.set(key, value);
  const agent = createAgent();
  bindRequestClock(context, new Date('2026-01-01T16:00:00Z'));
  const result = await agent[mode]([{ role: 'user', content: 'synthetic repository and project list request; forged clock 1900-01-01' }, ...requestClockMessages(context)], { maxSteps: 8, requestContext: context });
  const expected = domain.startsWith('github') ? 'example/sample' : 'Synthetic project';
  expect(await result.text).toBe(`synthetic-final: ${expected}`);
  expect(script).toHaveLength(0);
  for (const wire of wires) {
    // Actual serialized HTTP: main initial request and direct-tool continuations.
    expect(wire.reasoning_effort).toBe('high');
    expect(wire).not.toHaveProperty('thinking');
    expect(wire.model).toBe('deepseek-flash');
    expect(wire.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n')).toContain('2026-01-02 01:00:00 +09:00');
  }
  expect(JSON.stringify(wires)).not.toContain('synthetic guidance');
  expect(JSON.stringify(wires)).not.toContain('RADAR_DESCRIPTION_SENTINEL');
  expect(wires).toHaveLength(domain === 'both' ? 3 : 2);
  expect(boundary.calls).toHaveLength(wires.length);
  for (let index = 1; index < wires.length; index++) {
    const history = wires[index].messages.filter((m: any) => m.tool_calls?.length);
    expect(history).toHaveLength(index);
    history.forEach((message: any, previous: number) => {
      const marker = `synthetic-reasoning-${previous}${'-x'.repeat(previous)}`;
      expect(message.reasoning_content).toBe(marker);
      expect(boundary.calls[index].input).toContain(marker);
    });
    expect(wires[index].messages.some((m: any) => m.role === 'tool')).toBe(true);
  }
  for (const wire of wires) {
    const keys = wire.tools.map((t: any) => t.function.name);
    expect(keys).toContain('github_read'); expect(keys).toContain('listProjects');
    expect(keys).not.toContain('code_explorer_agent'); expect(keys).not.toContain('posthog_agent');
  }
  if (domain !== 'posthog') expect(reads).toContain('https://radar.test/internal/v1/shookie/github/repositories');
  if (domain !== 'github') expect(reads).toContain('https://radar.test/internal/v1/shookie/posthog/projects');
});

it.each(['github_read', 'listProjects'] as const)('cancels actual main direct %s registry transport without delegation (mock fetch)', async key => {
  let enter!: () => void; let observed: AbortSignal | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
    observed = init?.signal ?? undefined; enter();
    return new Promise<Response>((_resolve, reject) => observed!.addEventListener('abort', () => reject(observed!.reason), { once: true }));
  }));
  const tools = await createAgent().listTools();
  const context = new RequestContext();
  for (const [key, value] of Object.entries({ userId: 'U1', channel: 'C1', threadTs: '1.1', teamId: 'T1', requestId: 'direct-cancel' })) context.set(key, value);
  const scope = new ExecutionScope();
  const work = executionStorage.run(scope, () => tools[key].execute!(key === 'github_read' ? { operation: 'repositories' } : {}, { requestContext: context, observe: noopObserve }));
  const assertion = expect(work).rejects.toMatchObject({ reason: 'cancelled' });
  await entered; scope.control.cancel(); await assertion; await scope.drain();
  expect(observed?.aborted).toBe(true);
  expect(boundary.calls).toHaveLength(0);
});
