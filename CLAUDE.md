# CLAUDE.md

이 프로젝트는 TypeScript 기반 Slack AI 에이전트 봇(슈키)입니다.

## 기본 규칙

- 언어: TypeScript ESM (Node.js 20+)
- 패키지 매니저: Yarn 4 (corepack)
- 프레임워크: Mastra (에이전트) + @slack/bolt (Socket Mode)
- LLM: OpenAI API (`@ai-sdk/openai`)
- 설정: Zod 스키마 (`shookie/src/config.ts`), `.env` 파일로 관리
- **절대 `.env` 파일을 커밋하지 않기**

## 아키텍처

- **멀티 에이전트 패턴 (sndy 스타일)**: 코디네이터 에이전트가 서브 에이전트에 위임
- **코디네이터** (`shookie/src/agent/agents/coordinator/`): 9섹션 프롬프트 기반 조정자
- **서브 에이전트** (`shookie/src/agent/agents/<도메인>/`): 도메인별 전문 에이전트
- **도구** (`shookie/src/tools/<서비스>/`): Mastra `createTool` 기반
- **대화 단위**: Slack 스레드 (`channel:thread_ts`)

## 모노레포 구조

```
shookie/
├── shookie/          ← 메인 슬랙 봇 패키지
├── database/         ← DB 연결 풀, 호출 로깅, 마이그레이션
└── package.json      ← workspace root
```

## 새 서브 에이전트 추가 시

1. `shookie/src/tools/<서비스>/`에 client.ts, schemas.ts, tools.ts 생성
2. `shookie/src/agent/agents/<도메인>/`에 index.ts, instructions.ts, description.ts, tools.ts 생성
3. `shookie/src/config.ts`에 환경변수 추가 (선택적)
4. `shookie/src/agent/index.ts`의 `createAgent()`에서 조건부 등록
5. `shookie/src/agent/agents/coordinator/tools.ts`에 위임 도구 추가
6. 코디네이터 instructions.ts 섹션 7 도메인 카탈로그 업데이트
7. `instructions.test.ts`에 서브 에이전트 등장 테스트 추가
8. `.github/workflows/deploy.yml`에 새 환경변수 항목 추가

## 명령어

```bash
yarn install                    # 의존성 설치
yarn workspace shookie build    # TypeScript 빌드
yarn workspace shookie start    # 실행
yarn workspace shookie test     # 테스트
```

## 커밋 규칙

- 기능 단위로 나눠서 커밋 (한 번에 몰아서 커밋하지 않기)
- 커밋 메시지: 한국어로, 변경 내용과 이유를 간결하게 작성
- **모든 작업 완료 후 커밋할 변경사항이 있는지 반드시 확인하고 커밋**
- **작업 완료 후 서버 재시작이 필요한지 반드시 안내하기** (코드 변경 시 필요, .env/문서 변경만 시 불필요)

## 컨벤션

- 에러 처리: 도구 실행 실패 시 사용자에게 한국어 친화적 메시지, 원본 에러 노출 금지
- @멘션 + DM으로 트리거
- 항상 스레드에 답글
- `.gitignore`에 `personal_doc/` 포함됨

## EC2 접속

- 키 파일: `~/.ssh/yourssu-prd.pem`
- 사용자: `ubuntu`
- 퍼블릭 IP: `52.78.167.108`
- 접속: `ssh -i ~/.ssh/yourssu-prd.pem ubuntu@52.78.167.108`
- 배포: main push 시 GitHub Actions가 자동으로 `docker compose` 배포
