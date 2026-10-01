# 배포 (GitHub Actions 이미지 빌드 → GHCR → EC2 pull)

운영 EC2(t4g.small, ARM64)에서는 이미지를 빌드하지 않는다. GitHub Actions가 `linux/arm64` bot 이미지를 빌드해
GHCR에 푸시하고, EC2는 **pull + bot 컨테이너만 `docker compose up -d --no-build --no-deps bot`으로 교체**한다.
Radar에서 운영 검증된 방식과 같은 구조이며, Shookie 고유 사항(공유 PostgreSQL, Socket Mode bot)을 반영했다.

공유 PostgreSQL(`docker-compose.db.yml`)은 Radar도 사용한다. 이 파이프라인은 DB를 **만들거나 교체·중단·재시작하지 않고**,
네트워크/볼륨도 바꾸지 않는다. 배포 전후로 상태만 확인한다([DB 불변 검사](#공유-postgresql-불변-검사)).
OAuth용 cloudflared, Radar 및 다른 서비스도 건드리지 않는다.

## 흐름

`.github/workflows/deploy.yml` (workflow 이름 `Deploy to EC2` 유지)

| 트리거 | build job | deploy job |
| --- | --- | --- |
| `push` to `main` | arm64 빌드 + GHCR 푸시 + arch 검증 | EC2 배포 |
| `workflow_dispatch` (main) | 동일 | 동일 |
| `workflow_dispatch` + `rollback_sha` | 건너뜀 | 해당 SHA 이미지 재배포 |
| `workflow_dispatch` (main 이외 ref) | 빌드 검증만 (푸시 없음) | 건너뜀 |
| `pull_request` (빌드 설정 파일 변경 시) | 빌드 검증만 (푸시/로그인 없음) | 건너뜀 |

- 이미지: `ghcr.io/yourssu/shookie:sha-<커밋 12자>` (immutable SHA 태그, `latest` 미사용).
  PR 빌드 트리거 경로: `shookie/Dockerfile`, `.dockerignore`, 루트/워크스페이스 `package.json`, `yarn.lock`, `.yarnrc.yml`,
  `tsconfig.base.json`, `docker-compose*.yml`, `scripts/verify-image-arch.sh`, workflow 파일. 앱 소스만 바뀐 PR은 빌드하지 않는다.
- ARM64: `ubuntu-latest`(amd64) runner + QEMU + Buildx. `shookie/Dockerfile`은 단일 stage라 `yarn install`/`tsc`가
  QEMU 위에서 실행되어 느릴 수 있다(GHA 캐시 사용). native arm runner는 private 저장소에서 유료라 쓰지 않았다.
  Dockerfile 자체는 바꾸지 않았다.
- build args / secrets는 이미지 빌드에 전달하지 않는다. 런타임 secrets는 배포 시 Compose 환경변수로만 주입된다.
  값은 ssh-action의 `env` + `envs`(single-quote 이스케이프)로 전달하고 스크립트에서는 `export NAME="${DEPLOY_NAME:-}"`로만
  받으므로 `$`, 공백, 따옴표, `;` 등이 있어도 원문 그대로 전달되며 실행되지 않는다. workflow에 `${{ secrets.* }}`를 셸 텍스트에 넣지 않는다.
- 푸시 후 `scripts/verify-image-arch.sh`가 레지스트리의 image config(`os`/`architecture`)로 `linux/arm64`를 검증한다.
  provenance를 끈 단일 manifest는 `imagetools inspect` 기본 출력에 `Platform:` 줄이 없으므로 grep으로 검증하지 않고, 구조화된
  `.Image`(단일 manifest / index 모두)를 검사한다.
- Compose: 기존 `docker-compose.yml`은 `build:`를 유지하고 이미지 이름만 `shookie-bot:local`로 고정했다(로컬 개발 흐름 유지).
  운영은 `docker-compose.deploy.yml` override(`image: ${SHOOKIE_BOT_IMAGE:?}`, `pull_policy: never`)를 합쳐 쓴다.
  `DATABASE_URL`, 포트, 로그 로테이션(`max-size: 50m, max-file: 5`), `shookie_default` external 네트워크는 그대로다.

### EC2에서 일어나는 일 (순서)

1. 배포 잠금(`flock -n`, `/home/ubuntu/.shookie-deploy.lock`) → 이전 workflow가 `~/.gitconfig`에 남긴 `url.https://x-access-token:*`
   설정 제거 → 소스 동기화(`git clone`/`git fetch origin main` + `git reset --hard <배포 SHA>`, Compose 파일 용도).
   서버 Git이 2.25라 `GIT_CONFIG_COUNT/KEY/VALUE`(2.31+)는 무시된다(Radar 첫 배포 실패 원인). 호환되는 `GIT_ASKPASS`를 쓴다.
   토큰은 환경변수(`GIT_TOKEN`)로만 임시 askpass helper에 전달되고 helper 파일, gitconfig, remote URL, git 명령행(`ps`)에 남지 않는다.
   `GIT_TERMINAL_PROMPT=0` + `git -c credential.helper=`로 프롬프트/저장을 막고, 인증 실패 시 pull/up 이전에 중단하며
   helper는 종료 시(실패 포함) 삭제된다. (정리 단계에서 만료된 이전 설정 키 이름이 명령행에 한 번 나타나지만 현재 토큰은 아니다.)
2. 공유 DB **사전 검사**: `docker-compose.db.yml`의 `db` 컨테이너 ID·`StartedAt` 기록, healthy 확인, `pg_isready`. 하나라도 실패하면 pull 전에 중단.
3. **pull** (임시 `DOCKER_CONFIG`로 GHCR 로그인, 종료 시 삭제). 실패하면 여기서 종료하며 기존 컨테이너는 그대로다.
4. **롤백 snapshot** (아래 표). 보존에 실패하면 컨테이너 교체 전에 중단한다.
5. `docker compose up -d --no-build --no-deps bot` + **준비 확인**(아래).
6. 성공: 공유 DB 사후 검사 → 배포 기록(`/home/ubuntu/.shookie-deploy-state`, 비밀 없음) → 오래된 이미지 정리.
   실패: 로그 요약 출력 → snapshot으로 자동 롤백 → 공유 DB 사후 검사 → **workflow는 실패로 종료**.

`docker compose down`, `docker compose build`, `docker builder prune`, 전역 `docker image prune`은 더 이상 쓰지 않는다
(Radar가 같은 Docker 호스트를 쓰므로 전역 prune/builder prune은 Radar 캐시/이미지에도 영향을 준다).

### bot 준비(readiness) 확인

bot은 HTTP health endpoint가 없다. 코드(`shookie/src/index.ts`) 조사 결과:

- `await app.start()`는 Socket Mode `Connected`까지 기다린 뒤 resolve되고, 그 직후 `슈키가 시작되었습니다! 🚀`(INFO)를 로그로 남긴다.
- 부팅 실패(설정/DB 마이그레이션/Slack 인증 실패 등)는 `부팅 실패` 로그 후 `process.exit(1)`이며, `restart: always` 때문에
  컨테이너는 crash loop로 계속 `running`↔`restarting`을 오간다. 즉 `State.Running=true`만으로는 성공을 판단할 수 없다.

앱 코드를 바꾸지 않고 다음을 모두 요구한다(최대 5초 × 36회 = 3분):

1. 새 컨테이너가 `running` 이고 `RestartCount=0`
2. `docker logs`에 시작 로그(`슈키가 시작되었습니다`) 존재 — Socket Mode 연결 완료 신호
3. 그 후 10초 동안 같은 기동(`StartedAt`)이 유지되고 재시작이 없음(ready 직후 crash 감지)

한계: 로그 문구와 `LOG_LEVEL`에 의존한다(배포가 `LOG_LEVEL=debug`로 고정; warn/error로 바꾸면 시작 로그가 숨겨져 배포가 실패로 판정된다).
시작 로그 문구를 바꾸면 `deploy.yml`의 `READY_MARKER`도 함께 바꿔야 한다. 이후 Socket Mode가 끊기는 런타임 장애는 이 검사 범위 밖이다.

### 롤백 snapshot

교체 직전 현재 bot 이미지를 **image ID**로 고정한다(`shookie-rollback/bot:<id>` 로컬 태그). 태그가 같은 ID인지 검증한 뒤에만
포인터 파일(`/home/ubuntu/.shookie-rollback-snapshot`)에 게시하며, 어느 단계든 실패하면 새 태그를 지우고 **컨테이너 교체 전에 중단**한다
(기존 snapshot과 포인터는 그대로). 첫 전환 배포의 로컬 빌드 이미지(`shookie-bot`)도 image ID로 보존된다.

| 현재 상태 | 처리 |
| --- | --- |
| bot 컨테이너가 안정적으로 실행 중 | snapshot 생성 후 교체 |
| 위 상태에서 inspect/tag/검증/게시 실패 | **교체 전 중단** |
| bot 컨테이너 없음 (최초 배포) | snapshot 없이 진행, 실패해도 롤백 불가 |
| 이미 비정상(crash loop 등) | snapshot 없이 진행(깨진 버전을 보존하지 않음), 롤백 불가. 수정본으로 앞으로 가는 수밖에 없다 |
| 상태 조회(`docker inspect`) 자체가 실패 | **교체 전 중단**. 조회 오류는 "비정상"이 아니다(정상일 수 있는 bot을 snapshot 없이 교체하지 않는다) |

"안정적으로 실행 중"은 10초 간격의 두 샘플에서 `running`이고 `StartedAt`/`RestartCount`가 같은 것이다. 안정성 확인 함수는 안정(0) / 조회는 됐지만 불안정(1) /
조회 실패(2)를 구분해 반환하며, 준비 확인(`wait_ready`)은 1과 2를 모두 실패로 취급한다.
자동 롤백은 **이번 실행에서 게시한 snapshot**만 사용한다(포인터에 남은 예전 이미지는 쓰지 않는다). 롤백도 위 준비 확인을 통과해야 성공으로 보고하며,
성공 여부와 무관하게 이 배포는 실패로 끝난다. 롤백이 성공하면 실패한 새 이미지 태그는 정리한다.

## 롤백

- 자동: 위 6번.
- 수동: Actions → **Deploy to EC2** → Run workflow(main) → `rollback_sha`에 되돌릴 커밋 SHA(12~40자, 소문자 hex).
  빌드 없이 GHCR의 해당 이미지를 pull해 배포한다. 이미지가 없으면 pull 단계에서 실패하고 기존 앱은 유지된다.
  수동 롤백도 같은 snapshot/준비 확인/DB 검사를 거친다. Compose 파일은 현재 main 기준이다.
- 한계: 새 버전이 시작 시 DB 마이그레이션을 이미 적용했다면(`runMigrations`는 User OAuth 또는 회의 알림이 켜져 있을 때 실행)
  이전 이미지가 스키마와 맞지 않을 수 있다. 롤백은 앱 이미지만 되돌리고 **DB는 되돌리지 않는다**.
  호환되지 않으면 임의로 DB를 건드리지 말고 별도 복구 계획과 백업 승인을 받는다([database-lifecycle.md](database-lifecycle.md)).

## 공유 PostgreSQL 불변 검사

workflow는 `docker compose -f docker-compose.db.yml ps -q db` / `exec -T db pg_isready` / `docker inspect`만 DB에 대해 실행한다.

- 배포 전: 컨테이너 존재, healthy, `pg_isready`(없거나 비정상이면 pull 전에 중단)
- 배포 후(성공·실패·롤백 후 모두): 컨테이너 ID와 `StartedAt`이 배포 전과 같고, healthy이며, `pg_isready` 통과.
  달라지면 이 배포는 실패다(성공 기록과 이미지 정리도 하지 않는다).
- `-f docker-compose.db.yml`은 `COMPOSE_FILE`보다 우선하므로 bot용 override와 섞이지 않는다.
- 어느 경로에서도 `down`, DB 서비스 `up`/`restart`/`stop`, `volume`, `network`, 전역 prune을 실행하지 않는다(테스트가 모든 docker 호출을 감시한다).

## 동시 실행 / 오래된 배포 방지

- build job: ref별 `cancel-in-progress: true`. SHA 태그라 취소해도 안전하다.
- deploy job: 별도 그룹 `deploy-ec2`, **`cancel-in-progress: false`**. 진행 중 SSH 배포를 취소하면 교체 도중 세션이 끊길 수 있다.
  대기 실행은 최신 1개만 남는다. (이전 workflow는 `cancel-in-progress: true`였다.)
- 대기하던 실행은 시작 시 자신의 커밋이 main HEAD인지 확인하고 아니면 건너뛴다(오래된 이미지로 덮어쓰지 않음). `rollback_sha`는 예외.
- EC2 `flock`으로 호스트 단위 동시 배포를 막는다(같은 호스트에서 수동 작업과 겹치지 않도록 같은 락 파일을 쓰면 된다).

## 이미지 / snapshot 보존 정책

- 이 저장소의 `ghcr.io/yourssu/shookie:sha-<12자>` 태그만 정리한다. **성공한 배포 이력**(`/home/ubuntu/.shookie-deploy-history`) 기준
  최근 3개(중복 제외)를 유지하고 나머지 sha 태그(이력에 없는 pull-only 이미지 포함)를 제거한다. 이력 파일은 이미지별 마지막 성공 순서로
  중복을 제거해 최대 20개만 저장하므로, 같은 SHA를 반복 배포해도 이전의 서로 다른 성공 이미지(예: 롤백 대상)가 밀려나지 않는다.
  이력 갱신에 실패하면 이미지 정리는 건너뛴다. 사용 중인 이미지는 `docker rmi`가 거부한다.
  (`docker image ls` 정렬은 이미지 생성 시각이라 캐시/메타데이터 전용 빌드에서 불확실해 쓰지 않는다. 실제 Docker로 확인했다.)
- snapshot은 방금 게시한 1개(`shookie-rollback/bot`)만 유지한다.
- Radar 이미지(`ghcr.io/yourssu/radar-*`), 다른 저장소 이미지, dangling 이미지, builder cache는 건드리지 않는다.
- 일회성 수동 정리(선택): 이전 방식으로 쌓인 로컬 빌드 이미지/캐시는 이 파이프라인이 자동으로 지우지 않는다. 디스크가 부족하면
  `docker system df`로 확인하고, **Radar 이미지를 포함한 전역 prune이 되지 않도록** 대상을 지정해 정리한다. 첫 전환 snapshot이 로컬 이미지를 참조하므로
  첫 성공 배포 후 다음 성공 배포까지는 지우지 않는다.

## 필요한 설정

신규 필수 secret/variable은 없다. 레지스트리는 GHCR이며 기존 `GITHUB_TOKEN`을 쓴다.

- `GITHUB_TOKEN` 권한은 workflow의 `permissions`로만 선언한다(workflow 기본 `contents: read`; build job `packages: write`;
  deploy job `packages: read`). 저장소 기본 workflow 권한 변경은 필요 없다. `GITHUB_TOKEN`은 git fetch(`contents: read`),
  main HEAD 조회(`gh api`), GHCR pull(`packages: read`)에 쓰이며 배포 중에만 유효하다.
- 기존 secrets/vars는 모두 그대로다: `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `LLM_API_KEY`,
  `POSTHOG_API_KEY`, `GITHUB`, `POSTGRES_PASSWORD`, `SLACK_CLIENT_ID/SECRET`, `SLACK_TOKEN_ENCRYPTION_KEY`, `SHOOKIE_*_API_KEY` 및 `SLACK_*`/`RADAR_*` variables.
  `LLM_BASE_URL`/`LLM_MODEL`/`THREAD_WORKSPACE_*`/`LOG_LEVEL`은 이전과 같이 스크립트에 고정되어 있다. 새 환경변수를 `docker-compose.yml`에 추가하면
  workflow의 `DEPLOY_*` env/envs/export에도 추가해야 하며 계약 테스트가 이를 검사한다.
- 패키지는 **private** 유지. 첫 푸시로 생성되는 패키지가 저장소 접근을 상속받아야 EC2 pull이 된다.
  **첫 배포 전 확인:** 패키지 설정에서 저장소 `yourssu/shookie`가 연결(Actions access)돼 있는지, 조직 정책이 Actions의 패키지 게시를 막지 않는지.
- 위 상속이 안 되는 경우의 대체(선택): `read:packages` 권한의 PAT(machine user)를 Actions secret `GHCR_PULL_TOKEN`, 소유자 이름을 variable
  `GHCR_PULL_USER`로 등록한다. 둘이 있으면 우선 사용하고 없으면 `GITHUB_TOKEN`으로 fallback한다(Radar와 동일).
- EC2 요구사항: Docker + Compose v2, `git`, `flock`, `awk`/`sort`/GNU `xargs`, GHCR(443) 아웃바운드, `/home/ubuntu/shookie` 체크아웃(없으면 자동 clone).
  (`curl`은 더 이상 필요 없다.)

## 첫 배포(전환) 체크리스트

1. 위 "첫 배포 전 확인"(패키지 연결/조직 정책)을 확인한다. 값은 workflow 로그에 출력되지 않는다.
2. main 머지 후 Actions의 build → arm64 검증 → deploy를 확인한다. 기존 bot은 로컬 빌드 이미지(`shookie-bot`)로 돌고 있으므로 첫 전환 때
   그 이미지가 image ID로 snapshot된다(교체 후 새 이미지가 준비되지 않으면 그 이미지로 자동 복귀).
3. 배포 로그에서 `Shookie bot is ready`와 DB 사후 검사 통과를 확인한다. 이후 [database-lifecycle.md](database-lifecycle.md)의 Shookie/Radar 연결 확인을 수행한다.

## 무중단이 아니다

단일 Compose 컨테이너를 교체하므로 bot 재기동 동안 요청이 처리되지 않는다(Socket Mode 재연결 포함). 이전 방식(서버 빌드)보다 중단 시간은 크게 줄지만 무중단은 아니다.
`restart: always`로 서버 재부팅 시에는 로컬에 있는 현재 이미지로 다시 뜬다.

## 로컬 개발

`docker compose up --build`는 이전처럼 소스에서 빌드한다(이미지 이름 `shookie-bot:local`). **운영 서버에서 override 없이 `docker compose up`을 실행하면
서버에서 빌드가 시작된다.** 서버에서 수동 조작이 필요하면 `COMPOSE_FILE=docker-compose.yml:docker-compose.deploy.yml`과 `SHOOKIE_BOT_IMAGE`를 지정하고
`up -d --no-build --no-deps bot`을 쓴다.

## 검증 (이 PR)

자동 테스트(`yarn workspace shookie test`, `shookie/src/deployment/*.test.ts`)는 workflow의 실제 EC2 스크립트를 추출해 mock docker/git으로 실행한다:
정상 / pull 실패 / snapshot inspect·tag 실패(교체 전 중단) / 교체 실패 / 준비 실패(미준비·crash loop·ready 직후 재시작)와 snapshot 롤백 /
롤백 실패 / 첫 로컬 이미지 전환 / 최초 배포 / 이미 비정상 / DB 없음·unhealthy·`pg_isready` 실패·DB 교체 감지 / 금지된 docker 명령 부재 /
secret 특수문자 literal 전달 / 잠금 / 임시 디렉터리 cleanup / real git + HTTP Basic 인증(clone·fetch·실패 전파·토큰 비잔존). 수동 보조 스크립트:

- `bash shookie/src/deployment/old-host-check.sh` — ubuntu:20.04(**Git 2.25.1**, 실제 `flock`)에서 실제 배포 스크립트 실행.
  `GIT_CONFIG_COUNT` 방식이 거부됨을 negative control로 확인하고, 특수문자 토큰 clone/fetch, 실패 전파, 토큰 비잔존, 락을 검증한다.
- `bash shookie/src/deployment/real-docker-check.sh` — 실제 Docker/Compose에서 고유 이름의 샌드박스(DB 복제본 포함)로 첫 배포, 교체+snapshot,
  crash loop 롤백, never-ready 롤백, pull 실패, DB 불변, 금지 명령 부재를 확인한다. 실제 Shookie/Radar 리소스는 건드리지 않는다.

**검증하지 못한 것(첫 main 배포에서 처음 실행):** 실제 GHCR 푸시/pull(권한, 패키지 연결), 실제 `appleboy/ssh-action` SSH 전달, 운영 EC2의
Docker 28.1.1/Compose 2.35.1 동작(로컬은 Docker 29.4/Compose v5), 실제 Slack Socket Mode 연결 후 시작 로그(자격증명 없이 이미지는 arm64로 빌드·기동되고
Slack 인증 실패 시 `부팅 실패`와 exit 1임을 확인), QEMU arm64 빌드 소요 시간.
