import { App } from "@slack/bolt";
import {
  config,
  getMentionGroupCommandConfig,
  getMentionGroupReplacementConfig,
  getSlackUserOAuthConfig,
} from "./config.js";
import { setLogLevel, logger } from "./logger.js";
import { createAgent } from "./agent/index.js";
import { registerHandlers } from "./slack/handlers.js";
import { registerAssistantHandlers } from "./slack/assistant.js";
import { registerReactionRelay } from "./slack/reaction-relay.js";
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

async function main() {
  // 1. 로깅 설정
  setLogLevel(config.LOG_LEVEL);
  logger.info("구성 로드 완료");

  // 2. 사용자 OAuth 초기화 (멘션 그룹 원문 치환용)
  const userOAuthConfig = getSlackUserOAuthConfig();
  const mentionGroupConfig = getMentionGroupReplacementConfig();
  const mentionGroupCommandConfig = getMentionGroupCommandConfig();
  if (userOAuthConfig) {
    const appliedMigrations = await runMigrations();
    if (appliedMigrations.length > 0) {
      logger.info("DB 마이그레이션 완료", { appliedMigrations });
    }
  }
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
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    socketMode: true,
    appToken: config.SLACK_APP_TOKEN,
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

  // 6. 시작
  await app.start();
  logger.info("슈키가 시작되었습니다! 🚀");

  // 7. 종료 시 DB 연결 정리
  const shutdown = async () => {
    logger.info("종료 중...");
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error("부팅 실패", err);
  process.exit(1);
});
