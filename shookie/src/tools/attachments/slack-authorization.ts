import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { ATTACHMENT_LIMITS as L, AttachmentError, attachmentKind, type AuthorizedAttachment } from './policy.js';

export type AttachmentSlackClient = Pick<WebClient, 'auth' | 'conversations' | 'files'>;
export type AttachmentScope = Readonly<{ channelId: string; requesterId: string; teamId: string;
  requestId: string; kind: 'channel' | 'im' }>;
// Integration supplies verifyCurrentSlackChannelAccess from the merged trusted Slack bridge.
// No Slack identity is reconstructed from RequestContext getters, input, text or metadata here.
export type AttachmentScopeVerifier = (client: AttachmentSlackClient, requestContext: object | undefined) => Promise<AttachmentScope>;
export type AttachmentAuthorizationDependencies = { client: AttachmentSlackClient; verifyScope: AttachmentScopeVerifier };
const fileSchema = z.object({ id: z.string().regex(/^F[A-Z0-9]+$/u).max(64), name: z.string().max(4096),
  mimetype: z.string().max(200), size: z.number().int().min(0), url_private_download: z.string().max(4096),
  is_external: z.boolean().optional(), mode: z.string().optional() });
const validTs = (ts: string) => /^\d+\.\d{1,6}$/u.test(ts) && ts.length <= 32;
function checked(response: { ok?: boolean; error?: string; warning?: string; response_metadata?: { warnings?: string[] } }) {
  if (response.error === 'missing_scope') throw new AttachmentError('MISSING_SCOPE');
  if (!response.ok || response.error || response.warning || response.response_metadata?.warnings?.length)
    throw new AttachmentError('ACCESS_DENIED');
}
function safeError(error: unknown): AttachmentError {
  if (error instanceof AttachmentError) return error;
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  return new AttachmentError(data?.error === 'missing_scope' ? 'MISSING_SCOPE' : 'ACCESS_DENIED');
}
/** Exact live current-channel attachment relation first; files.info alone NEVER grants access. */
export async function authorizeSlackAttachment(
  deps: AttachmentAuthorizationDependencies, requestContext: object | undefined,
  args: { fileId: string; messageTs: string; threadTs?: string },
): Promise<AuthorizedAttachment> {
  try {
    if (!/^F[A-Z0-9]{2,}$/u.test(args.fileId) || args.fileId.length > 64 || !validTs(args.messageTs) ||
        (args.threadTs !== undefined && !validTs(args.threadTs))) throw new AttachmentError('ACCESS_DENIED');
    const scope = await deps.verifyScope(deps.client, requestContext);
    if (!scope.channelId || !scope.requesterId || !scope.teamId || !scope.requestId) throw new AttachmentError('ACCESS_DENIED');
    const recheck = async () => {
      const current = await deps.verifyScope(deps.client, requestContext);
      if (current.channelId !== scope.channelId || current.requesterId !== scope.requesterId ||
          current.teamId !== scope.teamId || current.requestId !== scope.requestId || current.kind !== scope.kind)
        throw new AttachmentError('ACCESS_DENIED');
    };
    // Inclusive exact timestamp bounds prevent fallback to nearby messages or a different channel.
    const response = args.threadTs && args.threadTs !== args.messageTs
      ? await deps.client.conversations.replies({ channel: scope.channelId, ts: args.threadTs,
          oldest: args.messageTs, latest: args.messageTs, inclusive: true, limit: 2 })
      : await deps.client.conversations.history({ channel: scope.channelId, oldest: args.messageTs,
          latest: args.messageTs, inclusive: true, limit: 2 });
    checked(response);
    if (response.has_more || response.response_metadata?.next_cursor?.trim()) throw new AttachmentError('ACCESS_DENIED');
    // Slack replies may also return the root. Only the exact requested live message is eligible.
    const exact = response.messages?.filter(message => message.ts === args.messageTs) ?? [];
    if (exact.length !== 1) throw new AttachmentError('ACCESS_DENIED');
    const message = exact[0] as typeof exact[number] & { subtype?: string };
    if (message.subtype === 'tombstone' || message.subtype === 'message_deleted' ||
        (args.threadTs && args.threadTs !== args.messageTs && message.thread_ts !== args.threadTs) ||
        !message.files?.some(file => file.id === args.fileId)) throw new AttachmentError('ACCESS_DENIED');
    await recheck(); // Live membership immediately before authenticated metadata retrieval.
    const info = await deps.client.files.info({ file: args.fileId });
    checked(info);
    const parsed = fileSchema.safeParse(info.file);
    if (!parsed.success || parsed.data.id !== args.fileId || parsed.data.is_external ||
        (parsed.data.mode && parsed.data.mode !== 'hosted')) throw new AttachmentError('ACCESS_DENIED');
    const file = parsed.data;
    if (file.size > L.fileBytes) throw new AttachmentError('FILE_LIMIT');
    attachmentKind(file.mimetype);
    await recheck(); // Last await before the caller's hardened download; no retained grant/cache.
    return { file, channelId: scope.channelId, messageTs: args.messageTs };
  } catch (error) { throw safeError(error); }
}
