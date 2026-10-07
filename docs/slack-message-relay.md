# Slack 공개 채널 메시지 메타데이터 → Radar 릴레이

Radar가 Slack 메시지 통계를 폴링 대신 이벤트로 받을 수 있도록, Shookie의 **기존 단일 Socket Mode 연결**에서 받은 공개 채널 `message` 이벤트의 **메타데이터만** PostgreSQL outbox에 저장한 뒤 Radar로 전달한다. 기본값은 **꺼짐**이다.

- Slack 앱 매니페스트, 토큰, 스코프 변경 **없음** (`message.channels` + `channels:history` 구독은 이미 존재).
- 새 Slack 연결, HTTP 수신기, 두 번째 Socket 리스너, 새 JVM/브로커 **없음**. 같은 Node 프로세스와 공유 PostgreSQL을 사용한다.
- Radar 폴링은 운영자가 `outbox → inbox → message → stats` 를 확인하고 명시적으로 전환하기 전까지 그대로 유지한다.

## 동작 순서와 ACK 계약

Bolt 4.7.2의 `App.processEvent`는 Events API 요청을 **전역 미들웨어(`ignoreSelf` 포함)와 `app.event` 리스너보다 먼저 ACK** 한다. 따라서 리스너에서 저장하면 ACK 이후라 유실될 수 있고 자기 봇 메시지는 `ignoreSelf`로 아예 보이지 않는다. 그래서 캡처는 `SocketModeReceiver`가 `app.processEvent`를 호출하는 **receiver → App 경계**에 둔다.

```
SocketModeClient 'slack_event'
  → SocketModeReceiver (기존 단일 리스너)
    → [캡처] 공개 채널 신규 메시지면 메타데이터를 outbox에 커밋   ← 실패 시 여기서 중단, ACK 없음
    → Bolt App.processEvent  (기존 그대로: ACK → ignoreSelf → 리스너)
```

- 구현: `shookie/src/slack/socket-mode-app.ts`가 `receiver.init`을 감싸 receiver에 `processEvent`만 가진 facade를 준다. Bolt 옵션(`ignoreSelf`, `authorize` 등), 리스너, 재연결 기본값은 바꾸지 않는다.
- 캡처 대상: 공개 채널(`channel_type=channel`)의 **새** 메시지, `subtype`이 없음/`bot_message`/`thread_broadcast`/`file_share`/`me_message`. 자기 봇 메시지도 포함한다(텍스트·멘션 요구 없음).
- 제외: DM/그룹 DM/비공개 채널, `message_changed`/`message_deleted`/`message_replied` 등, `app_mention`, 리액션 등 다른 이벤트. 이들은 원본 그대로 Bolt로 전달된다.
- `thread_broadcast`는 반드시 부모가 있는 답글이어야 한다: `thread_ts`가 없거나 `ts`와 같으면(정규화 시 `threadTs: null`) 백엔드 계약상 거부되므로 **outbox에 넣지 않고** 메타데이터 error 로그만 남긴다(Bolt 처리는 그대로 진행, ACK 정상).
- 원본 이벤트 객체는 수정하지 않는다. 멘션 그룹 치환, AI 핸들러, 리액션 릴레이, 행사 참석, 회의/사용자 OAuth, customRoutes는 영향이 없다. 릴레이는 해당 플래그와 독립이다.
- 저장 실패(DB 장애·락·타임아웃)는 **fail closed**: 오류를 던져 ACK하지 않는다(`processEventErrorHandler`가 `RelayCaptureError`는 항상 `false`). Slack이 같은 `event_id`로 재전송하면 `ON CONFLICT DO NOTHING`으로 중복 없이 처리된다.
- ACK 경로의 DB 작업은 모두 유한하다: 커넥션 획득 500ms, `lock_timeout` 500ms, `statement_timeout` 1s, 전체 2s. 트랜잭션 안에서 네트워크 호출은 없고 Radar HTTP는 ACK 경로에 절대 포함되지 않는다.

### 신원(app/team) 설정 오류는 조용히 흐르지 않는다

- **부팅 시 1회**(메시지별 조회 아님): 릴레이가 켜져 있으면 기존 봇 토큰으로 `auth.test`를 한 번 호출해 `team_id`가 `RADAR_SLACK_RELAY_TEAM_ID`와 같은지 확인하고, 다르거나 응답이 없거나 10초를 넘기면 **부팅 실패**한다. 이어서 같은 토큰의 봇에 `bots.info`를 한 번 호출해 `app_id`를 확인하며 다르면 **부팅 실패**한다(ID/토큰은 로그에 남기지 않음). 새 스코프/연결 없음.
- `bots.info`는 보통 `users:read`가 필요하고 스코프 변경은 금지이므로 호출이 거부되면 앱 ID는 "런타임 강제"로 남고(시작 로그에 `app: runtime-enforced`), 이 경우 **런타임에 fail closed**로 보호한다(검증 완료 전/후 모두 동일): 캡처 대상 공개 메시지의 `api_app_id`/`team_id`가 설정과 다르면 outbox에 넣지 않고 **ACK도 하지 않으며**(Bolt 처리도 보류) 60초마다 `신원(app/team) 불일치` error 로그(차단 건수 포함)를 남긴다. 잘못된 설정으로 스트림 전체가 조용히 ACK되어 Radar에 도달하지 않는 상황을 막기 위한 의도된 선택이며, 비대상 이벤트(DM, 멘션, 리액션 등)에는 영향이 없다. 로그를 보면 `RADAR_SLACK_RELAY_ENABLED=false`로 롤백하거나 ID를 고쳐 재배포한다.

### 한계 (절대 무손실을 약속하지 않음)

- **DB 장애 중에는 캡처 대상 공개 메시지의 Bolt 처리도 지연**된다(ACK하지 않으므로 Slack 재전송 대기). `app_mention`은 별도 이벤트라 영향이 없다. 이는 의도된 트레이드오프다.
- Slack의 ACK 대기/재시도 윈도우를 넘는 장시간 DB 장애, 프로세스 종료 중 도착, Slack 측 장애로 이벤트 자체가 오지 않는 경우는 outbox로 복구할 수 없다. 이런 구간은 **별도의 gap reconciliation**(Radar 측 `conversations.history` 백필/폴링 비교)이 필요하며 이 변경 범위가 아니다. 전환 전 Radar 폴링을 유지하는 이유다.
- 과거 이력 재생(backfill)은 이 기능에 포함되지 않는다.
- 프로세스 로컬 중복 제거(최근 20,000건)는 최적화일 뿐이고, 영속적인 중복 제거는 `UNIQUE (team_id, app_id, event_id)`가 보장한다.

## Radar API 계약 (backend와 동일)

`POST <RADAR_SLACK_RELAY_URL>` = `/internal/v1/slack/message-events`, 헤더 `X-Radar-Internal-Key: <전용 키>`, 본문은 정확히 다음 9개 키만:

```json
{"version":1,"teamId":"T…","appId":"A…","eventId":"Ev…","channelId":"C…","ts":"1700000000.000200",
 "threadTs":null,"userId":"U…","subtype":null}
```

- `ts`/`threadTs`는 `10자리.6자리`. 부모 메시지의 `thread_ts == ts`는 `threadTs: null`로 정규화, `threadTs <= ts`. `bot_message`는 유효한 `bot_id`가 있으면 `userId: null` 허용(bot_id는 전송하지 않음).
- 본문 텍스트, 파일, 블록, action token, Slack 토큰, 서명, 원본 payload는 DB와 로그 어디에도 저장하지 않는다.
- 2xx는 Radar가 **내구성 있게 커밋한 뒤**에만 반환되어야 하며, 그때만 `delivered`로 표시한다. 그 외 응답/타임아웃/연결 끊김은 알 수 없는 결과로 보고 **같은 `eventId`** 로 재시도한다(Radar는 `eventId`로 멱등 처리).

### 전달 정책 (별도 drain, `shookie/src/slack/message-relay/drain.ts`)

| 응답 | 동작 |
| --- | --- |
| 2xx | `delivered` (메타데이터만 3일 보관 후 삭제) |
| 429 | `Retry-After`(초 또는 HTTP-date) **전체**를 durable 지연(시도 횟수 미차감, 줄이거나 조기 재시도하지 않음; 예: 172800초 → 최소 172800초 후). 헤더가 없으면 60초. 7일을 넘는 비정상 값은 **조기 재시도 없이** `parked(retry_after_excessive)` + error 로그 — 재시작해도 자동 재큐잉되지 않으며 운영자가 판단 |
| 408/425/5xx, 타임아웃, 네트워크 오류 | 지수 백오프(5s→최대 15분, 지터), 최대 15회 후 `failed`(30일 보관, 로그 error) |
| 401/403/404/405, 3xx(리다이렉트는 따라가지 않음) | 설정 오류: 해당 행을 `parked`, drain **중지**(무한 재시도 없음), 10분마다 error 로그. 키/URL 수정 후 **재시작하면 parked 행이 자동 재큐잉** |
| 그 외 4xx | 계약 위반: `failed`로 즉시 보관 |

- 배치 20건, 동시 HTTP 3개, 요청 타임아웃 5초, 클레임 lease 120초(크래시/outcome 기록 타임아웃 시 lease 만료로 같은 eventId 재전송), `FOR UPDATE SKIP LOCKED`로 동시 클레임 방지, pending 행은 생성 시각과 예정된 재시도 시각 중 늦은 쪽 기준 3일이 지나면 `failed(expired)`(긴 Retry-After가 만료로 잘리지 않음).
- **drainer의 모든 DB 호출**(claim, 결과 기록, 정리, 통계, parked 복구)은 enqueue와 같은 방식으로 유한하다: 커넥션 획득 2s, `lock_timeout` 2s, `statement_timeout` 5s(정리·통계 15s), 전체 10s(20s). 초과 시 커넥션을 파기해 서버가 롤백하고 행은 `delivering`으로 남아 lease 만료 후 복구된다. `stop()`은 진행 중 HTTP를 abort하고 최대 30초만 기다리며, 초과하면 이후 DB 호출을 시작하지 않고 계속 종료한다.
- 종료 순서: Socket 앱 중지 → 진행 중 캡처 커밋 대기 → drainer 중지(진행 중 HTTP abort, 미전송 행 반환) → 풀 종료. 풀 종료 후에는 쓰기가 없다.

## 환경변수

| 이름 | 설명 |
| --- | --- |
| `RADAR_SLACK_RELAY_ENABLED` | 기본 `false`. `true`일 때만 캡처와 drain 시작 |
| `RADAR_SLACK_RELAY_URL` | `https://<Radar 내부 호스트>/internal/v1/slack/message-events`. HTTPS 또는 `localhost`/`127.0.0.1`/`[::1]` HTTP만 허용, 자격증명/쿼리/프래그먼트 금지 |
| `RADAR_SLACK_RELAY_APP_ID` | 인증된 Socket Mode 앱 ID (`A…`). 이벤트의 `api_app_id`와 다르면 캡처하지 않고 error 로그 |
| `RADAR_SLACK_RELAY_TEAM_ID` | 워크스페이스 ID (`T…`). 이벤트의 `team_id`와 같아야 함 |
| `RADAR_SLACK_RELAY_INTERNAL_API_KEY` | Radar와 공유하는 **전용** 키(16~512자, 공백 없음). 멘션 그룹·행사 참석·회의 알림 키와 재사용 금지 |

앱/팀 ID는 고정 설정이며 메시지마다 Slack API로 조회하지 않는다. 활성화했는데 값이 빠졌거나 형식이 틀리면 **부팅 시 실패**한다.

`docker-compose.yml`과 `.github/workflows/deploy.yml`에 쌍으로 추가되어 있다: `vars.RADAR_SLACK_RELAY_ENABLED/URL/APP_ID/TEAM_ID`, `secrets.RADAR_SLACK_RELAY_INTERNAL_API_KEY`.

## 운영 절차 (backend 먼저, Shookie 나중)

1. Radar backend에 라우트와 같은 키(`RADAR_SLACK_RELAY_INTERNAL_API_KEY`)를 배포·검증한다(기본 disabled 상태 유지).
2. 키는 `openssl rand -hex 32`로 만들어 **GitHub Secret에만** 넣는다(채팅/로그/커밋 금지). 사용 중인 `curl -v`, shell trace로 키를 출력하지 않는다.
3. GitHub Variables에 URL/APP_ID/TEAM_ID를 넣고 `RADAR_SLACK_RELAY_ENABLED=false` 상태로 Shookie를 배포한다(마이그레이션 `008`이 outbox 테이블만 만든다. 기존 적용된 마이그레이션은 변경되지 않는다).
4. backend 준비 확인 후 `RADAR_SLACK_RELAY_ENABLED=true`로 바꿔 재배포한다. 시작 로그에 `Radar Slack 메시지 릴레이 활성화`가 나와야 한다.
5. Radar에서 `outbox → inbox → message → stats` 를 확인한다. 확인 후에만 Radar 폴링을 별도 단계로 끈다.
6. 롤백: `RADAR_SLACK_RELAY_ENABLED=false`로 재배포(새 캡처/전송 중지, 남은 outbox 행은 보관). 이전 이미지로 롤백해도 테이블은 무해하다.

### 상태 확인 (메타데이터만)

5분마다 `Slack 메시지 릴레이 outbox 상태` 로그에 상태별 건수가 찍힌다(`failed`/`parked`가 있으면 warn).

```sql
SELECT status, count(*), min(created_at) FROM slack_message_relay_outbox GROUP BY status;
SELECT event_id, status, attempts, last_status_code, last_error FROM slack_message_relay_outbox
 WHERE status IN ('failed','parked') ORDER BY updated_at DESC LIMIT 20;
```

`failed` 행을 다시 보내려면 계약 위반 원인을 고친 뒤 운영자가 `UPDATE … SET status='pending', attempts=0, next_attempt_at=now() WHERE status='failed'`를 수행한다(검토 후에만).

## 테스트

- 단위/SDK 순서: `yarn workspace shookie test` (`message-relay/*.test.ts`) — 실제 `SocketModeReceiver` + Bolt `App`에서 저장 → ACK → 리스너 순서, 실패 시 ACK 없음, 자기 봇 캡처, 비대상 이벤트 통과.
- 실제 PostgreSQL + HTTP stub (옵트인, 격리된 임시 DB를 만들고 지움):

  ```bash
  docker run -d --rm --name shookie-relay-it-pg -e POSTGRES_PASSWORD=itpass -p 127.0.0.1:55432:5432 postgres:16-alpine
  yarn workspace database build
  SHOOKIE_TEST_PG_ADMIN_URL=postgres://postgres:itpass@127.0.0.1:55432/postgres \
    yarn workspace shookie test src/slack/message-relay/outbox.pg.test.ts
  ```
