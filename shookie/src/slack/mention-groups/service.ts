import { z } from "zod";
import { logger } from "../../logger.js";
import type { SlackOAuthStartRequest } from "../user-oauth/controller.js";
import type { ConsumedSlackOAuthState } from "../user-oauth/state-service.js";
import { SlackUserOAuthRequiredError } from "../user-oauth/token-service.js";
import { MentionEventDeduper } from "./event-deduper.js";
import type { MentionMessageEvent } from "./event.js";
import {
  createMentionReplacementPlan,
  findMentionHandleOccurrences,
  type MentionHandleOccurrence,
} from "./parser.js";
import {
  RadarMentionGroupsError,
  type RadarMentionGroupsClient,
} from "./radar-client.js";
import type { MentionSlackGateway, SlackMessageSnapshot } from "./slack-gateway.js";

const MAX_SLACK_UPDATE_TEXT_LENGTH = 4_000;
const TERMINAL_AUTH_ERRORS = new Set([
  "account_inactive",
  "invalid_auth",
  "missing_scope",
  "not_authed",
  "team_access_not_granted",
  "token_expired",
  "token_revoked",
]);
const PERMISSION_ERRORS = new Set([
  "access_denied",
  "cant_update_message",
  "channel_not_found",
  "edit_window_closed",
  "ekm_access_denied",
  "enterprise_is_restricted",
  "is_inactive",
  "message_not_found",
  "no_permission",
  "posting_to_channel_denied",
]);
const RADAR_MENTION_GROUPS_MANAGEMENT_URL =
  "https://radar.yourssu.com/mention-groups";
const RADAR_MENTION_GROUPS_MANAGEMENT_LINK =
  `<${RADAR_MENTION_GROUPS_MANAGEMENT_URL}|멘션 그룹 만들기·관리하기>`;
const RADAR_MENTION_GROUPS_MANAGEMENT_GUIDANCE =
  `${RADAR_MENTION_GROUPS_MANAGEMENT_LINK} 페이지에서 새로운 그룹을 만들고 관리할 수 있습니다.`;

const resumeContextSchema = z
  .object({
    channelId: z.string().regex(/^[CG][A-Z0-9]{2,}$/u),
    messageTs: z.string().regex(/^\d{1,20}\.\d{1,20}$/u),
    threadTs: z.string().regex(/^\d{1,20}\.\d{1,20}$/u).optional(),
    eventId: z.string().min(1).max(255).optional(),
  })
  .strict();

export interface MentionGroupCatalogProvider {
  getCatalog: RadarMentionGroupsClient["getCatalog"];
}

export interface MentionGroupOAuthProvider {
  getAccessToken(teamId: string, userId: string): Promise<string>;
  createAuthorizationUrl(request: SlackOAuthStartRequest): Promise<string | null>;
  invalidateAccessToken(
    teamId: string,
    userId: string,
    expectedAccessToken: string,
  ): Promise<boolean>;
}

type ProcessResult = "updated" | "noop" | "authorization_required" | "failed";

export class MentionGroupReplacementService {
  constructor(
    private readonly radar: MentionGroupCatalogProvider,
    private readonly oauth: MentionGroupOAuthProvider,
    private readonly slack: MentionSlackGateway,
    private readonly deduper = new MentionEventDeduper(),
  ) {}

  async handleEvent(input: MentionMessageEvent): Promise<void> {
    const occurrences = findMentionHandleOccurrences(input.text);
    if (occurrences.length === 0) return;
    const messageKey = `${input.teamId}:${input.channelId}:${input.messageTs}`;
    if (!this.deduper.claim(input.eventId, messageKey)) {
      logger.debug("멘션 그룹 중복 이벤트 무시", this.logContext(input));
      return;
    }

    try {
      await this.process(input, occurrences);
    } catch (error) {
      logger.error("멘션 그룹 이벤트 처리 실패", {
        ...this.logContext(input),
        error: safeErrorCode(error),
      });
      await this.notifyGenericFailure(input);
    }
  }

  async resumeAfterAuthorization(state: ConsumedSlackOAuthState): Promise<void> {
    const identityValid =
      /^T[A-Z0-9]{2,}$/u.test(state.teamId) &&
      /^[UW][A-Z0-9]{2,20}$/u.test(state.userId);
    const context = resumeContextSchema.safeParse(state.context);
    if (!identityValid || !context.success) {
      throw new Error("Invalid Slack OAuth mention resume context");
    }

    let snapshot: SlackMessageSnapshot | null;
    try {
      snapshot = await this.slack.loadMessage({
        channelId: context.data.channelId,
        messageTs: context.data.messageTs,
        ...(context.data.threadTs ? { threadTs: context.data.threadTs } : {}),
      });
    } catch (error) {
      logger.warn("OAuth 후 원문 메시지 조회 실패", {
        teamId: state.teamId,
        userId: state.userId,
        channelId: context.data.channelId,
        messageTs: context.data.messageTs,
        error: slackErrorCode(error),
      });
      throw new Error("Failed to load the pending Slack message");
    }

    if (!isSafeResumeTarget(snapshot, state.userId)) {
      logger.info("OAuth 후 변경되었거나 사라진 원문 처리 생략", {
        teamId: state.teamId,
        userId: state.userId,
        channelId: context.data.channelId,
        messageTs: context.data.messageTs,
      });
      return;
    }

    const input: MentionMessageEvent = {
      eventId: context.data.eventId ?? `oauth:${state.teamId}:${context.data.messageTs}`,
      teamId: state.teamId,
      userId: state.userId,
      channelId: context.data.channelId,
      messageTs: context.data.messageTs,
      ...(context.data.threadTs ? { threadTs: context.data.threadTs } : {}),
      text: snapshot.text,
    };
    const occurrences = findMentionHandleOccurrences(input.text);
    if (occurrences.length === 0) return;
    const result = await this.process(input, occurrences);
    if (result === "failed" || result === "authorization_required") {
      throw new Error("Failed to resume mention replacement after Slack OAuth");
    }
  }

  private async process(
    input: MentionMessageEvent,
    occurrences: MentionHandleOccurrence[],
  ): Promise<ProcessResult> {
    let catalog;
    try {
      catalog = await this.radar.getCatalog();
    } catch (error) {
      logger.warn("Radar 멘션 그룹 조회 실패, 원문 보존", {
        ...(error instanceof RadarMentionGroupsError ? error.diagnostics : {}),
        error:
          error instanceof RadarMentionGroupsError
            ? error.code
            : "unknown_error",
      });
      await this.notifyGenericFailure(input);
      return "failed";
    }

    const plan = createMentionReplacementPlan(input.text, catalog, occurrences);
    if (plan.unknownHandles.length > 0 || plan.emptyGroupHandles.length > 0) {
      await this.notifyUnresolvedGroups(
        input,
        plan.unknownHandles,
        plan.emptyGroupHandles,
      );
    }
    if (!plan.changed) {
      logger.info("치환 가능한 활성 멘션 그룹 없음", {
        ...this.logContext(input),
        radarRevision: catalog.revision,
        candidateCount: occurrences.length,
        unknownCount: plan.unknownHandles.length,
        emptyGroupCount: plan.emptyGroupHandles.length,
      });
      return "noop";
    }
    if (plan.text.length > MAX_SLACK_UPDATE_TEXT_LENGTH) {
      logger.warn("멘션 그룹 치환 결과 길이 초과, 원문 보존", {
        ...this.logContext(input),
        radarRevision: catalog.revision,
        outputLength: plan.text.length,
        memberCount: plan.memberUserIds.length,
      });
      await this.notifyGenericFailure(input);
      return "failed";
    }

    let accessToken: string;
    try {
      accessToken = await this.oauth.getAccessToken(input.teamId, input.userId);
    } catch (error) {
      if (error instanceof SlackUserOAuthRequiredError) {
        await this.promptAuthorization(input);
        return "authorization_required";
      }
      logger.warn("Slack 사용자 토큰 조회 실패, 원문 보존", {
        ...this.logContext(input),
        error: safeErrorCode(error),
      });
      await this.notifyGenericFailure(input);
      return "failed";
    }

    const updateResult = await this.updateWithToken(input, plan.text, accessToken);
    if (updateResult.status === "updated") {
      logger.info("멘션 그룹 원문 치환 완료", {
        ...this.logContext(input),
        radarRevision: catalog.revision,
        groupHandles: plan.groupHandles,
        memberCount: plan.memberUserIds.length,
      });
      return "updated";
    }
    if (updateResult.code && TERMINAL_AUTH_ERRORS.has(updateResult.code)) {
      return this.recoverTerminalAuthenticationFailure(
        input,
        plan.text,
        accessToken,
        updateResult.code,
      );
    }

    logger.warn("Slack 원문 수정 실패, 원문 보존", {
      ...this.logContext(input),
      radarRevision: catalog.revision,
      error: updateResult.code ?? "unknown_error",
    });
    await this.notifyUpdateFailure(input, updateResult.code);
    return "failed";
  }

  private async recoverTerminalAuthenticationFailure(
    input: MentionMessageEvent,
    replacementText: string,
    failedToken: string,
    errorCode: string,
  ): Promise<ProcessResult> {
    let invalidated = false;
    try {
      invalidated = await this.oauth.invalidateAccessToken(
        input.teamId,
        input.userId,
        failedToken,
      );
    } catch (error) {
      logger.warn("Slack 실패 토큰 조건부 폐기 실패", {
        ...this.logContext(input),
        error: safeErrorCode(error),
      });
    }
    logger.warn("Slack 사용자 토큰 재인증 필요", {
      ...this.logContext(input),
      error: errorCode,
      invalidated,
    });

    const prompted = await this.promptAuthorization(input);
    if (prompted) return "authorization_required";

    // createAuthorizationUrl returns null only when a concurrent callback or
    // rotation has already installed a valid credential. Retry once with that
    // newer token instead of revoking it because the older request failed.
    try {
      const currentToken = await this.oauth.getAccessToken(input.teamId, input.userId);
      if (currentToken === failedToken) {
        await this.notifyGenericFailure(input);
        return "failed";
      }
      const retry = await this.updateWithToken(input, replacementText, currentToken);
      if (retry.status === "updated") return "updated";
      if (retry.code && TERMINAL_AUTH_ERRORS.has(retry.code)) {
        await this.oauth.invalidateAccessToken(input.teamId, input.userId, currentToken);
        await this.promptAuthorization(input);
        return "authorization_required";
      }
      await this.notifyUpdateFailure(input, retry.code);
      return "failed";
    } catch (error) {
      if (error instanceof SlackUserOAuthRequiredError) {
        await this.promptAuthorization(input);
        return "authorization_required";
      }
      logger.warn("새 Slack 사용자 토큰 재시도 실패", {
        ...this.logContext(input),
        error: safeErrorCode(error),
      });
      await this.notifyGenericFailure(input);
      return "failed";
    }
  }

  private async updateWithToken(
    input: MentionMessageEvent,
    text: string,
    accessToken: string,
  ): Promise<{ status: "updated" } | { status: "failed"; code: string | null }> {
    try {
      await this.slack.updateMessage({
        accessToken,
        channelId: input.channelId,
        messageTs: input.messageTs,
        ...(input.threadTs ? { threadTs: input.threadTs } : {}),
        text,
      });
      return { status: "updated" };
    } catch (error) {
      return { status: "failed", code: slackErrorCode(error) };
    }
  }

  private async promptAuthorization(input: MentionMessageEvent): Promise<boolean> {
    let authorizationUrl: string | null;
    try {
      authorizationUrl = await this.oauth.createAuthorizationUrl({
        teamId: input.teamId,
        userId: input.userId,
        context: {
          channelId: input.channelId,
          messageTs: input.messageTs,
          ...(input.threadTs ? { threadTs: input.threadTs } : {}),
          eventId: input.eventId,
        },
      });
    } catch (error) {
      logger.warn("Slack 사용자 인증 URL 생성 실패", {
        ...this.logContext(input),
        error: safeErrorCode(error),
      });
      await this.notifyGenericFailure(input);
      return false;
    }
    if (!authorizationUrl) return false;

    await this.notify(input, [
      "이 메시지의 멘션 그룹을 치환하려면 작성자 Slack 인증이 필요합니다.",
      `<${authorizationUrl}|Slack 인증하기>`,
      RADAR_MENTION_GROUPS_MANAGEMENT_GUIDANCE,
      "인증이 끝나면 이 메시지를 자동으로 다시 처리합니다.",
    ].join("\n"));
    return true;
  }

  private async notifyUnresolvedGroups(
    input: MentionMessageEvent,
    unknownHandles: string[],
    emptyGroupHandles: string[],
  ): Promise<void> {
    const parts: string[] = [];
    if (unknownHandles.length > 0) {
      parts.push(
        `알 수 없거나 비활성화된 멘션 그룹: ${formatHandles(unknownHandles)}`,
      );
    }
    if (emptyGroupHandles.length > 0) {
      parts.push(`활성 멤버가 없는 멘션 그룹: ${formatHandles(emptyGroupHandles)}`);
    }
    parts.push(RADAR_MENTION_GROUPS_MANAGEMENT_GUIDANCE);
    await this.notify(input, parts.join("\n"));
  }

  private async notifyUpdateFailure(
    input: MentionMessageEvent,
    errorCode: string | null,
  ): Promise<void> {
    const message = errorCode && PERMISSION_ERRORS.has(errorCode)
      ? "Slack 권한 또는 메시지 편집 정책 때문에 멘션 그룹을 치환하지 못해 원문을 그대로 두었습니다."
      : "멘션 그룹을 치환하지 못해 원문을 그대로 두었습니다. 잠시 후 다시 시도해 주세요.";
    await this.notify(input, message);
  }

  private async notifyGenericFailure(input: MentionMessageEvent): Promise<void> {
    await this.notify(
      input,
      "멘션 그룹을 확인하지 못해 원문을 그대로 두었습니다. 잠시 후 다시 시도해 주세요.",
    );
  }

  private async notify(input: MentionMessageEvent, text: string): Promise<void> {
    try {
      await this.slack.postEphemeral({
        channelId: input.channelId,
        userId: input.userId,
        ...(input.threadTs ? { threadTs: input.threadTs } : {}),
        text,
      });
    } catch (error) {
      logger.warn("멘션 그룹 사용자 전용 안내 실패", {
        ...this.logContext(input),
        error: slackErrorCode(error),
      });
    }
  }

  private logContext(input: MentionMessageEvent): Record<string, string> {
    return {
      eventId: input.eventId,
      teamId: input.teamId,
      userId: input.userId,
      channelId: input.channelId,
      messageTs: input.messageTs,
    };
  }
}

function isSafeResumeTarget(
  snapshot: SlackMessageSnapshot | null,
  expectedUserId: string,
): snapshot is SlackMessageSnapshot & { text: string } {
  return Boolean(
    snapshot &&
      snapshot.userId === expectedUserId &&
      typeof snapshot.text === "string" &&
      !snapshot.botId &&
      !snapshot.edited &&
      (snapshot.subtype === undefined || snapshot.subtype === "me_message"),
  );
}

function formatHandles(handles: string[]): string {
  return handles.slice(0, 10).map((handle) => `@${handle}`).join(", ");
}

function slackErrorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const data = isRecord(error.data) ? error.data : null;
  const value = typeof data?.error === "string"
    ? data.error
    : typeof error.code === "string"
      ? error.code
      : null;
  return value && /^[a-z0-9_]{1,64}$/u.test(value) ? value : null;
}

function safeErrorCode(error: unknown): string {
  return slackErrorCode(error) ?? (error instanceof Error ? error.name : "unknown_error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
