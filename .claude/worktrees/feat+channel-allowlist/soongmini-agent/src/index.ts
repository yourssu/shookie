import { App } from "@slack/bolt";
import { config } from "./config.js";
import { setLogLevel, logger } from "./logger.js";
import { createAgent } from "./agent/index.js";
import { registerHandlers } from "./slack/handlers.js";

async function main() {
  // 1. 로깅 설정
  setLogLevel(config.LOG_LEVEL);
  logger.info("구성 로드 완료");

  // 2. 에이전트 생성
  const agent = createAgent();

  // 3. Slack 앱 초기화
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    socketMode: true,
    appToken: config.SLACK_APP_TOKEN,
  });

  // 4. 핸들러 등록
  registerHandlers(app, agent);

  // 5. 시작
  await app.start();
  logger.info("숭민이가 시작되었습니다! 🚀");
}

main().catch((err) => {
  console.error("부팅 실패:", err);
  process.exit(1);
});
