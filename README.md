# 슈키 (shookie)

유어슈(Yourssu) 사내 AI 어시스턴트 Slack 봇. 개발/비개발 구분 없이 자연어로 사내 데이터에 접근할 수 있는 LLM 에이전트.

## 사용 방법

Slack에서 두 가지 방식으로 질문:

- **@멘션**: 채널에서 `@슈키 PostHog에 어떤 이벤트가 있어?`
- **DM**: 봇과 1:1 대화

메인 에이전트가 질문을 분석해 적절한 서브 에이전트에 위임하고, 결과를 종합해 답변합니다.

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

## 서브 에이전트

### PostHog Analyst

PostHog 분석 데이터 조회 전문. 다중 프로젝트를 지원합니다.

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

**지원 프로젝트**: SSUTime-Prod, soongpt-prod (사용자가 프로젝트를 지정하지 않으면 기본 프로젝트 사용, 컨텍스트로 자동 판단)

### Code Explorer

GitHub 리포지토리 코드 탐색, 수정, PR 생성 전문. 스레드별 격리된 워크스페이스에서 동작합니다.

| 도구 | 설명 |
|---|---|
| `run_authenticated` | git/gh CLI 명령 실행 (GitHub PAT 인증) |
| `ensure_thread_workspace` | 스레드 워크스페이스 준비 |
| `finish_thread_workspace` | 스레드 워크스페이스 정리 |
| Workspace 파일 도구 | `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `search` 등 (Mastra Workspace 자동 제공) |

**워크플로우**: 워크스페이스 준비 → git clone → 코드 탐색/수정 → git push → PR 생성 → 워크스페이스 정리

**보안**: 명령어는 `git`/`gh`만 허용, 워크스페이스 외부 경로 접근 차단, 환경변수 최소 노출

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
│   │   │   └── index.ts             # 에이전트 팩토리
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
├── docker-compose.yml               # bot + PostgreSQL 컨테이너 정의
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

# .env 파일 설정 (shookie/.env)
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

`main` 브랜치에 push하면 GitHub Actions가 자동으로 EC2에 배포합니다. Docker Compose로 봇과 PostgreSQL이 함께 실행됩니다.

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

## 기술 스택

- **TypeScript ESM** (Node.js 20+) + @slack/bolt (Socket Mode)
- **Mastra** (에이전트 프레임워크)
- **LLM** DeepSeek (`@ai-sdk/deepseek`, OpenAI 호환 API)
- **PostgreSQL** (`pg`) — 에이전트 호출 로깅
- **Zod** (환경변수 및 도구 스키마 검증)
- **Yarn 4** (monorepo, corepack)
- **Docker Compose** (bot + PostgreSQL) + GitHub Actions CI/CD → EC2
- **Vitest** (테스트)
