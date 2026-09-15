import type { App } from "@slack/bolt";
import { logger } from "../../logger.js";
import {
  parseUngroupMentionGroupCommand,
  type UngroupMentionGroupCommand,
} from "./command-parser.js";
import {
  RadarMentionGroupCommandError,
  type DeletedMentionGroup,
  type RadarMentionGroupCommandClient,
} from "./command-client.js";

interface UngroupCommandPayload {
  text?: string;
  user_id?: string;
  team_id?: string;
}

export interface UngroupMentionGroupCommandResponder {
  respond(response: { response_type: "ephemeral"; text: string }): Promise<unknown>;
}

export async function handleUngroupMentionGroupCommand(
  payload: UngroupCommandPayload,
  client: Pick<RadarMentionGroupCommandClient, "deactivate">,
  responder: UngroupMentionGroupCommandResponder,
): Promise<void> {
  const parsed = parseUngroupMentionGroupCommand(payload.text ?? "");
  if (!parsed.ok) {
    await responder.respond({ response_type: "ephemeral", text: parsed.message });
    return;
  }

  if (!isSlackUserId(payload.user_id) || !isSlackTeamId(payload.team_id)) {
    await responder.respond({
      response_type: "ephemeral",
      text: "Slack 사용자 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    });
    return;
  }

  try {
    const deleted = await client.deactivate(
      parsed.command,
      payload.user_id,
      requestId(payload.team_id),
    );
    await responder.respond({
      response_type: "ephemeral",
      text: formatSuccess(deleted),
    });
  } catch (error) {
    logger.warn("Slack /ungroup 처리 실패", {
      teamId: payload.team_id,
      userId: payload.user_id,
      error: error instanceof RadarMentionGroupCommandError ? error.code : errorName(error),
    });
    await responder.respond({ response_type: "ephemeral", text: formatFailure(error) });
  }
}

export function registerUngroupMentionGroupCommand(
  app: App,
  client: Pick<RadarMentionGroupCommandClient, "deactivate">,
): void {
  app.command("/ungroup", async ({ command, ack, respond }) => {
    await ack();
    await handleUngroupMentionGroupCommand(command, client, {
      respond: (response) => respond(response),
    });
  });
}

function formatSuccess(group: DeletedMentionGroup): string {
  return `✅ *${group.displayName}* 그룹을 삭제했습니다.\n` +
    `핸들: \`@${group.handle}\` · 현재 비활성 상태 · revision: ${group.revision}`;
}

function formatFailure(error: unknown): string {
  if (error instanceof RadarMentionGroupCommandError) {
    switch (error.code) {
      case "MENTION_GROUP_NOT_FOUND":
        return "해당 핸들의 멘션 그룹을 찾지 못했습니다.";
      case "MENTION_GROUP_INTERNAL_AUTH_REQUIRED":
        return "Radar 연동 인증이 준비되지 않았습니다. 관리자에게 알려 주세요.";
      default:
        return "멘션 그룹을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
  }
  return "멘션 그룹을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function requestId(teamId: string): string {
  return `shookie-ungroup-${teamId}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
}

function isSlackUserId(value: unknown): value is string {
  return typeof value === "string" && /^U[A-Z0-9]{2,20}$/u.test(value);
}

function isSlackTeamId(value: unknown): value is string {
  return typeof value === "string" && /^T[A-Z0-9]{2,}$/u.test(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown_error";
}
