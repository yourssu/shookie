import { z } from "zod";

export const channelId = z.string().regex(/^[CGD][A-Z0-9]{1,63}$/);
export const slackTs = z.string().regex(/^[0-9]{1,16}\.[0-9]{6}$/);
export const channelInput = z.object({
  channel: channelId.optional().describe("생략하면 현재 요청 채널. 다른 채널은 허용하지 않습니다."),
  cursor: z.string().min(1).max(128).optional().describe("이 도구가 반환한 불투명 nextCursor만 사용"),
}).strict();
export const threadInput = channelInput.extend({
  ts: slackTs.optional().describe("부모 메시지 ts (소수점 이하 정확히 6자리)"),
  url: z.string().max(512).optional().describe("현재 workspace Slack 메시지 permalink; HTTP 요청하지 않음"),
}).strict();
export const searchInput = z.object({
  query: z.string().trim().min(1).max(500),
  channel: channelId.optional(),
}).strict();

export const readOutput = z.object({
  status: z.enum(["ok", "invalid_target", "access_denied", "unsupported", "rate_limited", "unavailable"]),
  message: z.string(),
  source: z.object({ channel: z.string(), threadTs: z.string().optional() }).optional(),
  messages: z.array(z.object({
    channel: z.string(), ts: z.string(), threadTs: z.string().optional(),
    author: z.object({ userId: z.string().nullable(), botId: z.string().nullable(), kind: z.enum(["participant", "bot", "system"]) }),
    text: z.string(), textTruncated: z.boolean(), replyCount: z.number().int().nonnegative().optional(),
  })),
  page: z.number().int(), nextCursor: z.string().nullable(),
  complete: z.boolean(), truncated: z.boolean(),
  retryAfterSeconds: z.number().optional(),
  limits: z.object({ pageSize: z.number(), maxPages: z.number(), maxPageBytes: z.number() }),
});
export type ReadResult = z.infer<typeof readOutput>;
