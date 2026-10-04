import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { ATTACHMENT_LIMITS as L, AttachmentError, attachmentKind, type AuthorizedAttachment } from './policy.js';

export type AttachmentSlackClient = Pick<WebClient, 'auth' | 'conversations' | 'files'>;
// Structural DI contracts mirror the approved predecessor API. No shared imports before merge.
export type AttachmentScope = Readonly<{ identity: Readonly<{ userId: string; teamId: string; channel: string; requestId: string }>;
  channelId: string; kind: 'public_channel' | 'private_channel' | 'im'; workspaceHost?: string }>;
export type AttachmentMessage = Readonly<{ channelId: string; messageTs: string; threadTs?: string; fileIds: readonly string[] }>;
export type AttachmentAuthorizationDependencies = {
  client: AttachmentSlackClient;
  authorizeCurrentSlackChannel: (client: AttachmentSlackClient, requestContext: object | undefined,
    target?: { channelId?: string; workspaceHost?: string }) => Promise<AttachmentScope>;
  readAuthorizedSlackMessage: (client: AttachmentSlackClient, requestContext: object | undefined,
    target: { messageTs: string; threadTs?: string; channelId?: string }) => Promise<AttachmentMessage>;
};
const fileSchema = z.object({ id: z.string().regex(/^F[A-Z0-9]+$/u).max(64), name: z.string().max(4096),
  mimetype: z.string().max(200), size: z.number().int().min(0), url_private_download: z.string().max(4096),
  is_external: z.boolean().optional(), mode: z.string().optional() });
const validTs = (ts: string) => /^\d+\.\d{1,6}$/u.test(ts) && ts.length <= 32;
function checked(response: { ok?: boolean; error?: string; warning?: string; response_metadata?: { warnings?: string[] } }) {
  if (response.error === 'missing_scope') throw new AttachmentError('MISSING_SCOPE');
  if (!response.ok || response.error) throw safeError({ data: { error: response.error } });
  if (response.warning || response.response_metadata?.warnings?.length) throw new AttachmentError('ACCESS_DENIED');
}
function safeError(error: unknown): AttachmentError {
  if (error instanceof AttachmentError) return error;
  const safe = error as { status?: unknown; statusCode?: unknown; code?: unknown; retryAfter?: unknown;
    result?: { status?: unknown; retryAfterSeconds?: unknown }; data?: { error?: unknown } } | null;
  if (safe?.status === 'rate_limited' || safe?.result?.status === 'rate_limited' || safe?.statusCode === 429 ||
      safe?.code === 'slack_webapi_rate_limited_error' || ['ratelimited', 'rate_limited'].includes(String(safe?.data?.error))) {
    const retry = safe?.result?.retryAfterSeconds ?? safe?.retryAfter;
    return new AttachmentError('RATE_LIMIT', typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? Math.min(3600, retry) : undefined);
  }
  return new AttachmentError(safe?.data?.error === 'missing_scope' ? 'MISSING_SCOPE' : 'ACCESS_DENIED');
}
/** Exact live current-channel attachment relation first; files.info alone NEVER grants access. */
export async function authorizeSlackAttachment(
  deps: AttachmentAuthorizationDependencies, requestContext: object | undefined,
  args: { fileId: string; messageTs: string; threadTs?: string },
): Promise<AuthorizedAttachment> {
  try {
    if (!/^F[A-Z0-9]{2,}$/u.test(args.fileId) || args.fileId.length > 64 || !validTs(args.messageTs) ||
        (args.threadTs !== undefined && !validTs(args.threadTs))) throw new AttachmentError('ACCESS_DENIED');
    // Predecessor performs fresh WeakMap identity + auth/team/current-channel/membership checks
    // and exact history/replies lookup. No query fallback, scanning or identity reconstruction here.
    const message = await deps.readAuthorizedSlackMessage(deps.client, requestContext, {
      messageTs: args.messageTs, ...(args.threadTs ? { threadTs: args.threadTs } : {}),
    });
    if (!message.channelId || message.messageTs !== args.messageTs || !message.fileIds.includes(args.fileId) ||
        (args.threadTs && message.threadTs !== args.threadTs) ||
        (!args.threadTs && message.threadTs && message.threadTs !== args.messageTs)) throw new AttachmentError('ACCESS_DENIED');
    // Membership is revalidated immediately before files.info, using the exact authorized channel.
    const scope = await deps.authorizeCurrentSlackChannel(deps.client, requestContext, { channelId: message.channelId });
    if (scope.channelId !== message.channelId || scope.identity.channel !== message.channelId ||
        !scope.identity.userId || !scope.identity.teamId || !scope.identity.requestId) throw new AttachmentError('ACCESS_DENIED');
    const info = await deps.client.files.info({ file: args.fileId });
    checked(info);
    const parsed = fileSchema.safeParse(info.file);
    if (!parsed.success || parsed.data.id !== args.fileId || parsed.data.is_external ||
        (parsed.data.mode && parsed.data.mode !== 'hosted')) throw new AttachmentError('ACCESS_DENIED');
    const file = parsed.data;
    if (file.size > L.fileBytes) throw new AttachmentError('FILE_LIMIT');
    attachmentKind(file.mimetype);
    // Last await before hardened download. Scope return values are NOT cached reusable grants.
    const current = await deps.authorizeCurrentSlackChannel(deps.client, requestContext, { channelId: message.channelId });
    if (current.channelId !== scope.channelId || current.identity.channel !== scope.identity.channel ||
        current.identity.userId !== scope.identity.userId || current.identity.teamId !== scope.identity.teamId ||
        current.identity.requestId !== scope.identity.requestId || current.kind !== scope.kind) throw new AttachmentError('ACCESS_DENIED');
    return { file, channelId: scope.channelId, messageTs: args.messageTs };
  } catch (error) { throw safeError(error); }
}
