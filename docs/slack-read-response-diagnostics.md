# Slack thread/channel 읽기 실패 임시 안전 진단 (아카이브)

> **현재 코드: 임시 진단 제거됨.** 아래 로그 계약·reason 표·진단 전용 테스트와 운영 절차는 과거 이력이며 현재 emit 계약이 아니다. `read-diagnostics.ts` 및 pendingFailure/diagnosed/reason helper를 제거했다. 동일 unavailable/errorResult/throw/finally 흐름, response/message getter 접근 순서·횟수, thread API14/public15/history15·부모 dedup/count/root/budget/maxPages 가드는 유지한다. 실제 보안 로깅·SDK 차단·DB redaction은 제거 대상이 아니다.
>
> main의 PR103 독립 thread read는 실제 3페이지 complete PASS, PR105 기본 검색은 정직한 partial PASS다. **이 제거 코드의 배포 후 실제 재검증은 아직 미수행**이며 main이 새 검색 이벤트 및 독립 thread read의 출처와 도구 결과·임시 3종 emit 부재를 확인해야 한다. 모든 query pagination/20 matches/다른 requester E2E 성공으로 일반화하지 않는다. 기존 client/registered/handler/cancellation의 기능·getter·privacy 회귀는 유지한다.

[검색 충돌 진단과 실제 E2E FAIL 근거](slack-search-response-diagnostics.md)를 함께 참고한다. 이 변경은 **진단 전용**이다. 읽기 반환, 검증·권한·bot/event token·current channel·live membership·team/user·parser/limit/queue/cancel·cursor·redaction/provenance 정책을 변경하지 않는다.

## 로그 계약

기존 INFO logger에 `slack_read_response_diagnostic`를 **실패 호출당 최대 1개** 기록하며 성공/부분 성공/빈 channel 성공은 무로그다. 필드는 `kind` (`thread`/`channel` runtime allowlist), 고정 `stage`/`reason`, `correlationAvailable`, 선택적 `requestId`뿐이다. requestId는 검색과 같은 trusted identity WeakMap에서만 가져온다. 임의 context.get/모델 항목/fallback/새 hash는 사용하지 않는다. 로그가 없다는 사실은 성공 증명이 아니다.

로그 API는 response/error 객체나 동적 Zod path/code를 받지 않는다. 원본 오류 문구/API code, body/message/metadata/URL, team/user/channel/thread/message ID·ts, cursor/token/hash·부분값·길이·배열 크기·개수는 기록하지 않는다. logger에 새로 만든 고정 primitive 객체만 넘기고 모든 로거 예외를 삼킨다. logger throw가 기존 결과·finally cursor unlock·취소·출처를 방해하지 않는다. SDK/global debug, fallback, 환경변수, 모델, 의존성 변경 없음. 운영 공유 시 이 레코드와 검색/action-token 진단만 발췌하며 raw 응답·본문·query는 조회/복사/fixture/모델 입력/DB/파일에 추가하지 않는다.

## reason 해석

각 validation OR 체인을 기존 순서 그대로 분리하여 **처음 실패한 분기**만 기록한다. 동일 property access 횟수 및 short-circuit를 유지한다. 동시 다중 부적합의 전체 목록이 아니다. raw getter/Proxy/toJSON를 진단 때문에 추가 접근하지 않는다.

| stage | reason | 의미 |
|---|---|---|
| identity | identity_failed | 기존 trusted identity 확인 throw |
| input | input_failed | 기존 입력 schema 실패 또는 parser throw |
| target | target_failed | 기존 현재 채널/대상/permalink 파싱·검증 throw |
| cursor | cursor_invalid | 기존 binding/만료/페이지/동시사용 cursor preflight 실패 |
| authorization | authorization_failed | 기존 bot/team/channel/live requester membership 검증 throw |
| transport | api_call_failed | replies/history reject/throw. SDK 오류/취소 rejection도 포함; error를 새로 검사하지 않아 원인을 추측하지 않음 |
| api_check | check_failed | 기존 ok/error check throw. public access_denied/unsupported/rate_limited/invalid_target 분류는 그대로 |
| response | response_warning / metadata_warning | 기존 truthy warning 또는 metadata warnings length 조건 |
| response | messages_shape_invalid / result_limit_exceeded | 기존 messages 배열 확인 / pageSize 초과 |
| message | message_ts_invalid / message_text_invalid | 기존 strict timestamp / primitive text 검증 |
| message | message_channel_mismatch / message_team_mismatch | 명시적 scope가 target/trusted identity와 불일치 |
| message | message_thread_ts_invalid / message_user_invalid / message_bot_id_invalid | 기존 optional field 검증 실패 |
| thread | thread_parent_mismatch | non-root 메시지의 thread_ts가 요청 root와 불일치 |
| thread | thread_relation_mismatch | 위 조건 통과 후 truthy thread_ts가 요청 root와 불일치 |
| thread | thread_time_invalid | 위 조건 통과 후 메시지가 요청 root보다 이전 |
| root | root_reply_count_invalid | root의 정의된 reply_count가 safe nonnegative integer 아님 |
| root | root_missing | 현재 및 이전 전달 seen에 root 없음 |
| fingerprint | fingerprint_conflict | 동일 seen ts의 기존 fingerprint 불일치 |
| budget | budget_exceeded | 기존 message projection 후 페이지 budget 음수 |
| cursor | cursor_replay | 기존 API next cursor가 이전/사용한 cursor 반복 |

예상 밖 기존 getter/처리 예외는 응답 처리 `response_exception`, 메시지 검증 `message_exception`, thread 관계 검증 `thread_exception`, root/count 처리 `root_reply_count_exception`, fingerprint 계산 `fingerprint_exception`, 출력 projection `projection_exception`, sort/continuation 처리 `continuation_exception`의 고정 stage로만 분류한다. 예외 객체/코드/문구는 로거에 전달하지 않는다. exception reason은 정확한 필드 값/오류 원인의 증거가 아니다.

local reject는 기존 동일 한국어 unavailable를 반환한다. 알려지지 않은 reply_count·count drift·잘린 text·페이지 한도·has_more without cursor는 기존 partial success일 수 있으며 새로 reject/실패 로그를 추가하지 않는다. channel reader의 root 발견은 별도 thread reader의 성공 또는 search PASS를 뜻하지 않는다. response 검증 실패는 성공적인 빈 결과가 아니다.

## 검증·후속

합성 테스트는 모든 local reason, malformed/getter throw, 처음 실패한 필드의 original OR-chain access trace, thread 관계 순서, response getter/Proxy·toJSON 추가 접근 없음, runtime forged casts/revoked Proxy 비실행, privacy, logger throw 중 cursor unlock/retry, transport 취소 rejection, actor role/scope/provenance, 성공/partial/실패 output와 기록 수를 확인한다. 등록된 실제 Mastra 도구/handler→WeakMap→API mock의 실패 및 logger/DB redaction도 확인한다. DB build 후 shookie build 및 Slack/cancellation 회귀를 수행한다. **합성 PASS는 실제 Slack 검색/thread read E2E PASS가 아니다.**

worker는 운영 서버/E2E/배포/merge를 하지 않는다. main의 최종 SHA diff 및 fresh 독립 리뷰 수용→pinned squash→deploy SUCCESS/live SHA/restarts 확인→새 검색 이벤트 1회에서 trusted requestId의 검색 역할/원천 및 read 정확한 reason을 봇 응답과 대조한다. 근거 후 최소 fix를 별도 설계·PR로 진행한다. 실제 검색/source 및 thread read 성공 이후 임시 read/search/action-token 진단 제거 후속 PR이 필요하다.
