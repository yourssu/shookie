import { createSocketModeApp } from "./slack/socket-mode-app.js";
import {
  config,
  getMentionGroupCommandConfig,
  getMentionGroupReplacementConfig,
  getSlackUserOAuthConfig,
  getSlackEventAttendanceConfig,
  getMeetingReminderConfig,
  getSlackMessageRelayConfig,
} from "./config.js";
import { setLogLevel, logger } from "./logger.js";
import { createAgent } from "./agent/index.js";
import { registerHandlers } from "./slack/handlers.js";
import { registerAssistantHandlers } from "./slack/assistant.js";
import { registerReactionRelay } from "./slack/reaction-relay.js";
import { registerEventAttendanceSlackSync } from "./slack/event-attendance.js";
import { closePool, runMigrations } from "database";
import { createSlackUserOAuthController } from "./slack/user-oauth/index.js";
import type { ConsumedSlackOAuthState } from "./slack/user-oauth/state-service.js";
import {
  createMentionGroupReplacementService,
  registerMentionGroupReplacement,
} from "./slack/mention-groups/index.js";
import { RadarMentionGroupCommandClient } from "./slack/mention-groups/command-client.js";
import { registerAddMentionGroupCommand } from "./slack/mention-groups/add-command.js";
import { registerUngroupMentionGroupCommand } from "./slack/mention-groups/ungroup-command.js";
import { registerMeetingReminderScheduler } from "./slack/meeting-reminders.js";
import { RadarMentionGroupsClient } from "./slack/mention-groups/radar-client.js";
import { createMessageRelay } from "./slack/message-relay/index.js";
import { verifyRelayIdentity } from "./slack/message-relay/identity.js";

async function main() {
  // 1. 로깅 설정
  setLogLevel(config.LOG_LEVEL);
  logger.info("구성 로드 완료");

  // 2. 사용자 OAuth 초기화 (멘션 그룹 원문 치환용)
  const userOAuthConfig = getSlackUserOAuthConfig();
  const eventAttendanceConfig = getSlackEventAttendanceConfig();
  const meetingReminderConfig = getMeetingReminderConfig();
  const mentionGroupConfig = getMentionGroupReplacementConfig();
  const mentionGroupCommandConfig = getMentionGroupCommandConfig();
  const messageRelayConfig = getSlackMessageRelayConfig();
  const mentionGroupCatalog = mentionGroupConfig
    ? new RadarMentionGroupsClient(mentionGroupConfig)
    : undefined;
  // Dialogue persistence is mandatory, independent of OAuth/reminder feature flags.
  const appliedMigrations = await runMigrations();
  if (appliedMigrations.length > 0) {
    logger.info("DB 마이그레이션 완료", { appliedMigrations });
  }
  // Public-message metadata outbox: persisted before Bolt ACKs, delivered to Radar by a separate bounded drainer.
  const messageRelay = messageRelayConfig ? createMessageRelay(messageRelayConfig) : null;
  let resumePendingMention: ((state: ConsumedSlackOAuthState) => Promise<void>) | null = null;
  const userOAuth = userOAuthConfig
    ? createSlackUserOAuthController(userOAuthConfig, mentionGroupConfig
      ? {
          onAuthorized: async (state) => {
            if (!resumePendingMention) {
              throw new Error("Mention group replacement is not ready");
            }
            await resumePendingMention(state);
          },
        }
      : {})
    : null;

  // 3. 에이전트 생성
  const agent = createAgent();

  // 4. Slack 앱 초기화
  const { app } = createSocketModeApp({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    ...(messageRelay ? { messageRelay: messageRelay.capture } : {}),
    ...(userOAuth && userOAuthConfig
      ? {
          customRoutes: [
            {
              path: userOAuth.callbackPath,
              method: "GET",
              handler: userOAuth.handleCallback,
            },
          ],
          installerOptions: { port: userOAuthConfig.port },
        }
      : {}),
  });

  // 5. 핸들러 등록
  if (mentionGroupConfig && userOAuth) {
    const mentionGroupReplacement = createMentionGroupReplacementService(
      app,
      userOAuth,
      mentionGroupConfig,
    );
    resumePendingMention = (state) =>
      mentionGroupReplacement.resumeAfterAuthorization(state);
    registerMentionGroupReplacement(app, mentionGroupReplacement);
    logger.info("Slack 멘션 그룹 원문 치환 활성화");
  }
  if (mentionGroupCommandConfig) {
    const mentionGroupCommand = new RadarMentionGroupCommandClient(mentionGroupCommandConfig);
    registerAddMentionGroupCommand(app, mentionGroupCommand);
    registerUngroupMentionGroupCommand(app, mentionGroupCommand);
    logger.info("Slack /group 명령어 활성화");
  }
  registerHandlers(app, agent);
  registerAssistantHandlers(app);
  registerReactionRelay(app);
  if (eventAttendanceConfig) {
    registerEventAttendanceSlackSync(app, eventAttendanceConfig);
    logger.info("Slack 행사 참석 반응 동기화 활성화", {
      reactionKinds: Object.keys(eventAttendanceConfig.reactionKinds).length,
    });
  }
  if (meetingReminderConfig) {
    registerMeetingReminderScheduler(app, meetingReminderConfig, mentionGroupCatalog);
    logger.info("Radar 미팅 알림 활성화");
  }

  // 6. 시작
  if (messageRelayConfig) {
    // 한 번만(메시지별 조회 아님): 설정된 팀이 실제 봇 토큰의 워크스페이스와 다르면 부팅 실패.
    await verifyRelayIdentity(app.client, { appId: messageRelayConfig.appId, teamId: messageRelayConfig.teamId });
  }
  try {
    await app.start();
  } catch (error) {
    await app.stop();
    throw error;
  }
  if (messageRelay) {
    await messageRelay.drainer.start();
    logger.info("Radar Slack 메시지 릴레이 활성화 (outbox → Radar 전송)");
  }
  logger.info("슈키가 시작되었습니다! 🚀");

  // 7. 단일 Socket Mode 연결과 DB 연결 정리
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("종료 중...");
    try {
      await app.stop();
    } finally {
      try {
        // Socket is closed: let in-flight outbox commits finish, stop the drainer, only then close the pool.
        await messageRelay?.close();
      } finally {
        await closePool();
        process.exit(0);
      }
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error("부팅 실패", err);
  process.exit(1);
});
