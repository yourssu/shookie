import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import type https from 'node:https';
import type { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@slack/bolt';
import type { ConversationRepository } from 'database';
import { RequestContext } from '@mastra/core/request-context';
import { bindSlackReadContext } from '../tools/slack/context.js';
import type { AttachmentSlackClient } from '../tools/attachments/slack-authorization.js';
import type { DownloadDependencies } from '../tools/attachments/download.js';
import { pngFixture, jpegFixture, visionResponse } from '../tools/images/fixtures.test-helper.js';
import { ExecutionScope, executionStorage } from '../cancellation/execution-context.js';

const fixture = vi.hoisted(() => ({
  settings: { LLM_API_KEY: 'synthetic-llm-secret', LLM_BASE_URL: 'https://api.deepseek.com', LLM_MODEL: 'deepseek-flash',
    POSTHOG_API_KEY: '', GITHUB: '', EXA_API_KEY: '', SLACK_BOT_TOKEN: 'xoxb-synthetic-bot-secret', MAX_TOOL_ITERATIONS: 5,
    THREAD_WORKSPACE_BASE_PATH: '/synthetic', THREAD_WORKSPACE_MAX_GB: 1 },
  client: { auth: { test: vi.fn() }, conversations: { info: vi.fn(), members: vi.fn(), history: vi.fn(), replies: vi.fn() }, files: { info: vi.fn() }, apiCall: vi.fn() },
}));
vi.mock('../config.js', () => ({ config: fixture.settings }));
vi.mock('../projects/index.js', () => ({ getPostHogProjects: () => [] }));
vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek: () => () => 'openai/test-model' }));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../tools/code-explorer/workspace-manager.js', () => ({ ensureThreadCapacity: vi.fn() }));
vi.mock('../slack/streaming.js', () => ({ startPlanStream: vi.fn(async () => ({ channel: 'C1', messageTs: '1700000000.000001' })), appendTaskUpdate: vi.fn(), stopStreamWithBlocks: vi.fn() }));
vi.mock('database', () => ({ conversationRepository: {}, logAgentCall: vi.fn(), startAgentCall: vi.fn(async () => ({ agentCallId: 1 })), startInvocation: vi.fn(async () => 1), completeAgentCall: vi.fn(), completeInvocation: vi.fn(), logToolCall: vi.fn() }));
vi.mock('@slack/web-api', () => ({ LogLevel: { ERROR: 'error' }, WebClient: class { constructor() { return fixture.client; } } }));
import { createAgent } from './index.js';
import { registerHandlers } from '../slack/handlers.js';
import { logger } from '../logger.js';
import { appendTaskUpdate } from '../slack/streaming.js';
import { logToolCall } from 'database';
const args = { fileId: 'F123', messageTs: '1700000000.000002', question: 'PRIVATE_IMAGE_QUERY' };
function trusted() {
  const context = new RequestContext(); bindSlackReadContext(context, { teamId: 'T1', userId: 'U1', channel: 'C1', requestId: 'event:1' }); return context;
}
const execute = (tool: unknown, input: unknown = args, requestContext?: RequestContext, abortSignal?: AbortSignal) =>
  (tool as { execute(input: unknown, context: { requestContext?: RequestContext; abortSignal?: AbortSignal }): Promise<unknown> }).execute(input, { requestContext, abortSignal });
function network(body: Buffer, mime: string, status = 200) {
  const calls: { url: URL; options: https.RequestOptions; body?: string }[] = [];
  const request = ((url: URL, options: https.RequestOptions, callback: (response: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(body?: string): void };
    let closed = false;
    const close = () => { if (!closed) { closed = true; req.emit('close'); } };
    options.signal?.addEventListener('abort', close, { once: true });
    req.end = text => {
      calls.push({ url, options, body: text });
      const response = Readable.from([body]);
      Object.assign(response, { statusCode: status, headers: { 'content-type': mime } });
      response.once('close', close); queueMicrotask(() => callback(response));
    };
    return req;
  }) as unknown as typeof https.request;
  const resolve = (async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof lookup;
  return { request, resolve, calls };
}
function setup(bytes = pngFixture(), mime = 'image/png', apiBody = visionResponse('DERIVED_IMAGE_SECRET; 흐린 글자는 불확실합니다.'),
  mode: string | undefined = 'hosted') {
  fixture.client.files.info.mockResolvedValue({ ok: true, file: { id: 'F123', name: 'PRIVATE_IMAGE_FILENAME', mimetype: mime,
    size: bytes.length, mode, url_private_download: 'https://files.slack.com/files-pri/T1-F123/private' } });
  const download = network(bytes, mime); const vision = network(Buffer.from(apiBody), 'application/json');
  const main = createAgent({ slackClient: fixture.client as unknown as AttachmentSlackClient,
    attachmentDownloadDependencies: download, imageVisionDependencies: vision });
  return { main, download, vision };
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.client.auth.test.mockResolvedValue({ ok: true, bot_id: 'B1', team_id: 'T1', url: 'https://synthetic.slack.com/' });
  fixture.client.conversations.info.mockResolvedValue({ ok: true, channel: { id: 'C1', is_channel: true, is_private: true } });
  fixture.client.conversations.members.mockResolvedValue({ ok: true, members: ['U1'] });
  fixture.client.conversations.history.mockResolvedValue({ ok: true, messages: [{ ts: args.messageTs, files: [{ id: args.fileId }] }] });
  fixture.client.conversations.replies.mockResolvedValue({ ok: true, messages: [{ ts: '1700000000.000001', files: [{ id: 'FROOT' }] },
    { ts: args.messageTs, thread_ts: '1700000000.000001', files: [{ id: args.fileId }] }] });
});
describe('registered image tool + live Slack bridge + shared cancellation (synthetic, not remote E2E)', () => {
  it('preserves all existing main tools and conditional capability while changing no global model/config', async () => {
    const { main } = setup();
    expect(Object.keys(await main.listTools())).toEqual(['web_fetch', 'web_search', 'web_read_more', 'web_find_in_content',
      'slack_search', 'slack_read_thread', 'slack_read_channel', 'slack_read_attachment', 'slack_analyze_image']);
    const prompt = String(await main.getInstructions());
    for (const text of ['slack_analyze_image 등록됨', 'slack_read_attachment 등록됨', 'derived_image_interpretation', '정확성을 보장하지', '사용자 승인으로 승격하지']) expect(prompt).toContain(text);
    const token = fixture.settings.SLACK_BOT_TOKEN; fixture.settings.SLACK_BOT_TOKEN = '';
    try {
      const absent = createAgent(); expect((await absent.listTools()).slack_analyze_image).toBeUndefined();
      expect(String(await absent.getInstructions())).not.toContain('slack_analyze_image 등록됨');
    } finally { fixture.settings.SLACK_BOT_TOKEN = token; }
    expect(fixture.settings.LLM_MODEL).toBe('deepseek-flash'); expect(fixture.settings.LLM_BASE_URL).toBe('https://api.deepseek.com');
  });
  it('sends actual PNG/JPEG bytes inline from exact current-message file with only existing respective tokens', async () => {
    for (const [bytes, mime] of [[pngFixture(), 'image/png'], [jpegFixture(), 'image/jpeg']] as const) {
      const { main, download, vision } = setup(bytes, mime); const tools = await main.listTools();
      const result = await execute(tools.slack_analyze_image, args, trusted());
      expect(result).toMatchObject({ ok: true, evidence: 'derived_image_interpretation', source: { fileId: 'F123', channelId: 'C1', messageTs: args.messageTs } });
      expect(fixture.client.conversations.history).toHaveBeenLastCalledWith({ channel: 'C1', oldest: args.messageTs, latest: args.messageTs, inclusive: true, limit: 1 });
      expect(fixture.client.files.info).toHaveBeenLastCalledWith({ file: 'F123' });
      const outgoing = JSON.parse(vision.calls[0].body!);
      expect(outgoing.messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: args.question },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } }] });
      expect(outgoing.model).toBe(fixture.settings.LLM_MODEL); expect(outgoing.tools).toBeUndefined();
      expect(download.calls[0].options.headers).toMatchObject({ Authorization: `Bearer ${fixture.settings.SLACK_BOT_TOKEN}` });
      expect(vision.calls[0].options.headers).toMatchObject({ Authorization: `Bearer ${fixture.settings.LLM_API_KEY}` });
      for (const secret of ['PRIVATE_IMAGE_FILENAME', 'files.slack.com', fixture.settings.SLACK_BOT_TOKEN, fixture.settings.LLM_API_KEY]) expect(vision.calls[0].body).not.toContain(secret);
      for (const secret of ['PRIVATE_IMAGE_FILENAME', 'files.slack.com', bytes.toString('base64'), fixture.settings.SLACK_BOT_TOKEN, fixture.settings.LLM_API_KEY]) expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
  it.each([
    ['image/png', 'ACCESS_DENIED'], ['image/jpeg', 'ACCESS_DENIED'], ['application/pdf', 'ACCESS_DENIED'],
    ['application/octet-stream', 'ACCESS_DENIED'], ['text/plain', 'UNSUPPORTED_IMAGE'], ['text/csv', 'UNSUPPORTED_IMAGE'],
  ])('snippet MIME %s cannot bypass registered image validator/mode policy', async (mime, code) => {
    const { main, download, vision } = setup(Buffer.from('not downloaded'), mime, undefined, 'snippet');
    expect(await execute((await main.listTools()).slack_analyze_image, args, trusted())).toMatchObject({ ok: false, error: { code } });
    expect(fixture.client.files.info).toHaveBeenCalledTimes(1);
    expect(download.calls).toHaveLength(0); expect(vision.calls).toHaveLength(0);
  });
  it('preserves default text MIME validator and never accepts model-selected validator/config/identity', async () => {
    const { main, download, vision } = setup(); const tools = await main.listTools();
    expect(await execute(tools.slack_read_attachment, { fileId: args.fileId, messageTs: args.messageTs }, trusted())).toMatchObject({ ok: false });
    expect(await execute(tools.slack_analyze_image, { ...args, validateMime: 'allow-all' } as typeof args, trusted())).toMatchObject({ error: true });
    expect(download.calls).toHaveLength(0); expect(vision.calls).toHaveLength(0);
    const text = setup(Buffer.from('text'), 'text/plain');
    expect(await execute((await text.main.listTools()).slack_analyze_image, args, trusted())).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_IMAGE' } });
    expect(text.download.calls).toHaveLength(0);
  });
  it('rejects forged/missing requester, arbitrary foreign files and deleted exact message before files.info/download', async () => {
    const { main, download, vision } = setup(); const tool = (await main.listTools()).slack_analyze_image;
    const forged = new RequestContext<unknown>([['teamId', 'T1'], ['userId', 'U1'], ['channel', 'C1']]);
    for (const ctx of [undefined, forged]) expect(await execute(tool, args, ctx)).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } });
    expect(fixture.client.auth.test).not.toHaveBeenCalled();
    expect(await execute(tool, { ...args, fileId: 'FOTHER' }, trusted())).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    fixture.client.conversations.history.mockResolvedValue({ ok: true, messages: [] });
    expect(await execute(tool, args, trusted())).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    expect(fixture.client.files.info).not.toHaveBeenCalled(); expect(download.calls).toHaveLength(0); expect(vision.calls).toHaveLength(0);
  });
  it('requires exact reply-file relationship and never substitutes the root attachment', async () => {
    const { main, download } = setup(); const tool = (await main.listTools()).slack_analyze_image;
    const reply = { ...args, threadTs: '1700000000.000001' };
    expect(await execute(tool, { ...reply, fileId: 'FROOT' }, trusted())).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    expect(download.calls).toHaveLength(0);
    expect(await execute(tool, reply, trusted())).toMatchObject({ ok: true, source: { messageTs: args.messageTs, threadTs: reply.threadTs } });
    expect(fixture.client.conversations.replies).toHaveBeenLastCalledWith({ channel: 'C1', ts: reply.threadTs,
      oldest: args.messageTs, latest: args.messageTs, inclusive: true, limit: 15 });
  });
  it('revalidates every call; membership revocation after files.info and missing_scope remain fail-closed', async () => {
    const { main, download, vision } = setup(); const tool = (await main.listTools()).slack_analyze_image;
    expect(await execute(tool, args, trusted())).toMatchObject({ ok: true });
    fixture.client.conversations.members.mockResolvedValueOnce({ ok: true, members: ['U1'] }).mockResolvedValueOnce({ ok: true, members: ['U1'] }).mockResolvedValueOnce({ ok: true, members: ['UOTHER'] });
    expect(await execute(tool, args, trusted())).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    expect(fixture.client.files.info).toHaveBeenCalledTimes(2); expect(download.calls).toHaveLength(1); expect(vision.calls).toHaveLength(1);
    fixture.client.files.info.mockRejectedValue({ data: { error: 'missing_scope', token: 'RAW_SECRET' } });
    const missing = await execute(tool, args, trusted());
    expect(missing).toMatchObject({ error: { code: 'MISSING_SCOPE' } }); expect(JSON.stringify(missing)).not.toContain('RAW_SECRET');
  });
  it('reports provider image-unsupported error without text-only fallback or retries', async () => {
    const f = setup(pngFixture(), 'image/png', JSON.stringify({ error: { message: 'unsupported image, RAW_SECRET' } }));
    const result = await execute((await f.main.listTools()).slack_analyze_image, args, trusted());
    expect(result).toMatchObject({ ok: false, error: { code: 'VISION_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('RAW_SECRET'); expect(f.vision.calls).toHaveLength(1);
  });
  it.each(['\n', ' ', '\t'])('registered tool fails closed on PNG/JPEG base64 wrapped at 64 characters with %j', async separator => {
    for (const [bytes, mime] of [[pngFixture(), 'image/png'], [jpegFixture(), 'image/jpeg']] as const) {
      const encoded = bytes.toString('base64'); const wrapped = encoded.match(/.{1,64}/gu)!.join(separator);
      const f = setup(bytes, mime, visionResponse(`해석 대신 데이터:\n${wrapped}`));
      const result = await execute((await f.main.listTools()).slack_analyze_image, args, trusted());
      expect(result).toMatchObject({ ok: false, error: { code: 'VISION_FAILED' } });
      expect(result).not.toHaveProperty('interpretation');
      const safe = JSON.stringify([result, vi.mocked(logger.info).mock.calls, vi.mocked(logger.debug).mock.calls, vi.mocked(logToolCall).mock.calls]);
      expect(safe).not.toContain(encoded); expect(safe).not.toContain(wrapped); expect(safe).not.toContain('해석 대신 데이터');
      expect(f.vision.calls).toHaveLength(1);
    }
  });
  it.each(['download', 'vision'] as const)('propagates registry cancellation through registered %s HTTP and drains actual socket close', async phase => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let closed!: () => void; const socketClosed = new Promise<void>(resolve => { closed = resolve; });
    const server = http.createServer((req, res) => {
      req.socket.once('close', closed); req.resume(); req.once('end', () => {
        res.writeHead(200, { 'content-type': phase === 'download' ? 'image/png' : 'application/json' }); res.write(phase === 'download' ? 'partial' : '{'); entered();
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address() as { port: number };
    const f = setup();
    const socketDeps: DownloadDependencies = { resolve: f.download.resolve,
      request: ((_url: URL, options: https.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
        http.request({ ...options, host: '127.0.0.1', port: address.port, path: '/synthetic', lookup: undefined }, callback)) as unknown as typeof https.request };
    const main = createAgent({ slackClient: fixture.client as unknown as AttachmentSlackClient,
      attachmentDownloadDependencies: phase === 'download' ? socketDeps : f.download,
      imageVisionDependencies: phase === 'vision' ? socketDeps : f.vision });
    const tool = (await main.listTools()).slack_analyze_image; const scope = new ExecutionScope();
    try {
      const work = executionStorage.run(scope, () => execute(tool, args, trusted()));
      const assertion = expect(work).rejects.toMatchObject({ reason: 'cancelled' });
      await started; scope.control.cancel(); await assertion; await scope.drain(); await socketClosed;
      if (phase === 'download') expect(f.vision.calls).toHaveLength(0);
    } finally { scope.control.finish(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('honors the public tool context.abortSignal before live authorization or any I/O', async () => {
    const { main, download, vision } = setup(); const signal = AbortSignal.abort();
    await expect(execute((await main.listTools()).slack_analyze_image, args, trusted(), signal)).rejects.toBeDefined();
    expect(fixture.client.auth.test).not.toHaveBeenCalled(); expect(download.calls).toHaveLength(0); expect(vision.calls).toHaveLength(0);
  });
  it('actual file-only DM handler binds requester, redacts image tool DB/log/progress and response preview', async () => {
    const f = setup(); const tools = await f.main.listTools();
    fixture.client.conversations.info.mockResolvedValue({ ok: true, channel: { id: 'D1', is_im: true, user: 'U1' } });
    const callbacks = new Map<string, (delivery: unknown) => Promise<void>>();
    const app = { action: vi.fn(), event: (kind: string, callback: (delivery: unknown) => Promise<void>) => callbacks.set(kind, callback),
      client: { chat: { postMessage: vi.fn(async () => ({ ok: true, ts: 'control' })), update: vi.fn(async () => ({ ok: true })) } } } as unknown as App;
    const repository: ConversationRepository = { claim: vi.fn(async () => true), recent: vi.fn(async () => []), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const spy = vi.spyOn(f.main, 'stream').mockImplementation(async (messages: unknown, options: { requestContext?: RequestContext; abortSignal?: AbortSignal } = {}) => {
      expect(options.abortSignal).toBeDefined(); const serialized = JSON.stringify(messages);
      expect(serialized).toContain('slack_attachment_candidates'); expect(serialized).not.toContain('PRIVATE_URL_SECRET');
      const result = await execute(tools.slack_analyze_image, args, options.requestContext, options.abortSignal);
      expect(result).toMatchObject({ ok: true, source: { channelId: 'D1' } });
      const payload = { toolName: 'slack_analyze_image', toolCallId: 'image-1', args };
      return { fullStream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'tool-call', payload }); controller.enqueue({ type: 'tool-result', payload: { ...payload, result } }); controller.close();
      } }), text: Promise.resolve('DERIVED_IMAGE_SECRET'), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }), finishReason: Promise.resolve('stop'),
      steps: Promise.resolve([{ text: '', toolCalls: [{ payload }], toolResults: [{ payload: { ...payload, result } }] }]) } as never;
    });
    try {
      registerHandlers(app, f.main, repository);
      await callbacks.get('message')!({ event: { channel: 'D1', channel_type: 'im', user: 'U1', ts: args.messageTs,
        files: [{ id: 'F123', name: 'image.png', mimetype: 'image/png', size: pngFixture().length, url_private_download: 'PRIVATE_URL_SECRET' }] },
        body: { team_id: 'T1', event_id: 'image-dm-1' }, context: { botUserId: 'UBOT' } });
      expect(repository.complete).toHaveBeenCalledOnce(); expect(fixture.client.conversations.members).not.toHaveBeenCalled();
      expect(logToolCall).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: 'slack_analyze_image', input: { redacted: true }, output: { redacted: true } }));
      const logs = JSON.stringify([vi.mocked(logger.info).mock.calls, vi.mocked(logger.debug).mock.calls, vi.mocked(logToolCall).mock.calls, vi.mocked(appendTaskUpdate).mock.calls]);
      for (const secret of ['DERIVED_IMAGE_SECRET', 'PRIVATE_IMAGE_QUERY', 'PRIVATE_URL_SECRET', pngFixture().toString('base64'), fixture.settings.SLACK_BOT_TOKEN, fixture.settings.LLM_API_KEY]) expect(logs).not.toContain(secret);
      expect(appendTaskUpdate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'complete', output: expect.stringContaining('파생 해석') }));
    } finally { spy.mockRestore(); }
  });
});
