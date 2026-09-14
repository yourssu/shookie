# Slack 멘션 그룹 배포·E2E·전환 런북

이 문서는 SPR-127~SPR-131의 배포 계약과 운영 승인 게이트를 한곳에 모은다. 기능은 기본적으로 꺼져 있으며, 이 문서의 실워크스페이스 게이트가 모두 통과하기 전에는 `SLACK_MENTION_GROUP_REPLACEMENT_ENABLED`를 운영에서 `true`로 바꾸거나 기존 mention-bot을 중단하지 않는다.

## 검증 기준선

| 구성요소 | 기준 변경 | 핵심 계약 |
|---|---|---|
| Shookie 사용자 OAuth | [PR #53](https://github.com/yourssu/shookie/pull/53), `ccb8c5e` | User Token scope는 `chat:write` 하나뿐이며, state는 일회성이고 토큰은 AES-256-GCM 암호문으로 PostgreSQL에 저장한다. |
| Shookie 멘션 치환 | [PR #54](https://github.com/yourssu/shookie/pull/54), `bbec717` | 작성자 User Token의 `chat.update`로 같은 `channel`/`ts`를 수정하며 실패 시 원문을 보존한다. |
| Radar Backend | [PR #32](https://github.com/yourssu/radar-backend/pull/32), `8ca6a61` | `GET /internal/v1/mention-groups`, `X-Radar-Internal-Key`, revision/ETag 계약을 제공한다. |
| Radar Frontend | [PR #15](https://github.com/yourssu/radar-frontend/pull/15), `1545e28` | 그룹·별칭·멤버·활성 상태 변경 UI를 제공한다. |
| 기존 mention-bot | `yourssu/mention-bot` `15e14b5` | Socket Mode 메시지를 받아 작성자 토큰으로 원문을 수정하지만 토큰과 그룹 데이터는 호스트 메모리/파일에 의존한다. |

PR 번호나 커밋이 달라졌다면 배포 전에 실제 head와 API 스키마를 다시 비교한다. Shookie PR #54는 #53 위에 쌓인 PR이므로 OAuth 변경 없이 단독 배포하면 안 된다.

## 자동 검증 범위와 한계

```bash
yarn install --immutable
yarn workspace database build
yarn workspace shookie build
yarn workspace shookie test:e2e:mention-groups
yarn workspace shookie test
docker compose config
```

`test:e2e:mention-groups`는 로컬 HTTP 테스트 대역으로 Radar 응답/ETag를 제공하고 실제 Shookie 파서, 캐시, 서비스 흐름을 함께 실행한다. 공개 채널 본문, 비공개 채널 스레드 답글, 복수 그룹, 별칭, 중복 멤버 제거, 알 수 없거나 비활성이라 카탈로그에 없는 그룹, revision 갱신, 영구 삭제 후 빈 catalog, handle/별칭 재사용, 만료 캐시 재검증 실패, 미인증 원문 보존, OAuth 후 재처리, 폐기 토큰 무효화와 재인증 후 재처리를 검증한다.

이 테스트는 `GET /internal/v1/mention-groups`의 HTTP 계약을 모사하는 mock 계약 검증이지 Radar Spring 앱과 DB를 실행하는 Backend E2E가 아니다. Backend 실제 API 검증은 Radar Backend 저장소의 통합 테스트로 `DELETE /api/mention-groups/{id}/permanent?revision=N` 이후 내부 catalog을 직접 대조하고, Shookie PR에서는 그 결과를 mock 결과와 구분해 기록한다.

전체 테스트는 여기에 일회성 state, team/user 일치, `chat:write` 단일 scope, AES-256-GCM, 재시작 뒤 암호문 재사용, 회전 CAS, 폐기, 이벤트 중복/편집/봇 필터, 응답 크기·스키마·ETag 실패, 로그 마스킹을 추가로 검증한다. 이 테스트는 Slack API를 모사하므로 실제 Slack 작성자 표시와 알림 전달을 증명하지 않는다.

PostgreSQL 마이그레이션은 Shookie가 User OAuth 활성 상태로 부팅될 때 advisory lock, checksum, 트랜잭션을 사용해 실행한다. Compose의 `/docker-entrypoint-initdb.d` 마운트는 빈 볼륨 초기화용일 뿐이므로 기존 볼륨에서는 반드시 `DB 마이그레이션 완료` 로그 또는 `schema_migrations`의 `004_add_slack_user_oauth.sql`, `005_harden_slack_user_oauth.sql` 행을 확인한다.

### 2026-08-28 로컬 실행 증거

| 대상 | 결과 |
|---|---|
| Shookie immutable install, database/shookie TypeScript build | PASS; 기존 peer dependency 경고만 있음 |
| Shookie 전체 Vitest | PASS, 19 files / 143 tests |
| Shookie 로컬 멘션 계약 E2E | PASS, 2 tests |
| Compose config / Shookie Docker image build | PASS |
| 격리 PostgreSQL migration | 최초 001~005 적용, 두 번째 실행 0건, OAuth 두 제약조건 확인 |
| Radar Backend PR #32 mention package + `bootJar` (Temurin 21) | PASS |
| Radar Frontend PR #15 test/lint/build | PASS, 4 files / 15 tests; 899 kB bundle size warning 있음 |
| 실제 Slack/Radar E2E | NOT RUN; 아래 자격증명·관리 권한 blocker |

Radar Backend 전체 `test build`는 118 tests 중 3 failures, 24 skipped로 red다. 실패는 `DailyStatRollupServiceTest` 2건과 `BackfillRunnerTest` 1건이며 PR #32가 수정하지 않은 Slack 통계/백필 경로지만, 전체 suite가 green이라고 보고하지 않는다. Backend 담당자의 원인 확인 또는 명시적 waiver도 운영 전환 게이트다.

## 비밀값과 안전한 설정

실제 값은 저장소, PR, 이슈, 명령 이력, 로그에 넣지 않는다. GitHub Actions 배포는 아래 Secret/Variable을 원격 환경으로 전달하지만 두 기능 플래그는 값이 없을 때 `false`다.

### GitHub Secrets

| 이름 | 용도와 규칙 |
|---|---|
| `SLACK_BOT_TOKEN` | 기존 Shookie Bot Token (`xoxb-…`). |
| `SLACK_APP_TOKEN` | Socket Mode App-Level Token (`xapp-…`), `connections:write`만 부여한다. |
| `SLACK_CLIENT_ID` | 같은 Slack 앱의 OAuth client ID. 저장소에 평문으로 두지 않는다. |
| `SLACK_CLIENT_SECRET` | 같은 Slack 앱의 OAuth client secret. |
| `SLACK_TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32`로 생성한 정확히 32바이트 키. 기존 DB 토큰을 복호화하는 유일한 키이므로 일반 secret rotation처럼 즉시 교체하지 않는다. |
| `SHOOKIE_MENTION_GROUPS_API_KEY` | Radar와 공유하는 전용 내부 키. 예: `openssl rand -hex 32`; Slack/DB/기타 API 키와 재사용하지 않는다. |
| `POSTGRES_PASSWORD` | 기존 Shookie PostgreSQL 암호. |

### GitHub Variables

| 이름 | 준비 값 | 안전한 초기값 |
|---|---|---|
| `SLACK_OAUTH_REDIRECT_URI` | `https://<운영 호스트>/slack/user-oauth/callback` | 값은 준비하되 OAuth가 준비될 때까지 플래그를 끈다. query/fragment를 넣지 않는다. |
| `RADAR_MENTION_GROUPS_API_URL` | `https://<Radar 내부 호스트>/internal/v1/mention-groups` | 값은 준비하되 치환 플래그를 끈다. |
| `SLACK_USER_OAUTH_ENABLED` | OAuth 서버와 DB migration 활성화 | `false` |
| `SLACK_MENTION_GROUP_REPLACEMENT_ENABLED` | 메시지 이벤트 처리 활성화 | `false` |
| `SLACK_TOKEN_ROTATION_ENABLED` | Slack 앱의 Token Rotation 설정과 정확히 일치 | `false` |
| `SLACK_USER_OAUTH_PORT` | loopback callback 포트 | `3000` |
| `SLACK_OAUTH_STATE_TTL_SECONDS` | OAuth state 수명, 60~900초 | `600` |
| `RADAR_MENTION_GROUPS_CACHE_TTL_SECONDS` | Radar 캐시 수명, 1~300초 | `30` |
| `RADAR_MENTION_GROUPS_REQUEST_TIMEOUT_MS` | Radar 요청 제한, 250~10000ms | `3000` |

현재 구현은 32바이트 난수 state의 SHA-256 해시만 PostgreSQL에 저장하고 원자적으로 한 번 소비하므로 별도 `SLACK_OAUTH_STATE_SECRET`이 없다. 현재 Slack 이벤트는 Socket Mode로 수신하므로 `SLACK_SIGNING_SECRET`도 코드에서 사용하지 않는다. 나중에 HTTP Events API, slash command, action receiver를 추가한다면 그때 signing secret을 별도 Secret으로 주입하고 [Slack 요청 서명 검증](https://docs.slack.dev/authentication/verifying-requests-from-slack/)을 구현해야 한다.

### OAuth callback 프록시 예시

Compose는 callback 포트를 `127.0.0.1`에만 바인딩한다. 외부에는 아래처럼 정확한 HTTPS 경로만 노출하고, `code`와 `state`가 든 query를 access/error/APM 로그에 남기지 않는다.

```nginx
log_format shookie_oauth_safe
  '$remote_addr - $request_method $uri $server_protocol $status $body_bytes_sent';

server {
  listen 443 ssl;
  server_name shookie.example.com;

  location = /slack/user-oauth/callback {
    access_log /var/log/nginx/shookie-oauth.access.log shookie_oauth_safe;
    error_log /var/log/nginx/shookie-oauth.error.log warn;

    limit_except GET { deny all; }
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

이 location이나 상위 프록시/APM에서 `$request`, `$request_uri`, `$args`, `Authorization`, cookie, 응답 본문을 기록하지 않는다. 방화벽에서는 3000 포트를 외부에 열지 않는다. Slack은 authorize와 token 교환에 동일한 redirect URI를 요구하므로 [OAuth 설정](https://docs.slack.dev/authentication/installing-with-oauth/)의 Redirect URL과 `SLACK_OAUTH_REDIRECT_URI`를 문자 단위로 일치시킨다.

## Slack 앱 설정

기존 앱 설정을 내보내 백업한 뒤 다음 항목을 **추가**한다. 아래 목록만으로 앱 manifest 전체를 덮어쓰면 기존 Shookie 기능의 scope/event가 사라질 수 있다.

1. Socket Mode를 유지한다. App-Level Token에는 `connections:write`만 둔다. Socket Mode는 공개 Events API Request URL을 요구하지 않는다. ([Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/))
2. OAuth Redirect URL에 `SLACK_OAUTH_REDIRECT_URI`와 같은 HTTPS URL을 정확히 한 개 등록한다.
3. User Token Scopes는 `chat:write`만 추가한다. 설치 화면과 OAuth 응답에서도 사용자 scope 집합이 정확히 `chat:write`인지 확인한다.
4. Bot Token Scopes에는 기존 scope를 유지하고 `channels:history`, `groups:history`가 없으면 추가한다. `chat:write`는 기존 ephemeral 안내에 필요하다.
5. Bot Events에는 기존 event를 유지하고 `message.channels`, `message.groups`를 추가한다. 공개/비공개 대상 채널에 앱이 실제로 들어가 있어야 한다. ([message.channels](https://docs.slack.dev/reference/events/message.channels), [message.groups](https://docs.slack.dev/reference/events/message.groups))
6. scope/event 변경 뒤 앱을 테스트 워크스페이스에 다시 설치한다. 관리자 승인 화면과 설치 결과를 증거로 남긴다.

`chat.update`는 인증된 사용자가 쓴 메시지만 수정할 수 있고 Shookie는 같은 `channel`과 `ts`를 사용한다. 4,000자를 넘는 결과와 `cant_update_message` 등의 실패는 원문 보존 경로로 처리한다. ([chat.update](https://docs.slack.dev/reference/methods/chat.update/))

Token Rotation은 켠 뒤 끌 수 없고 access token 수명과 일회용 refresh token 운영이 추가된다. 운영 앱에서 바로 켜지 말고 별도 테스트 앱에서 최소 한 번 실제 자동 refresh와 재시작을 관찰한 뒤 `SLACK_TOKEN_ROTATION_ENABLED=true`와 Slack 앱 설정을 같은 변경 창에 적용한다. ([Token Rotation](https://docs.slack.dev/authentication/using-token-rotation/))

## Radar 내부 인증과 데이터 이관

Radar Backend와 Shookie에 같은 `SHOOKIE_MENTION_GROUPS_API_KEY`를 넣고 HTTPS 또는 신뢰된 사설망으로 제한한다. 외부 ingress에서 `/internal/v1/mention-groups`를 공개하지 말고 가능하면 Shookie 출발지 allowlist도 적용한다. `curl -v`, shell trace, 프록시 header 로그를 사용해 키를 출력하지 않는다.

현재 계약은 한 번에 키 하나만 받으므로 무중단 이중-key rotation을 지원하지 않는다. 키를 교체해야 하면 먼저 Shookie 치환 플래그를 끄고 배포한 뒤 Radar 키와 Shookie 키를 각각 교체·배포하고, 인증/ETag probe가 통과한 후 플래그를 다시 켠다.

### 비활성화와 영구 삭제

`DELETE /api/mention-groups/{id}?revision=N`는 기존 soft delete 계약으로 그룹을 **비활성화**할 뿐이다. 그룹과 변경 이력, primary handle, 별칭은 남아 있고 namespace를 계속 점유하므로 재활성화할 수는 있지만 다른 그룹에서 같은 이름을 재사용할 수는 없다.

`DELETE /api/mention-groups/{id}/permanent?revision=N`는 활성/비활성 그룹을 **영구 삭제**한다. 성공 시 본문 없는 HTTP 204를 반환하고 그룹, handle/별칭, 멤버, 전체 변경 이력을 제거하며 catalog revision을 증가시킨다. 삭제된 handle과 별칭은 다른 ID의 새 그룹에서 재사용할 수 있다. 가장 최근 그룹 응답의 `revision`을 전송하며 stale revision은 409, 없거나 이미 삭제된 ID는 404다. 영구 삭제는 이력도 되돌릴 수 없으므로 자동 retry하거나 운영 그룹에 테스트하지 않는다.

Shookie가 사용하는 `GET /internal/v1/mention-groups`의 `revision`/`groups`, `X-Radar-Internal-Key`, `ETag: "mention-groups-{revision}"` 및 304 계약은 변하지 않는다. 삭제 직후에는 기존 catalog가 `RADAR_MENTION_GROUPS_CACHE_TTL_SECONDS`(기본 30초)까지 사용될 수 있다. TTL 만료 후 재검증에서 증가한 revision/새 ETag를 받으면 삭제된 그룹이 catalog에서 사라지고, 마지막 그룹이었다면 `groups: []`를 정상적으로 캐시한다. 재검증이 실패하면 만료한 기존 멤버로 치환하지 않고 새 메시지 원문을 보존한다.

Shookie는 catalog 갱신 이전에 이미 전송·편집한 Slack 메시지를 소급해 다시 쓰지 않는다. OAuth 대기 메시지는 callback 뒤 현재 원문과 catalog를 다시 읽지만 callback 자체가 캐시를 강제 무효화하지는 않는다. 따라서 삭제 전에 OAuth를 시작한 메시지에 새 catalog를 반영했는지 검증할 때도 삭제 후 TTL과 작은 여유를 지난 뒤 재처리한다.

기존 mention-bot에는 다음 정적 handle과 각 `-all`, `-non-active` 변형이 있다.

```text
be, fe, android, ios, design, pm, marketing, hr, finance,
lead, vicelead, legal
```

접미사 그룹은 멤버 집합이 다르므로 alias로 합치지 않고 12 × 3 = 36개의 독립 Radar primary handle로 만든다. 예를 들어 `be`, `be-all`, `be-non-active`는 별도 그룹이며 세 그룹 자체는 모두 `active=true`여야 한다. 여기서 `non-active`는 멤버의 기존 재직 상태 의미이고 Radar 그룹 비활성 상태가 아니다.

### 데이터 bootstrap 절차

Radar V5 migration은 스키마만 만들며 seed data를 넣지 않는다. 아래 절차를 완료하지 않은 빈 Radar를 연결하면 Shookie는 모든 기존 handle을 알 수 없는 그룹으로 취급한다.

1. 기존 mention-bot의 custom group 수정과 멤버 원천인 Notion POSITION/STATUS 변경을 동결하고, 배포 중인 commit과 UTC 시각을 기록한다.
2. 고정된 기존 bot 환경에서 36개 정적 handle 각각을 기존 `querySlackMembersByMentionGroup` 경로로 실제 해석해 **Slack user ID만** export한다. 이 경로는 Notion 이름을 Slack 사용자명에 fuzzy match하므로 동명이인/부분 일치는 담당자가 원천 자료로 재검토한다.
3. 같은 호스트의 `db/customGroup.json`에서 key/name과 `memberSlackIds`만 export한다. `creatorSlackId`/시각은 Radar bootstrap 입력이 아니며, raw `member.json`은 Notion PII를 포함할 수 있으므로 복사·커밋·첨부하지 않는다.
4. [`mention-group-bootstrap.example.json`](mention-group-bootstrap.example.json)을 운영자가 접근 통제하는 저장소 밖 경로로 복사하고 실제 `frozenAt`, 36개 정적 그룹, 모든 custom 그룹을 채운다. handle의 선행 `@`는 제거한다. 실제 inventory는 이 Git 저장소에 커밋하지 않는다.
5. 다음 validator를 실행한다. 출력은 Slack ID 대신 집계와 파일 SHA-256만 보여 주며, 36개 정적 handle 누락/비활성, namespace 충돌, 중복 멤버, Radar 형식 위반을 거부한다.

   ```bash
   node scripts/validate-mention-group-bootstrap.mjs \
     /secure/path/mention-group-bootstrap.json \
     --require-legacy-parity
   ```

6. 기존 bot 운영자와 Radar 관리자가 같은 SHA-256, 그룹 수, handle별 멤버 수를 승인한다. custom group 이름이 Radar 예약어/형식과 충돌하거나 멤버가 Radar `slack_user`에 없거나 bot/deleted 사용자이면 임의로 누락하지 말고 이관 결정을 기록한다.
7. `RADAR_ALLOWED_EMAILS`에 명시된 관리자 계정으로 Radar Frontend에 로그인한다. 먼저 `GET /api/admin/mention-groups`로 기존 namespace가 비었거나 승인 inventory와 일치하는지 확인한다.
8. 없는 그룹은 `POST /api/admin/mention-groups`로 aliases와 초기 members를 원자적으로 생성한다. 이미 있는 그룹은 최신 응답의 `revision`을 사용해 metadata, members, status를 순서대로 reconcile한다. stale revision 409를 덮어쓰거나 병렬 import하지 않고 다시 조회·비교한다. 자동 DELETE/deactivate는 금지한다.
9. 각 mutation에 `X-Request-Id: spr131-bootstrap-<승인번호>-<handle>`을 넣고 응답/감사 history를 보존한다. 한 그룹을 API로 생성해야 할 때 JWT가 shell history/process argument에 들어가지 않도록 다음 패턴을 사용한다. request body에는 해당 inventory 항목의 `active`를 제외한 다섯 API 필드만 넣는다.

   ```bash
   set +x
   read -r -s -p 'Radar admin JWT: ' SPR131_RADAR_JWT
   printf '\n' >&2
   SPR131_GROUP_REQUEST=/secure/path/backend.request.json
   printf 'header = "Authorization: Bearer %s"\n' "$SPR131_RADAR_JWT" |
     curl --fail-with-body --silent --show-error --config - \
       --request POST \
       --url https://radar.example.com/api/admin/mention-groups \
       --header 'Content-Type: application/json' \
       --header 'X-Request-Id: spr131-bootstrap-approved-backend' \
       --data-binary "@$SPR131_GROUP_REQUEST"
   unset SPR131_RADAR_JWT
   ```

10. Admin list를 다시 export해 inventory와 handle/alias/member/active를 정렬 비교하고, history의 actor/request ID를 확인한다. 이어 내부 endpoint가 active 그룹만 반환하고 catalog revision/ETag가 존재하는지 확인한다. 이때도 Shookie 치환 플래그는 `false`로 둔다.
11. 별도 canary에서 36개 정적 handle과 모든 custom handle을 최소 한 번 해석한다. 승인된 결과와 다른 그룹이 하나라도 있으면 bootstrap을 실패로 보고 전환하지 않는다.

기존 정적 그룹은 Notion을 매 호출 시 5분 cache로 해석했지만 Radar 그룹은 명시적 member set이다. 전환 승인에는 이후 POSITION/STATUS 변경을 누가 어떤 SLA로 Radar에 반영할지 운영 소유자와 절차가 반드시 포함되어야 한다. 이를 정하지 않으면 시간이 지나며 멤버가 달라지는 것이 확정된 잔여 위험이다.

호스트의 `db/customGroup.json`에는 저장소에서 확인할 수 없는 사용자 정의 그룹이 있을 수 있다. 전환 승인 전 기존 호스트 담당자가 다음을 export하고 Radar와 대조해야 한다.

- 모든 정적/접미사/custom handle과 별칭
- 각 그룹의 Slack user ID 집합과 중복 제거 결과
- 활성/비활성 포함 규칙과 빈 그룹 처리
- Radar `revision`, 활성 group 수, handle별 멤버 수

이름이나 이메일로 추측해 멤버를 이관하지 않는다. Slack user ID 기준으로 비교하고, 개인정보가 든 원본 파일은 이슈/PR에 첨부하지 않는다. 불일치가 하나라도 있으면 전환하지 않는다.

## 실워크스페이스 E2E 승인 게이트

별도 테스트 워크스페이스가 최선이다. 운영 워크스페이스를 써야 하면 승인된 비공개 canary 채널에서 테스트 계정/그룹만 사용하고 기존 mention-bot을 그 채널에서 제거한 사실을 먼저 확인한다. 각 단계는 메시지 permalink, 작성자, `channel`, `ts`, 전후 본문, Radar revision, 관련 secret 없는 구조화 로그, 수신자 관찰 결과를 기록한다.

### 기본 동작

1. 테스트 작성자 A와 수신자 B/C를 준비하고 Radar에 활성 그룹, 별칭, 중복 멤버, 비활성 그룹을 만든다.
2. 공개 채널 본문에 고유 표식과 `@handle`을 쓴다. 같은 메시지가 수정되고 작성자 A, permalink, `channel`, `ts`가 그대로인지 확인한다.
3. 비공개 채널의 스레드 답글에서 같은 검증을 한다. 부모 메시지가 아니라 정확한 답글만 바뀌어야 한다.
4. `@alias`, 여러 그룹, 같은 사용자가 겹치는 그룹을 한 메시지에 쓴다. 각 Slack 멘션이 한 번만 생기고 일반 텍스트/코드/이미 생성된 `<@U…>`가 손상되지 않는지 확인한다.
5. 알 수 없는 handle과 비활성/빈 그룹은 원문에 남고 작성자에게만 안내되는지 확인한다.
6. bot 메시지와 Shookie가 만든 편집 event가 재처리되지 않는지 확인한다. 같은 `event_id` 재전달에도 `chat.update`가 한 번뿐이어야 한다.
7. Shookie를 재시작하고 이미 인증한 A의 다음 메시지가 OAuth prompt 없이 처리되는지 확인한다. DB에는 `v1:` envelope만 있고 `xox` 평문은 없어야 한다.

### OAuth, 폐기, 권한 실패

1. 인증 이력이 없는 작성자 D가 그룹을 쓰면 원문이 유지되고 `Slack 인증하기` 안내가 D에게만 보여야 한다.
2. 동의 화면의 User Token scope가 `chat:write` 하나인지 확인하고 완료한다. callback 뒤 **현재 저장된 원문**을 다시 읽어 동일 메시지만 수정해야 한다.
3. callback URL을 새 브라우저에서 다시 열어 state 재사용이 거부되는지 확인한다. 다른 team/user grant를 모사할 수 있는 테스트 앱에서는 주체 불일치가 저장되지 않고 grant가 폐기되는지도 확인한다.
4. 테스트 사용자의 토큰을 Slack에서 폐기한 뒤 새 그룹 메시지를 쓴다. 원문이 유지되고 재인증 안내가 나오며, 재인증 후 같은 메시지가 처리되는지 확인한다.
5. 앱이 들어가 있지 않은 비공개 채널, 수정 불가 메시지, 권한 부족을 각각 검증한다. 어떤 경우에도 bot 새 메시지로 원문을 복제하거나 원문 일부만 바꾸면 안 된다.

### Radar revision 무배포 반영

1. A의 `@handle`이 기존 멤버로 치환되는 것을 확인하고 로그의 revision을 기록한다.
2. Radar Frontend에서 같은 그룹의 멤버/별칭/활성 상태를 변경한다.
3. Backend 응답의 revision과 ETag가 증가했는지 확인한다.
4. `RADAR_MENTION_GROUPS_CACHE_TTL_SECONDS`에 작은 여유를 더해 기다린 뒤 Shookie를 재배포/재시작하지 않고 새 메시지를 쓴다.
5. 새 멤버 집합과 새 revision이 적용되는지 확인한다. Radar timeout, 401, 잘못된 schema도 원문 보존과 비밀값 없는 오류 코드로 관측되어야 한다.

### 영구 삭제·이름 재사용

1. 반드시 경로가 분리된 테스트 Radar/비공개 canary 채널의 일회성 그룹만 사용한다. 운영 그룹, 실사용자 멘션, 이력 보존이 필요한 그룹은 대상이 아니다.
2. soft delete를 먼저 검증한다. `DELETE /api/mention-groups/{id}?revision=N`이 비활성 응답을 반환하고, 이력이 남으며, handle/별칭 재사용이 충돌로 거부되는지 확인한 뒤 재활성화한다.
3. 최신 그룹 revision으로 `DELETE /api/mention-groups/{id}/permanent?revision=N`을 한 번만 호출해 204/빈 본문을 확인한다. 같은 ID의 상세·이력이 404고 catalog revision/ETag가 증가했는지 기록한다.
4. 캐시 TTL과 작은 여유를 기다린 뒤 새 메시지의 삭제된 primary handle와 별칭이 멤버 멘션으로 치환되지 않고 원문에 남는지 확인한다. 삭제 전에 이미 처리된 메시지의 본문, 작성자, permalink, `channel`, `ts`는 변하지 않아야 한다.
5. 그 그룹이 마지막이었다면 내부 API가 증가한 revision과 `groups: []`를 반환하고, Shookie가 빈 catalog를 장애로 취급하지 않는지 확인한다.
6. 같은 primary handle/별칭을 다른 ID와 다른 멤버로 재생성한다. 다시 TTL 후 새 메시지에서 새 멤버만 한 번씩 치환되고 삭제 전 멤버 ID가 없는지 확인한다.
7. 별도 메시지로 삭제 전 OAuth 대기 상태를 만들고, 영구 삭제·재생성과 TTL 경과 후 callback을 완료한다. 재처리가 현재 원문과 증가한 catalog revision을 사용해 새 멤버만 치환하는지 확인한다.
8. 격리 환경에서만 TTL 만료 후 내부 API를 503/timeout으로 만든다. 이전 catalog가 메모리에 있어도 새 메시지가 stale 멤버로 치환되지 않고 원문으로 남는지 확인한다.

### 실제 알림 결정 게이트

Slack 도움말은 메시지 편집으로 추가한 멘션은 알림을 보내지 않는다고 설명한다. ([Slack 멘션 도움말](https://slack.com/intl/en-gb/help/articles/205240127-Use-mentions-in-Slack-Use-mentions-in-Slack)) 반면 실제 사용자 경험과 다를 수 있으므로 어느 쪽도 전제로 삼지 않는다.

수신자 B/C가 해당 채널을 열어 두지 않은 상태와 모바일/데스크톱 환경에서 다음을 직접 관찰한다.

- 치환 뒤 Activity/Mentions 항목 생성 여부
- push, 데스크톱, 이메일 알림 여부와 지연
- 스레드 답글 멘션 알림 여부
- 중복 그룹에서 한 사용자에게 중복 알림이 생기는지
- Slack 클라이언트/워크스페이스 알림 설정과 테스트 시각

제품 요구사항이 “실제 알림 전달”이라면 적어도 한 명의 의도된 수신자에게 기대한 알림이 재현되고 담당자가 증거를 승인해야 PASS다. 편집된 멘션이 알림을 만들지 않으면 현재 `chat.update` 설계로는 요구사항을 충족하지 못하므로 전환을 중단하고 별도 제품/기술 결정을 연다.

## 배포 순서

1. 네 PR의 head와 API 계약을 다시 확인하고 Radar Backend → Radar Frontend → Shookie OAuth → Shookie 멘션 치환/이 런북 순으로 준비한다. 병합과 운영 배포는 각 저장소 담당 승인 후에만 한다.
2. PostgreSQL snapshot/backup과 Slack 앱 manifest export를 만든다. `SLACK_TOKEN_ENCRYPTION_KEY`는 별도 복구 경로에 백업한다.
3. 모든 Secret/Variable을 넣되 두 기능 플래그와 rotation은 `false`로 유지해 배포한다. 기존 Shookie 기능이 정상인지 확인한다.
4. callback HTTPS 경로와 Radar 내부 인증을 secret 노출 없이 확인한다.
5. `SLACK_USER_OAUTH_ENABLED=true`, 치환은 `false`로 배포한다. migration checksum/테이블과 OAuth server 부팅을 확인한다.
6. 격리된 test/canary에서 위 E2E를 실행한다. 기존 mention-bot과 Shookie가 같은 메시지를 동시에 보지 않아야 한다.
7. 데이터 parity, 알림 게이트, 보안 로그 검토, 롤백 리허설을 담당자가 서면 승인한다.
8. 승인된 변경 창에서만 기존 mention-bot을 먼저 중지하고 중지 증거를 확인한 뒤 `SLACK_MENTION_GROUP_REPLACEMENT_ENABLED=true`로 Shookie를 배포한다. 이 저장소 변경만으로 이 단계를 자동 실행하지 않는다.
9. canary 메시지 후 전체 대상 채널을 점진적으로 확인한다. 원문 보존 실패, 이중 수정, 재인증 급증, Radar 401/5xx, 알림 실패 중 하나라도 보이면 즉시 롤백한다.

기존 mention-bot은 전역 message listener이고 channel allowlist/기능 플래그가 없으므로 두 프로세스를 동시에 켜면 동일 원문에 두 writer가 경쟁할 수 있다. 격리되지 않은 “동시 canary”는 금지한다.

## 롤백

1. `SLACK_MENTION_GROUP_REPLACEMENT_ENABLED=false`로 Shookie를 먼저 배포하고 `Slack 멘션 그룹 원문 치환 활성화` 로그가 더 이상 없는지 확인한다.
2. Shookie가 더 이상 writer가 아님을 확인한 뒤에만 기존 mention-bot을 재시작한다. 둘을 동시에 켜지 않는다.
3. OAuth DB 행, migration, `SLACK_TOKEN_ENCRYPTION_KEY`는 유지한다. 코드 rollback을 위해 migration/테이블을 내리거나 pgdata를 삭제하지 않는다.
4. OAuth 자체가 문제면 `SLACK_USER_OAUTH_ENABLED=false`로 추가 배포하되 먼저 치환 플래그를 꺼야 한다. 저장된 토큰을 대량 폐기/삭제하려면 별도 승인과 사용자 공지가 필요하다.
5. Radar 키 문제면 치환 플래그를 끈 상태에서 두 서비스의 키를 맞추고 probe 후 재개한다.
6. Slack Token Rotation을 이미 켰다면 끌 수 없으므로 비회전 설정으로 되돌리지 않는다. refresh 장애를 복구하거나 새 설치/재인증 계획을 사용한다.

## 관측성과 중단 조건

대시보드/로그에서 최소한 다음 코드별 건수를 볼 수 있어야 한다: Radar cache revision 갱신, 치환 성공, authorization required, token revoked/expired, permission failure, Radar timeout/401/schema/ETag 오류, 중복 event 무시. 로그에는 access/refresh token, OAuth code/state, client secret, encryption key, Radar key, Authorization header, 원문 메시지 본문을 남기지 않는다.

다음 중 하나면 배포를 중단한다.

- 새 Secret/Variable이 비어 있거나 Slack 앱 설정과 rotation flag가 다름
- OAuth callback query가 프록시/APM 로그에 나타남
- DB migration checksum 불일치 또는 OAuth 테이블/제약 누락
- Radar 데이터 parity/active semantics 불일치
- 실제 알림 게이트 미통과
- 같은 메시지를 두 bot이 수정함
- 실패 시 원문/작성자/`ts`가 보존되지 않음

## 2026-08-28 현재 외부 blocker

로컬 환경과 GitHub 저장소에는 기존 Bot/App/Signing 자격증명만 있고, 새 User OAuth client ID/secret, 토큰 암호화 키, OAuth Redirect URL, Radar URL/내부 키가 준비되어 있지 않다. Slack 앱 관리자 권한, 공개 HTTPS callback 설정 권한, Radar 운영 권한, 실제 알림을 관찰할 테스트 사용자/채널도 이 작업에 제공되지 않았다.

또한 기존 mention-bot 운영 호스트의 `db/customGroup.json`, 실제 프로세스 중지 권한, 모든 handle/member parity 자료가 없다. 따라서 이 변경에서는 운영 Slack/Radar 설정, secret, 기존 bot, production flag를 변경하지 않았으며 실워크스페이스 E2E와 운영 전환 상태는 **BLOCKED / NOT APPROVED**다.
