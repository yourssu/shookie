const HANDLE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/u;
const SLACK_MENTION_PATTERN = /^<@([UW][A-Z0-9]{2,20})(?:\|[^>]+)?>$/u;

export interface AddMentionGroupCommand {
  handle: string;
  displayName: string;
  memberUserIds: string[];
}

export type AddMentionGroupCommandParseResult =
  | { ok: true; command: AddMentionGroupCommand }
  | { ok: false; message: string };

export const ADD_MENTION_GROUP_USAGE =
  "사용법: `/group <핸들> <@멤버> [@멤버 ...]`\n예: `/group backend <@U0123456789> <@U9876543210>`";

/**
 * Slack slash command text is passed as one string. Mentions arrive as
 * `<@U...>` (optionally with a display-name suffix), so only those tokens are
 * accepted as members and arbitrary text cannot become a group member.
 */
export function parseAddMentionGroupCommand(text: string): AddMentionGroupCommandParseResult {
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, message: `그룹 생성 명령이 아닙니다.\n${ADD_MENTION_GROUP_USAGE}` };
  }

  const handle = tokens[0]?.toLowerCase();
  if (!handle || !HANDLE_PATTERN.test(handle)) {
    return {
      ok: false,
      message: `핸들은 영문 소문자로 시작하는 2~32자의 값이어야 합니다.\n${ADD_MENTION_GROUP_USAGE}`,
    };
  }
  if (tokens.length < 3) {
    return { ok: false, message: `멤버를 한 명 이상 멘션해 주세요.\n${ADD_MENTION_GROUP_USAGE}` };
  }

  const memberUserIds: string[] = [];
  for (const token of tokens.slice(1)) {
    const match = SLACK_MENTION_PATTERN.exec(token);
    if (!match) {
      return {
        ok: false,
        message: `멤버는 Slack 멘션 형식으로 입력해 주세요: ${token}\n${ADD_MENTION_GROUP_USAGE}`,
      };
    }
    if (!memberUserIds.includes(match[1])) memberUserIds.push(match[1]);
  }

  return {
    ok: true,
    command: {
      handle,
      displayName: displayNameFromHandle(handle),
      memberUserIds,
    },
  };
}

function displayNameFromHandle(handle: string): string {
  return handle
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
