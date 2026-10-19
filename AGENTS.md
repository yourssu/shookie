# Shookie 프로젝트 지침

이 프로젝트는 TypeScript 기반 Slack AI 에이전트 봇(슈키)입니다.

## 기본 규칙

- 언어: TypeScript ESM (Node.js 20+)
- 패키지 매니저: Yarn 4 (corepack)
- 프레임워크: Mastra (에이전트) + @slack/bolt (Socket Mode)
- LLM: DeepSeek API (`@ai-sdk/deepseek`, 기본 엔드포인트 `https://api.deepseek.com`, 기본 모델 `deepseek-flash`)
- 설정: Zod 스키마 (`shookie/src/config.ts`), `.env` 파일로 관리
- **절대 `.env` 파일을 커밋하지 않기**

## 아키텍처

- **단일 대화 에이전트**: 메인 Mastra Agent 하나가 일반 조회와 깊은 조사를 모두 직접 도구로 수행 (위임 런타임 없음)
- **메인 에이전트** (`shookie/src/agent/agents/main-shookie/`): 질문에 비례한 간결한 최종 답변 책임자
- **로컬 지침** (`shookie/src/agent/guidance/`): 실제 등록된 직접 서비스 기능에만 운영 절차 제공. 공통 안전 정책은 항상 적용
- 스레드 요약/이미지 해석의 보조 모델 호출은 유지하며 별도 대화 에이전트가 아니다. 역사 DB AgentName/기록/마이그레이션은 유지한다.
- **도구** (`shookie/src/tools/<서비스>/`): Mastra `createTool` 기반
- **대화 단위**: Slack 스레드 (`channel:thread_ts`)

## 모노레포 구조

```
shookie/
├── shookie/          ← 메인 슬랙 봇 패키지
├── database/         ← DB 연결 풀, 호출 로깅, 마이그레이션
└── package.json      ← workspace root
```

## 새 직접 서비스 도구 추가 시

1. `shookie/src/tools/<서비스>/`에 client.ts, schemas.ts, tools.ts 생성
2. `shookie/src/agent/index.ts`에서 설정에 따라 직접 도구 등록 (Agent 추가 금지)
3. 실제 등록 키 기준 기능 설명/로컬 지침 허용 범위 및 both/one/none 테스트 갱신
4. 필수 안전·인가 정책은 항상-on 정책에, 운영 절차는 버전 고정 로컬 지침에 보존
5. 새 설정이 필요하면 config/배포 환경변수 계약도 함께 갱신

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

## PR / 머지 규칙

- PR 머지 방식: **Squash and merge** 통일 (PR 1개 = main에 1커밋)
- 로컬 브랜치에서는 자유롭게 커밋을 쌓아도 됨 (머지 시점에 squash)
- PR 머지 후 로컬/원격 브랜치 즉시 정리
  - 로컬: `git branch -D <branch>`
  - 원격: GitHub 자동 삭제 설정, 또는 `git push origin --delete <branch>`
- 워크트리로 생성한 브랜치는 `git worktree remove` 후 삭제

## 컨벤션

- 에러 처리: 도구 실행 실패 시 사용자에게 한국어 친화적 메시지, 원본 에러 노출 금지
- @멘션 + DM으로 트리거
- 항상 스레드에 답글
- `.gitignore`에 `personal_doc/` 포함됨

## EC2 접속

민감 정보(키 경로, 퍼블릭 IP, 비밀번호)는 팀 내부 공유 채널 또는 GitHub Secrets에서 확인.

- 사용자: `ubuntu`
- 접속: `ssh -i <SSH_KEY_PATH> ubuntu@<EC2_HOST>` (값은 팀 내부 공유)
- 배포: main push 시 GitHub Actions가 arm64 이미지를 빌드해 GHCR에 푸시하고, EC2는 pull 후 bot만 `docker compose up -d --no-build --no-deps bot`으로 교체 (`docs/deployment.md`)

## 배포 파이프라인 신뢰성

- `set -eu`로 실패 시 silent success 차단, pull 성공 전에는 기존 컨테이너를 건드리지 않음
- deploy job은 `cancel-in-progress: false` + EC2 `flock`으로 진행 중 배포 취소/동시 실행 방지, 오래된 SHA 재배포 방지
- 서버에서 빌드/`docker compose down`/전역 `docker builder prune`·`image prune`을 하지 않음 (Radar와 Docker 호스트 공유). 이 저장소의 sha 태그만 성공 이력 기준 최근 3개 유지
- bot 준비 확인(Socket Mode 시작 로그 + 재시작 없음)과 교체 전 rollback snapshot, 실패 시 자동 롤백
- 공유 PostgreSQL은 배포 전후 ID/StartedAt/healthy/`pg_isready`만 확인하고 절대 변경하지 않음
- 새 환경변수를 `docker-compose.yml`에 추가하면 `deploy.yml`의 `DEPLOY_*` env/envs/export에도 추가 (계약 테스트가 검사)
- 컨테이너 로그는 `max-size: 50m, max-file: 5` 로 로테이션

## 브랜치명 규칙

- 브랜치명은 `feat/<짧은-설명>`, `fix/<짧은-설명>`, `chore/<짧은-설명>` 형식을 사용한다.
- 설명은 영문 소문자와 하이픈을 사용한다.
- `feat`는 기능, `fix`는 버그 수정, `chore`는 문서/설정/유지보수에 사용한다.
- 브랜치명에 Linear 이슈 번호나 식별자를 포함하지 않는다.
- 예시: `feat/add-notifications`, `fix/login-error`, `chore/update-docs`.
