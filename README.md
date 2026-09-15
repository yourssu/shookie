# 슈키 (shookie)

유어슈(Yourssu)에서 사용하는 사내 AI 어시스턴트 Slack 봇이에요. 개발/비개발 구분 없이 자연어로 사내 데이터에 편하게 접근할 수 있는 LLM 에이전트랍니다.

## 사용 방법

Slack에서는 두 가지 방식으로 질문할 수 있어요:

- **@멘션**: 채널에서 `@슈키 PostHog에 어떤 이벤트가 있어?`
- **DM**: 봇과 1:1 대화

메인 에이전트가 질문을 분석해 적절한 서브 에이전트에 위임하고, 결과를 종합해 답변해 드려요.

## 아키텍처

```
사용자 메시지 (@멘션 / DM)
    ↓
slack/handlers.ts — 이벤트 감지, 스레드 단위 세션 관리
    ↓
agent/main-shookie — 메인 에이전트 (질문 분석 → 서브 에이전트 라우팅)
    ↓
┌─────────────────────┬──────────────────────┐
│  PostHog Analyst     │  Code Explorer       │
│  (9개 도구)          │  (git/gh CLI + 파일) │
└─────────────────────┴──────────────────────┘
    ↓
slack/markdown-to-blocks.ts — LLM 응답을 Slack Block Kit으로 변환
    ↓
Slack 스레드에 답글 + 호출 기록 DB 저장
```

- **멀티 에이전트 패턴**: 메인 에이전트가 도메인별 서브 에이전트에 위임
- **Mastra**: 에이전트 프레임워크 (도구 정의, 프롬프트 관리, Workspace API)
- **스레드 단위 대화**: Slack 스레드(`channel:thread_ts`) = 하나의 대화 컨텍스트 (최대 30메시지)
- **Socket Mode**: 공개 URL 불필요, 봇이 Slack에 WebSocket 연결
- **Slack Block Kit 포맷팅**: LLM 응답 Markdown을 헤더, 구분선, 테이블, mrkdwn 등 Block Kit으로 자동 변환
- **호출 로깅**: 모든 에이전트 호출(사용자, 질문, 응답, 토큰 사용량)을 PostgreSQL에 영구 저장
- **시스템 프롬프트 로깅**: LLM 호출 직전 시스템 프롬프트를 debug 레벨로 덤프해 프롬프트 회귀 추적 가능 (`agent/log-system-prompt.ts`)

## 서브 에이전트

### PostHog Analyst

PostHog 분석 데이터 조회를 담당해요. 여러 프로젝트를 동시에 지원합니다.

| 도구 | 설명 |
|---|---|
| `queryEvents` | 이벤트 목록 조회 |
| `queryInsights` | 인사이트(분석 리포트) 조회 |
| `listFeatureFlags` | 기능 플래그 목록 |
| `listDashboards` | 대시보드 목록 |
| `getDashboard` | 대시보드 상세 (포함된 인사이트) |
| `queryHogQL` | HogQL 쿼리 실행 |
| `listPersons` | 사용자 조회 |
| `listCohorts` | 코호트(사용자 그룹) 목록 |
| `listExperiments` | 실험(A/B 테스트) 목록 |

**지원 프로젝트**: `shookie/src/projects/` 레지스트리에 등록된 프로젝트를 자동으로 로딩해요 (PostHog 프로젝트 ID + 표시명 + 설명). 현재 SSUTime-Prod, soongpt-prod가 등록되어 있고, 사용자가 명시하지 않으면 질문 컨텍스트로 프로젝트를 자동 판단해요.

### Code Explorer

GitHub 리포지토리 코드 탐색, 수정, PR 생성을 담당해요. 스레드별 격리된 워크스페이스에서 안전하게 동작합니다.

| 도구 | 설명 |
|---|---|
| `run_authenticated` | git/gh CLI 명령 실행 (GitHub PAT 인증) |
| `ensure_thread_workspace` | 스레드 워크스페이스 준비 |
| `finish_thread_workspace` | 스레드 워크스페이스 정리 |
| Workspace 파일 도구 | `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `search` 등 (Mastra Workspace 자동 제공) |

**워크플로우**: 워크스페이스 준비 → git clone → 코드 탐색/수정 → git push → PR 생성 → 워크스페이스 정리

**보안**: `git`/`gh` 명령어만 허용하고, 워크스페이스 외부 접근을 차단하며, 환경변수 노출을 최소화해요.

## 모노레포 구조

```
shookie/
├── shookie/                         # 메인 슬랙 봇 패키지
│   ├── src/
│   │   ├── agent/
│   │   │   ├── agents/
│   │   │   │   ├── main-shookie/    # 메인 에이전트 (9섹션 프롬프트)
│   │   │   │   ├── posthog/         # PostHog 분석 에이전트
│   │   │   │   └── code-explorer/   # 코드 탐색 에이전트
│   │   │   ├── processors/          # 응답 후처리 (Slack 변환 등)
│   │   │   ├── log-system-prompt.ts # LLM 시스템 프롬프트 로깅 미들웨어
│   │   │   └── index.ts             # 에이전트 팩토리
│   │   ├── projects/                # PostHog 프로젝트 레지스트리
│   │   │   ├── registry.ts          # getPostHogProjects()
│   │   │   ├── types.ts             # 프로젝트 메타데이터 스키마
│   │   │   ├── ssutime-prod/        # 프로젝트별 지식
│   │   │   └── soongpt-prod/
│   │   ├── tools/
│   │   │   ├── posthog/             # PostHog API 클라이언트 + 9개 도구
│   │   │   └── code-explorer/       # git/gh CLI 실행 + 워크스페이스 관리
│   │   ├── slack/
│   │   │   ├── handlers.ts          # @멘션/DM 이벤트 핸들러
│   │   │   ├── thread-context.ts    # 스레드 세션 관리
│   │   │   └── markdown-to-blocks.ts # Markdown → Slack Block Kit 변환기
│   │   ├── services/
│   │   │   └── memory/in-memory.ts  # 인메모리 대화 저장소
│   │   ├── config.ts                # Zod 환경변수 스키마
│   │   ├── logger.ts                # 로거
│   │   └── index.ts                 # 엔트리포인트
│   └── Dockerfile
├── database/                        # PostgreSQL 연결 풀, 호출 로깅, 마이그레이션
│   ├── src/
│   │   ├── pool.ts                  # pg 연결 풀 (lazy singleton)
│   │   ├── log-agent-call.ts        # 에이전트 호출 기록 저장
│   │   └── index.ts
│   └── migrations/001_init.sql      # agent_calls 테이블 스키마
├── docker-compose.yml               # Shookie bot (일반 배포 단위)
├── docker-compose.db.yml            # 공유 PostgreSQL (별도 생명주기)
├── package.json                     # workspace root
└── tsconfig.base.json
```

## 새 서브 에이전트 추가 방법

1. `shookie/src/tools/<서비스>/`에 client.ts, schemas.ts, tools.ts 생성
2. `shookie/src/agent/agents/<도메인>/`에 index.ts, instructions.ts, description.ts, tools.ts 생성
3. `shookie/src/config.ts`에 환경변수 추가 (선택적)
4. `shookie/src/agent/index.ts`의 `createAgent()`에서 조건부 등록
5. `shookie/src/agent/agents/main-shookie/tools.ts`에 위임 도구 추가
6. 메인 에이전트 instructions.ts 섹션 7 도메인 카탈로그 업데이트
7. `instructions.test.ts`에 서브 에이전트 등장 테스트 추가
8. `.github/workflows/deploy.yml`에 새 환경변수 항목 추가

## 로컬 개발

```bash
# 의존성 설치
yarn install

# .env 파일 설정 (레포 루트 /.env)
# 필수: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, LLM_API_KEY
# 선택: POSTHOG_API_KEY, GITHUB (PAT, repo 권한 필요)

# 빌드
yarn workspace database build
yarn workspace shookie build

# 실행
yarn workspace shookie start

# 테스트
yarn workspace shookie test
```

## 배포

`main` 브랜치에 push하면 GitHub Actions가 자동으로 EC2에 Shookie bot만 배포해요. 공유 PostgreSQL은 `docker-compose.db.yml`에서 별도로 관리하며 일반 앱 배포는 컨테이너, 시작 시각, `shookie_pgdata` 볼륨을 유지합니다. 두 Compose 모델은 기존 `shookie_default` 네트워크와 `db` 호스트 이름을 계속 사용하므로 Radar 연결 계약도 바뀌지 않습니다.

새 환경에서는 PostgreSQL을 먼저 `docker compose -f docker-compose.db.yml up -d`로 준비한 다음 `docker compose up -d --no-deps bot`을 실행하세요. 운영 검증, DB 유지보수, 앱 롤백 절차는 [`docs/database-lifecycle.md`](docs/database-lifecycle.md)를 따르세요. 일반 배포나 앱 롤백 중에는 `docker compose -f docker-compose.db.yml down`, `docker compose down`, `docker compose up db`, 볼륨 삭제 명령을 실행하지 않습니다.

| GitHub Secret | 설명 |
|---|---|
| `EC2_HOST` | EC2 퍼블릭 IP |
| `EC2_USER` | SSH 사용자 (ubuntu) |
| `EC2_SSH_KEY` | SSH 프라이빗 키 |
| `SLACK_BOT_TOKEN` | Slack Bot OAuth Token |
| `SLACK_APP_TOKEN` | Slack App-Level Token (Socket Mode) |
| `LLM_API_KEY` | LLM API 키 |
| `LLM_BASE_URL` | LLM API 엔드포인트 (기본: DeepSeek) |
| `POSTHOG_API_KEY` | PostHog Personal API Key |
| `GITHUB` | GitHub Personal Access Token |
| `POSTGRES_PASSWORD` | PostgreSQL 비밀번호 |

### Radar 멘션 그룹 원문 치환

이 기능은 기본적으로 꺼져 있으며 `SLACK_MENTION_GROUP_REPLACEMENT_ENABLED=true`일 때만 동작합니다. 작성자 User OAuth에는 `chat:write`만 사용하고, Radar 조회는 `RADAR_MENTION_GROUPS_API_URL`의 `/internal/v1/mention-groups`와 전용 `SHOOKIE_MENTION_GROUPS_API_KEY`를 사용합니다. 상세 환경변수와 안전한 기본값은 `.env.example`을 참고하세요.

채널 메시지를 수신하고 OAuth 후 대기 메시지를 다시 읽으려면 Slack 앱에 공개/비공개 채널의 message event 구독과 해당 history scope가 필요합니다. 실제 Slack Redirect URL, 앱 scope/event 설정, 메시지 편집 정책과 알림 동작 검증은 자격증명이 있는 배포 환경에서 진행해야 합니다.

### Slack `/group` 빠른 생성

Slack 앱에 `/group` Slash Command를 등록하고 Shookie의 명령어 플래그를 켜면 다음 형식으로 Radar에 멘션 그룹을 만들 수 있어요.

```text
/group backend @backend-user-1 @backend-user-2
```

Slack이 전달하는 멘션은 `<@U...>`로 변환되며, Shookie는 중복 멤버를 제거하고 명령 실행자의 Slack User ID를 Radar 감사 이력에 남깁니다. 그룹 생성에는 기존 조회용 키와 분리된 `SHOOKIE_MENTION_GROUPS_WRITE_API_KEY`가 필요합니다. 생성 후 별칭·멤버 수정, 활성화·삭제는 Radar의 멘션 그룹 화면에서 진행합니다.

Socket Mode 기반 앱 등록 설정 조각은 [`docs/slack-add-group-command-manifest.yml`](docs/slack-add-group-command-manifest.yml)에 있습니다. 기존 Shookie 앱에 적용할 때는 현재 앱 manifest를 먼저 export한 뒤 `features.slash_commands` 항목과 `commands` bot scope만 병합하세요. Socket Mode에서는 Slash Command Request URL을 입력하지 않습니다.

명령어는 기본적으로 꺼져 있습니다. `.env`에서 다음 값을 설정하고 `/group`이 실제 Slack 앱에 등록된 경우에만 활성화됩니다.

```dotenv
SLACK_MENTION_GROUP_COMMAND_ENABLED=true
RADAR_MENTION_GROUPS_WRITE_API_URL=http://localhost:8080/internal/v1/mention-groups
SHOOKIE_MENTION_GROUPS_WRITE_API_KEY=<Radar와 동일한 전용 write key>
```

자격증명 없이 전체 흐름을 확인하는 로컬 실험은 다음 명령으로 실행합니다. 로컬 HTTP Radar write 계약 대역, Shookie parser/client/handler를 함께 실행하며 실제 Radar DB는 변경하지 않습니다.

```bash
corepack yarn workspace shookie test:e2e:mention-group-command
```

Slack 앱 설정, 비밀값 분류, 로컬/수동 E2E, 기존 mention-bot 전환 및 롤백 절차는 [`docs/slack-mention-groups-rollout.md`](docs/slack-mention-groups-rollout.md)를 따르세요. 특히 두 봇을 같은 채널에서 동시에 활성화하지 말고, 편집으로 추가된 멘션의 실제 알림 여부를 실워크스페이스에서 승인하기 전에는 운영 전환하지 않습니다.

## 기술 스택

- **TypeScript ESM** (Node.js 20+) + @slack/bolt (Socket Mode)
- **Mastra** (에이전트 프레임워크)
- **LLM** DeepSeek (`@ai-sdk/deepseek`, OpenAI 호환 API)
- **PostgreSQL** (`pg`) — 에이전트 호출 로깅
- **Zod** (환경변수 및 도구 스키마 검증)
- **Yarn 4** (monorepo, corepack)
- **Docker Compose** (bot과 공유 PostgreSQL 생명주기 분리) + GitHub Actions CI/CD → EC2
- **Vitest** (테스트)
