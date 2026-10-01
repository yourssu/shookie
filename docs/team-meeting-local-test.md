# 팀·TF 회의 일정 로컬 확인

회의 기능은 Radar 백엔드, Radar 프론트엔드, Shookie 세 저장소의 `feat/team-meeting-visibility` 브랜치에 있습니다. Slack 채널 ID를 수정하는 신규 API는 제거했습니다. 리마인더는 기존 그룹의 `representative_slack_channel_id`를 읽습니다.

## 자격증명 없이 기능별 확인

```bash
cd /Users/kanghyeon/orca/workspaces/radar-backend/main
./gradlew test --tests com.yourssu.radar.meeting.service.MeetingServiceRangeTest

cd /Users/kanghyeon/orca/projects/radar-frontend
corepack pnpm install --frozen-lockfile
corepack pnpm test --run src/pages/TeamMeetingsPage.test.tsx
corepack pnpm build

cd /Users/kanghyeon/orca/projects/shookie
corepack yarn workspace shookie test src/slack/meeting-reminders.test.ts
corepack yarn workspace shookie build
```

백엔드 테스트는 단일 일정의 기간 겹침과 매주·격주·매월·사용자 지정 반복 날짜를 확인합니다. 프론트엔드 테스트는 단일/반복 회의 입력과 장소 추가, 수정·삭제 요청을 확인합니다. Shookie 테스트는 채널 전송, Radar 확인 처리, 중복 전송 방지, 전송 실패 시 claim 해제를 확인합니다.

## 화면과 Slack까지 연결해서 확인

PostgreSQL 16, Docker Compose, 유효한 Radar Google OAuth 설정, Shookie Slack Bot/App 토큰 및 LLM API 키가 필요합니다. 아래 예시의 비밀 키와 토큰은 실제 값을 로컬 환경변수에만 넣으세요.

1. PostgreSQL을 띄우고 `radar` DB를 만듭니다. Shookie DB 이름은 `shookie`, 로컬 비밀번호 예시는 `postgres`입니다.

   ```bash
   cd /Users/kanghyeon/orca/projects/shookie
   docker compose -f docker-compose.db.yml up -d
   docker compose -f docker-compose.db.yml exec db createdb -U postgres radar
   ```

   `radar` DB가 이미 있으면 생성 명령은 생략합니다. Radar 백엔드 시작 시 Radar Flyway 마이그레이션(V42 포함)이 적용되고, Shookie 시작 시 Shookie DB 마이그레이션(006 포함)이 적용됩니다.

2. Radar 백엔드를 실행합니다. `env.example`을 참고해 두 DB URL·사용자·비밀번호를 설정하고 `RADAR_MEETING_REMINDER_INTERNAL_API_KEY`에 임의의 긴 로컬 전용 값을 넣습니다. Google 로그인 확인에는 `GOOGLE_OAUTH_CLIENT_ID`와 `GOOGLE_OAUTH_CLIENT_SECRET`도 필요합니다.

   ```bash
   cd /Users/kanghyeon/orca/workspaces/radar-backend/main
   export SHOOKIE_DATABASE_URL=jdbc:postgresql://localhost:5432/shookie
   export RADAR_DATABASE_URL=jdbc:postgresql://localhost:5432/radar
   export SHOOKIE_DATABASE_USERNAME=postgres RADAR_DATABASE_USERNAME=postgres
   export SHOOKIE_DATABASE_PASSWORD=postgres RADAR_DATABASE_PASSWORD=postgres
   export RADAR_MEETING_REMINDER_INTERNAL_API_KEY=local-meeting-reminder-key
   ./gradlew bootRun
   ```

   다른 터미널에서 `curl http://localhost:8080/actuator/health`로 기동을 확인합니다.

3. 프론트엔드를 실행합니다. `radar-frontend/.env.local`에 `VITE_API_BASE_URL=http://localhost:8080`을 넣습니다.

   ```bash
   cd /Users/kanghyeon/orca/projects/radar-frontend
   corepack pnpm dev
   ```

   `http://localhost:5173`에서 로그인한 뒤 **팀 & TF → 회의 시간 현황표**로 이동합니다. 로그인할 계정의 멤버·그룹 데이터가 로컬 DB에 있어야 합니다.

4. Slack 알림을 확인하려면 Shookie 루트 `.env`를 `.env.example`에서 만들고 다음 값을 설정합니다. 토큰은 Slack 앱의 **OAuth & Permissions**(Bot User OAuth Token) 및 **Basic Information → App-Level Tokens**에서 받습니다. App-Level Token에는 Socket Mode의 `connections:write`가 필요하고, Bot은 전송 대상 채널에 들어가 있어야 합니다.

   ```dotenv
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/shookie
   RADAR_MEETING_REMINDER_API_URL=http://localhost:8080/internal/v1/meeting-reminders
   SHOOKIE_MEETING_REMINDER_INTERNAL_API_KEY=local-meeting-reminder-key
   SLACK_BOT_TOKEN=xoxb-실제-토큰
   SLACK_APP_TOKEN=xapp-실제-토큰
   LLM_API_KEY=실제-키
   ```

   ```bash
   cd /Users/kanghyeon/orca/projects/shookie
   corepack yarn workspace database build
   corepack yarn workspace shookie build
   corepack yarn workspace shookie start
   ```

## 수동 확인 순서

- 단일 회의를 생성하고 캘린더 월/주/목록에서 확인한 뒤 수정·삭제합니다.
- 반복 회의를 매주·격주·매월·사용자 지정 주기로 생성해 해당 날짜에만 표시되는지 확인합니다.
- 온라인과 오프라인을 각각 만들고, 기본 장소 `동방(학생회관 244호)` 및 새 장소 추가를 확인합니다.
- 그룹 필터로 팀/TF별 일정을 확인합니다.
- 리마인더는 시작 30분 이내의 회의를 기존 대표 Slack 채널이 설정된 그룹에만 보냅니다. `GET /internal/v1/meeting-reminders/due` 요청에 `X-Radar-Meeting-Reminder-Key` 헤더를 넣어 대상을 확인할 수 있습니다. 헤더가 없거나 키가 틀리면 접근이 거부되어야 합니다.
- 대상 회의가 있으면 Shookie가 회의 제목·시작 시각·장소를 멘션 없이 채널에 보내는지 확인합니다. 전송 후 Radar 확인 처리로 같은 회의가 다시 전송되지 않아야 합니다.

현재 로컬 호스트에 Docker/PostgreSQL과 서비스 자격증명이 없다면 화면 로그인과 실제 Slack 전송은 수행할 수 없습니다. 위의 자격증명 없는 테스트로 코드 경로를 먼저 확인하세요.
