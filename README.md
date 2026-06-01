# 숭민이

유어슈(Yourssu) 사내 AI 어시스턴트 Slack 봇. 개발/비개발 구분 없이 자연어로 사내 데이터에 접근할 수 있는 LLM 에이전트.

## 사용 방법

Slack에서 두 가지 방식으로 질문:

- **@멘션**: 채널에서 `@숭민이 PostHog에 어떤 이벤트가 있어?`
- **DM**: 봇과 1:1 대화

코디네이터 에이전트가 질문을 분석해 적절한 서브 에이전트에 위임하고, 결과를 종합해 답변합니다.

## 아키텍처

```
사용자 메시지 (@멘션 / DM)
    ↓
slack/handlers.ts — 이벤트 감지, 스레드 단위 세션 관리
    ↓
agent/coordinator — 코디네이터 에이전트 (질문 분석 → 서브 에이전트 라우팅)
    ↓
┌─────────────────────┬──────────────────────┐
│  PostHog Analyst     │  GitHub Explorer     │
│  (9개 도구)          │  (12개 도구)         │
└─────────────────────┴──────────────────────┘
    ↓
slack/markdown-to-blocks.ts — LLM 응답을 Slack Block Kit으로 변환
    ↓
Slack 스레드에 답글
```

- **멀티 에이전트 패턴**: 코디네이터가 도메인별 서브 에이전트에 위임
- **Mastra**: 에이전트 프레임워크 (도구 정의, 프롬프트 관리, DynamicArgument)
- **스레드 단위 대화**: Slack 스레드(`channel:thread_ts`) = 하나의 대화 컨텍스트 (최대 30메시지)
- **Socket Mode**: 공개 URL 불필요, 봇이 Slack에 WebSocket 연결
- **Slack Block Kit 포맷팅**: LLM 응답 Markdown을 헤더, 구분선, 테이블, mrkdwn 등 Block Kit으로 자동 변환

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

### GitHub Explorer

GitHub 리포지토리 탐색 전문.

| 도구 | 설명 |
|---|---|
| `listRepos` | 접근 가능한 리포지토리 목록 |
| `getRepoInfo` | 리포지토리 상세 정보 |
| `getRepoTree` | 디렉토리 구조 탐색 |
| `getFileContent` | 파일 내용 조회 |
| `getReadme` | README.md 조회 |
| `listPullRequests` | PR 목록 |
| `getPullRequest` | PR 상세 (변경 파일, 리뷰 포함) |
| `listCommits` | 커밋 이력 |
| `searchCode` | 코드 검색 |
| `listIssues` | 이슈 목록 |
| `getIssue` | 이슈 상세 |
| `listBranches` | 브랜치 목록 |

**접근 가능한 리포지토리**: soongpt-web, soongpt-backend (yourssu 조직)

## 모노레포 구조

```
soongmini/
├── soongmini-agent/                 # 메인 슬랙 봇 패키지
│   ├── src/
│   │   ├── agent/
│   │   │   ├── agents/
│   │   │   │   ├── coordinator/     # 코디네이터 에이전트 (9섹션 프롬프트)
│   │   │   │   ├── posthog/         # PostHog 분석 에이전트
│   │   │   │   └── github/          # GitHub 탐색 에이전트
│   │   │   └── index.ts             # 에이전트 팩토리
│   │   ├── tools/
│   │   │   ├── posthog/             # PostHog API 클라이언트 + 9개 도구
│   │   │   └── github/              # GitHub API 클라이언트 + 12개 도구
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
├── database/                        # 스키마 마이그레이션 (Phase 3)
├── package.json                     # workspace root
└── tsconfig.base.json
```

## 새 서브 에이전트 추가 방법

1. `soongmini-agent/src/tools/<서비스>/`에 client.ts, schemas.ts, tools.ts 생성
2. `soongmini-agent/src/agent/agents/<도메인>/`에 index.ts, instructions.ts, description.ts, tools.ts 생성
3. `soongmini-agent/src/config.ts`에 환경변수 추가 (선택적)
4. `soongmini-agent/src/agent/index.ts`의 `createAgent()`에서 조건부 등록
5. `soongmini-agent/src/agent/agents/coordinator/tools.ts`에 위임 도구 추가
6. 코디네이터 instructions.ts 섹션 7 도메인 카탈로그 업데이트
7. `instructions.test.ts`에 서브 에이전트 등장 테스트 추가
8. `.github/workflows/deploy.yml`에 새 환경변수 `-e` 항목 추가

## 로컬 개발

```bash
# 의존성 설치
yarn install

# .env 파일 설정 (soongmini-agent/.env)
# 필수: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, LLM_API_KEY
# 선택: POSTHOG_API_KEY, GITHUB

# 빌드
yarn workspace soongmini-agent build

# 실행
yarn workspace soongmini-agent start

# 테스트
yarn workspace soongmini-agent test
```

## 배포

`main` 브랜치에 push하면 GitHub Actions가 자동으로 EC2에 배포합니다.

| GitHub Secret | 설명 |
|---|---|
| `EC2_HOST` | EC2 퍼블릭 IP |
| `EC2_USER` | SSH 사용자 (ubuntu) |
| `EC2_SSH_KEY` | SSH 프라이빗 키 |
| `SLACK_BOT_TOKEN` | Slack Bot OAuth Token |
| `SLACK_APP_TOKEN` | Slack App-Level Token (Socket Mode) |
| `LLM_API_KEY` | LLM API 키 |
| `POSTHOG_API_KEY` | PostHog Personal API Key |
| `GITHUB` | GitHub Personal Access Token |

## 기술 스택

- **TypeScript ESM** (Node.js 20+) + @slack/bolt (Socket Mode)
- **Mastra** (에이전트 프레임워크)
- **LLM** DeepSeek (`@ai-sdk/deepseek`, OpenAI 호환 API)
- **Zod** (환경변수 및 도구 스키마 검증)
- **Yarn 4** (monorepo, corepack)
- **Docker** + GitHub Actions CI/CD → EC2
- **Vitest** (테스트)
