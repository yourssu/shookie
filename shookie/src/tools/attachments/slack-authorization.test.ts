import { describe, expect, it, vi } from 'vitest';
import { AttachmentError } from './policy.js';
import { authorizeSlackAttachment, type AttachmentAuthorizationDependencies, type AttachmentSlackClient,
  type AttachmentScope } from './slack-authorization.js';
const args = { fileId: 'F123', messageTs: '123.000002' };
const context = {};
const scope: AttachmentScope = { channelId: 'C123', requesterId: 'U123', teamId: 'T123', requestId: 'request-1', kind: 'channel' };
function fixture() {
  const history = vi.fn().mockResolvedValue({ ok: true, messages: [{ ts: args.messageTs, files: [{ id: args.fileId }] }] });
  const replies = vi.fn().mockResolvedValue({ ok: true, messages: [
    { ts: '123.000001' }, { ts: args.messageTs, thread_ts: '123.000001', files: [{ id: args.fileId }] }] });
  const info = vi.fn().mockResolvedValue({ ok: true, file: { id: args.fileId, name: 'sample.txt', mimetype: 'text/plain',
    size: 5, url_private_download: 'https://files.slack.com/files-pri/T123-F123/sample.txt', mode: 'hosted' } });
  const verifyScope = vi.fn().mockImplementation(async (_client, ctx) => {
    // Test-only scope capability: getters or model-like fields cannot bind identity.
    if (ctx !== context) throw new AttachmentError('ACCESS_DENIED');
    return scope;
  });
  const deps: AttachmentAuthorizationDependencies = { client: { conversations: { history, replies }, files: { info } } as unknown as AttachmentSlackClient, verifyScope };
  return { deps, history, replies, info, verifyScope };
}
describe('attachment live relation bridge using injected trusted current-channel verifier', () => {
  it('fetches exact current-channel message, verifies file relation, files.info, and rechecks scope before download', async () => {
    const f = fixture(); const result = await authorizeSlackAttachment(f.deps, context, args);
    expect(result).toMatchObject({ channelId: 'C123', messageTs: args.messageTs, file: { id: args.fileId } });
    expect(f.history).toHaveBeenCalledWith({ channel: 'C123', oldest: args.messageTs, latest: args.messageTs, inclusive: true, limit: 2 });
    expect(f.info).toHaveBeenCalledWith({ file: args.fileId });
    expect(f.verifyScope).toHaveBeenCalledTimes(3);
    const order = [f.verifyScope.mock.invocationCallOrder[0], f.history.mock.invocationCallOrder[0],
      f.verifyScope.mock.invocationCallOrder[1], f.info.mock.invocationCallOrder[0], f.verifyScope.mock.invocationCallOrder[2]];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it('supports exact thread reply relation without authorizing the root attachment instead', async () => {
    const f = fixture();
    await authorizeSlackAttachment(f.deps, context, { ...args, threadTs: '123.000001' });
    expect(f.replies).toHaveBeenCalledWith({ channel: 'C123', ts: '123.000001', oldest: args.messageTs,
      latest: args.messageTs, inclusive: true, limit: 2 });
    expect(f.history).not.toHaveBeenCalled();
    f.replies.mockResolvedValue({ ok: true, messages: [
      { ts: '123.000001', files: [{ id: args.fileId }] }, { ts: args.messageTs, thread_ts: '123.000001' }] });
    f.info.mockClear();
    await expect(authorizeSlackAttachment(f.deps, context, { ...args, threadTs: '123.000001' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.info).not.toHaveBeenCalled();
  });
  it('rejects arbitrary bot-readable file, missing relation, nearby/deleted/partial message before files.info', async () => {
    for (const response of [
      { ok: true, messages: [{ ts: args.messageTs, files: [{ id: 'FOTHER' }] }] },
      { ok: true, messages: [{ ts: '123.000003', files: [{ id: args.fileId }] }] },
      { ok: true, messages: [{ ts: args.messageTs, subtype: 'message_deleted', files: [{ id: args.fileId }] }] },
      { ok: true, messages: [{ ts: args.messageTs, files: [{ id: args.fileId }] }], has_more: true },
      { ok: true, messages: [{ ts: args.messageTs, files: [{ id: args.fileId }] }], response_metadata: { next_cursor: 'next' } },
    ]) {
      const f = fixture(); f.history.mockResolvedValue(response);
      await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      expect(f.info).not.toHaveBeenCalled();
    }
  });
  it('does not trust caller identity getters or alternate-channel metadata (injected scope is authoritative)', async () => {
    const f = fixture();
    await expect(authorizeSlackAttachment(f.deps, { get: () => scope, ...scope }, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.history).not.toHaveBeenCalled(); expect(f.info).not.toHaveBeenCalled();
    f.history.mockResolvedValue({ ok: true, messages: [{ ts: args.messageTs }] });
    // files.info shares/public/channels would not repair the missing live relation.
    f.info.mockResolvedValue({ ok: true, file: { id: args.fileId, channels: ['COTHER'], shares: { private: { COTHER: [{ ts: args.messageTs }] } } } });
    await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.info).not.toHaveBeenCalled();
  });
  it('fails if live scope is revoked or changes before info or download', async () => {
    for (const phase of [2, 3]) {
      const f = fixture(); let calls = 0;
      f.verifyScope.mockImplementation(async () => {
        if (++calls === phase) throw new AttachmentError('ACCESS_DENIED'); return scope;
      });
      await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      expect(f.info).toHaveBeenCalledTimes(phase === 2 ? 0 : 1);
    }
    const f = fixture(); f.verifyScope.mockResolvedValueOnce(scope).mockResolvedValue({ ...scope, channelId: 'COTHER' });
    await expect(authorizeSlackAttachment(f.deps, context, args)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(f.info).not.toHaveBeenCalled();
  });
  it('sanitizes missing-scope and raw errors and rejects mismatched or external file metadata', async () => {
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
});
