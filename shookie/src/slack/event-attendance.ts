import type { App } from "@slack/bolt";
import { logger } from "../logger.js";

type SlackEventReactionKind = "attending" | "absent" | "afterparty";
type SlackEventReactionAction = "added" | "removed";

const TEAM_ID_PATTERN = /^T[A-Z0-9]{2,}$/u;
const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{2,}$/u;
const USER_ID_PATTERN = /^[UW][A-Z0-9]{2,20}$/u;
const TIMESTAMP_PATTERN = /^\d{1,10}\.\d{1,6}$/u;

export interface SlackEventAttendanceConfig {
  apiUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
  reactionKinds: Record<string, SlackEventReactionKind>;
}

interface ReactionEnvelope {
  team_id?: unknown;
  event_id?: unknown;
  authorizations?: Array<{ team_id?: unknown }>;
}

function getTeamId(body: ReactionEnvelope): string | null {
  const teamId = typeof body.team_id === "string"
    ? body.team_id
    : body.authorizations?.find((authorization) => typeof authorization.team_id === "string")?.team_id;
  return typeof teamId === "string" && TEAM_ID_PATTERN.test(teamId) ? teamId : null;
}

export function registerEventAttendanceSlackSync(
  app: App,
  config: SlackEventAttendanceConfig,
): void {
  const handleReaction = async (
    body: ReactionEnvelope,
    event: {
      user: string;
      reaction: string;
      event_ts: string;
      item: { type: string; channel?: string; ts?: string };
    },
    action: SlackEventReactionAction,
  ) => {
    if (event.item.type !== "message") return;
    const channelId = event.item.channel;
    const messageTs = event.item.ts;
    const reactionKind = config.reactionKinds[event.reaction];
    const teamId = getTeamId(body);
    if (
      !teamId ||
      !channelId ||
      !CHANNEL_ID_PATTERN.test(channelId) ||
      !messageTs ||
      !TIMESTAMP_PATTERN.test(messageTs) ||
      !USER_ID_PATTERN.test(event.user) ||
      !reactionKind ||
      !TIMESTAMP_PATTERN.test(event.event_ts)
    ) {
      return;
    }

    const slackEventId = typeof body.event_id === "string" && body.event_id.length <= 255
      ? body.event_id
      : `${action}:${event.event_ts}:${channelId}:${messageTs}:${event.user}:${event.reaction}`;

    const payload = {
      teamId,
      slackEventId,
      channelId,
      messageTs,
      slackUserId: event.user,
      reactionName: event.reaction,
      reactionKind,
      action,
      eventTs: event.event_ts,
    };
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        const response = await fetch(config.apiUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Radar-Internal-Key": config.apiKey,
            "X-Request-Id": slackEventId,
          },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: controller.signal,
        });
        if (response.ok) {
          await response.body?.cancel();
          return;
        }
        await response.body?.cancel();
        const error = new Error("Radar returned HTTP " + response.status);
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 1) {
          throw error;
        }
        lastError = error;
      } catch (error) {
        const httpStatus = error instanceof Error
          ? Number(error.message.match(/^Radar returned HTTP (\d+)$/u)?.[1])
          : Number.NaN;
        const isRetryableHttpError = httpStatus === 429 || httpStatus >= 500;
        const isNonRetryableHttpError = Number.isFinite(httpStatus) && !isRetryableHttpError;
        if (isNonRetryableHttpError || attempt === 1) {
          logger.error("행사 참석 반응을 Radar로 전송하지 못했습니다", {
            action,
            reactionKind,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    logger.error("행사 참석 반응을 Radar로 전송하지 못했습니다", {
      action,
      reactionKind,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
  };

  app.event("reaction_added", async ({ body, event }) => {
    await handleReaction(body, event, "added");
  });
  app.event("reaction_removed", async ({ body, event }) => {
    await handleReaction(body, event, "removed");
  });
}
