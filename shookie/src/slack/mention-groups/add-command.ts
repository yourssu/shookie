import type { App } from "@slack/bolt";
import { logger } from "../../logger.js";
import {
  parseAddMentionGroupCommand,
  type AddMentionGroupCommand,
} from "./command-parser.js";
import {
  RadarMentionGroupCommandError,
  type CreatedMentionGroup,
  type RadarMentionGroupCommandClient,
} from "./command-client.js";

interface AddCommandPayload {
  text?: string;
  user_id?: string;
  team_id?: string;
}

export interface AddMentionGroupCommandResponder {
  respond(response: { response_type: "ephemeral"; text: string }): Promise<unknown>;
}

export async function handleAddMentionGroupCommand(
  payload: AddCommandPayload,
  client: Pick<RadarMentionGroupCommandClient, "create">,
  responder: AddMentionGroupCommandResponder,
): Promise<void> {
  const parsed = parseAddMentionGroupCommand(payload.text ?? "");
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
    const created = await client.create(parsed.command, payload.user_id, requestId(payload.team_id));
    await responder.respond({
      response_type: "ephemeral",
      text: formatSuccess(created),
    });
  } catch (error) {
    logger.warn("Slack /group 처리 실패", {
      teamId: payload.team_id,
      userId: payload.user_id,
      error: error instanceof RadarMentionGroupCommandError ? error.code : errorName(error),
    });
    await responder.respond({ response_type: "ephemeral", text: formatFailure(error) });
  }
}

export function registerAddMentionGroupCommand(
  app: App,
  client: Pick<RadarMentionGroupCommandClient, "create">,
): void {
  app.command("/group", async ({ command, ack, respond }) => {
    await ack();
    await handleAddMentionGroupCommand(command, client, {
      respond: (response) => respond(response),
    });
  });
}

function formatSuccess(group: CreatedMentionGroup): string {
  return `✅ *${group.displayName}* 그룹을 만들었습니다.\n` +
    `핸들: \`@${group.handle}\` · 멤버: ${group.memberUserIds.length}명 · revision: ${group.revision}`;
}

function formatFailure(error: unknown): string {
  if (error instanceof RadarMentionGroupCommandError) {
    switch (error.code) {
      case "MENTION_GROUP_HANDLE_CONFLICT":
      case "MENTION_GROUP_HANDLE_DUPLICATE":
        return "이미 사용 중인 핸들입니다. 다른 핸들로 다시 시도해 주세요.";
      case "MENTION_GROUP_MEMBER_CONFLICT":
        return "멤버 중 Radar에 등록되지 않았거나 사용할 수 없는 Slack 계정이 있습니다.";
      case "MENTION_GROUP_HANDLE_INVALID":
      case "MENTION_GROUP_HANDLE_RESERVED":
        return "사용할 수 없는 핸들입니다. 영문 소문자 핸들을 사용해 주세요.";
      case "MENTION_GROUP_INTERNAL_AUTH_REQUIRED":
        return "Radar 연동 인증이 준비되지 않았습니다. 관리자에게 알려 주세요.";
      default:
        return "멘션 그룹을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
  }
  return "멘션 그룹을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function requestId(teamId: string): string {
  return `shookie-add-group-${teamId}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
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
