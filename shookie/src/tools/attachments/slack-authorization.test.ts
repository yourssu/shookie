import { describe, expect, it, vi } from 'vitest';
import { AttachmentError, failure } from './policy.js';
import { authorizeSlackAttachment, type AttachmentAuthorizationDependencies, type AttachmentSlackClient,
  type AttachmentScope } from './slack-authorization.js';
const args = { fileId: 'F123', messageTs: '123.000002' };
const context = {};
const scope: AttachmentScope = { channelId: 'C123', kind: 'private_channel',
  identity: { userId: 'U123', teamId: 'T123', channel: 'C123', requestId: 'request-1' } };
function fixture() {
  const readMessage = vi.fn().mockImplementation(async (_client, ctx, target) => {
    // Test-only trusted capability; getters/model-like fields cannot bind identity.
    if (ctx !== context) throw new AttachmentError('ACCESS_DENIED');
    return { channelId: 'C123', messageTs: target.messageTs, ...(target.threadTs ? { threadTs: target.threadTs } : {}), fileIds: [args.fileId] };
  });
  const info = vi.fn().mockResolvedValue({ ok: true, file: { id: args.fileId, name: 'sample.txt', mimetype: 'text/plain',
    size: 5, url_private_download: 'https://files.slack.com/files-pri/T123-F123/sample.txt', mode: 'hosted' } });
  const authorizeChannel = vi.fn().mockImplementation(async (_client, ctx, target) => {
    if (ctx !== context || target.channelId !== scope.channelId) throw new AttachmentError('ACCESS_DENIED'); return scope;
  });
  const deps: AttachmentAuthorizationDependencies = { client: { files: { info } } as unknown as AttachmentSlackClient,
    authorizeCurrentSlackChannel: authorizeChannel, readAuthorizedSlackMessage: readMessage };
  return { deps, readMessage, info, authorizeChannel };
}
describe('attachment DI bridge matching approved predecessor live authorization API', () => {
  it('checks exact message capability/file inclusion, rechecks channel, files.info, and scope before download', async () => {
    const f = fixture(); const result = await authorizeSlackAttachment(f.deps, context, args);
    expect(result).toMatchObject({ channelId: 'C123', messageTs: args.messageTs, file: { id: args.fileId } });
    expect(f.readMessage).toHaveBeenCalledWith(f.deps.client, context, { messageTs: args.messageTs });
    expect(f.info).toHaveBeenCalledWith({ file: args.fileId });
    expect(f.authorizeChannel).toHaveBeenCalledTimes(2);
    expect(f.authorizeChannel).toHaveBeenCalledWith(f.deps.client, context, { channelId: 'C123' });
    const order = [f.readMessage.mock.invocationCallOrder[0], f.authorizeChannel.mock.invocationCallOrder[0],
      f.info.mock.invocationCallOrder[0], f.authorizeChannel.mock.invocationCallOrder[1]];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it('forwards explicit parent threadTs without scanning; mismatched reply provenance is rejected', async () => {
    const f = fixture();
    await authorizeSlackAttachment(f.deps, context, { ...args, threadTs: '123.000001' });
    expect(f.readMessage).toHaveBeenCalledWith(f.deps.client, context, { messageTs: args.messageTs, threadTs: '123.000001' });
    f.readMessage.mockResolvedValue({ channelId: 'C123', messageTs: args.messageTs, threadTs: '123.000009', fileIds: [args.fileId] });
    f.info.mockClear();
    await expect(authorizeSlackAttachment(f.deps, context, { ...args, threadTs: '123.000001' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.info).not.toHaveBeenCalled();
  });
  it('rejects arbitrary bot-readable file, parent/nearby-message relation and unknown reply parent before files.info', async () => {
    for (const message of [
      { channelId: 'C123', messageTs: args.messageTs, fileIds: ['FOTHER'] },
      { channelId: 'C123', messageTs: '123.000001', fileIds: [args.fileId] },
      { channelId: 'C123', messageTs: args.messageTs, threadTs: '123.000001', fileIds: [args.fileId] },
    ]) {
      const f = fixture(); f.readMessage.mockResolvedValue(message);
      await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      expect(f.info).not.toHaveBeenCalled();
    }
  });
  it('does not trust caller identity getters, metadata shares or alternate-channel message projection', async () => {
    const f = fixture();
    await expect(authorizeSlackAttachment(f.deps, { get: () => scope, ...scope }, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.info).not.toHaveBeenCalled();
    f.readMessage.mockResolvedValue({ channelId: 'COTHER', messageTs: args.messageTs, fileIds: [args.fileId] });
    await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.info).not.toHaveBeenCalled();
    f.readMessage.mockResolvedValue({ channelId: 'C123', messageTs: args.messageTs, fileIds: [] });
    f.info.mockResolvedValue({ ok: true, file: { id: args.fileId, channels: ['C123'], shares: { private: { C123: [{ ts: args.messageTs }] } } } });
    await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.info).not.toHaveBeenCalled();
  });
  it('fails when predecessor denies deleted/partial message or live scope is revoked before info/download', async () => {
    const denied = fixture(); denied.readMessage.mockRejectedValue({ status: 'invalid_target', message: 'sanitized predecessor failure' });
    await expect(authorizeSlackAttachment(denied.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(denied.info).not.toHaveBeenCalled();
    for (const phase of [1, 2]) {
      const f = fixture(); let calls = 0;
      f.authorizeChannel.mockImplementation(async () => {
        if (++calls === phase) throw new AttachmentError('ACCESS_DENIED'); return scope;
      });
      await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      expect(f.info).toHaveBeenCalledTimes(phase === 1 ? 0 : 1);
    }
    const changed = fixture(); changed.authorizeChannel.mockResolvedValueOnce(scope).mockResolvedValue({ ...scope, identity: { ...scope.identity, userId: 'UOTHER' } });
    await expect(authorizeSlackAttachment(changed.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
  it('sanitizes missing-scope and raw errors and rejects mismatched/external metadata', async () => {
    for (const file of [{ id: 'FOTHER' }, { id: args.fileId, is_external: true }, { id: args.fileId, mode: 'external' }]) {
      const f = fixture(); const baseline = (await f.info()).file;
      f.info.mockResolvedValue({ ok: true, file: { ...baseline, ...file } });
      await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    }
    const f = fixture(); f.info.mockRejectedValue({ data: { error: 'missing_scope', token: 'do-not-return' } });
    await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'MISSING_SCOPE', message: 'MISSING_SCOPE' });
    f.info.mockRejectedValue(new Error('raw private response do-not-return'));
    await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED', message: 'ACCESS_DENIED' });
  });
  it('preserves sanitized rate-limit classification/retry hint without forwarding error bodies', async () => {
    const f = fixture(); f.readMessage.mockRejectedValue({ status: 'rate_limited', message: 'do-not-return',
      result: { status: 'rate_limited', retryAfterSeconds: 30, messages: ['do-not-return'] } });
    const error = await authorizeSlackAttachment(f.deps, context, args).catch(e => e);
    expect(failure(error)).toMatchObject({ ok: false, error: { code: 'RATE_LIMIT', retryAfterSeconds: 30 } });
    expect(JSON.stringify(failure(error))).not.toContain('do-not-return'); expect(f.info).not.toHaveBeenCalled();
  });
});
