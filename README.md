# 숭민이

유어슈(Yourssu) 사내 AI 어시스턴트 Slack 봇. 개발/비개발 구분 없이 자연어로 사내 데이터에 접근할 수 있는 LLM 에이전트.

## 사용 방법

Slack에서 두 가지 방식으로 질문:

- **@멘션**: 채널에서 `@숭민이 PostHog에 어떤 이벤트가 있어?`
- **DM**: 봇과 1:1 대화

LLM이 자동으로 적절한 도구를 선택해 답변합니다.

## 아키텍처

```
사용자 메시지
    ↓
slack/handlers.ts — @멘션/DM 감지
    ↓
agent/ — 코디네이터 에이전트가 서브 에이전트에 위임
    ↓  (LLM이 도구/에이전트 선택)
tools/* — PostHog, Notion, GitHub, Linear 등
```

- **멀티 에이전트 패턴**: 코디네이터가 도메인별 서브 에이전트에 위임
- **Mastra**: 에이전트 프레임워크 (도구 정의, 프롬프트 관리)
- **스레드 단위 대화**: Slack 스레드 = 하나의 대화 컨텍스트
- **Socket Mode**: 공개 URL 불필요, 봇이 Slack에 WebSocket 연결

## 모노레포 구조

```
soongmini/
├── soongmini-agent/        # 메인 슬랙 봇 패키지
│   ├── src/
│   │   ├── agent/
│   │   │   ├── agents/
│   │   │   │   ├── coordinator/  # 코디네이터 에이전트
│   │   │   │   └── posthog/      # PostHog 분석 에이전트
│   │   │   └── index.ts
│   │   ├── tools/
│   │   │   └── posthog/          # PostHog API 도구
│   │   ├── slack/
│   │   │   ├── handlers.ts       # @멘션/DM 이벤트 핸들러
│   │   │   └── thread-context.ts
│   │   ├── config.ts             # Zod 환경변수 스키마
│   │   └── index.ts              # 엔트리포인트
│   └── Dockerfile
├── database/               # 스키마 마이그레이션
├── package.json            # workspace root
└── tsconfig.base.json
```

## 새 서브 에이전트 추가 방법

1. `soongmini-agent/src/tools/<서비스>/`에 client.ts, schemas.ts, tools.ts 생성
2. `soongmini-agent/src/agent/agents/<도메인>/`에 index.ts, instructions.ts, description.ts, tools.ts 생성
3. `soongmini-agent/src/config.ts`에 환경변수 추가 (선택적)
4. `soongmini-agent/src/agent/index.ts`의 `createAgent()`에서 조건부 등록
5. `soongmini-agent/src/agent/agents/coordinator/tools.ts`에 위임 도구 추가
6. 코디네이터 instructions.ts 섹션 7 도메인 카탈로그 업데이트

## 로컬 개발

```bash
# 의존성 설치
yarn install

# .env 파일 설정
cp .env.example .env
# .env에 API 키 입력

# 실행
yarn workspace soongmini-agent dev
```

## 배포

`main` 브랜치에 push하면 GitHub Actions가 자동으로 EC2에 배포합니다.

필요한 GitHub Secrets: `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `LLM_API_KEY`, `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`

## 기술 스택

- **TypeScript ESM** (Node.js 20+) + @slack/bolt (Socket Mode)
- **Mastra** (에이전트 프레임워크)
- **LLM** Upstage Solar (OpenAI 호환 API)
- **Yarn 4** (monorepo)
- **Docker** + GitHub Actions CI/CD → EC2
