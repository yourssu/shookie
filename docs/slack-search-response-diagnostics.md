# Slack 검색 응답 검증 임시 안전 진단

## 현재 근거와 범위

main의 2026-10-06T16:43:05 새 요청 `slack-event:Ev0C6QG1C3HD`에서는 event/body.event action_token DATA/PRESENT/USABLE=true, SDK/receiver/handler alias 유지, identity/token binding 성공을 확인했다. search_api에 16:43:10.440, 16:43:14.480 두 번 도달했으나 bot은 두 번 모두 로컬 unavailable 안내(`Slack 결과를 안전하게 확인하지 못했습니다...`)를 반환했다. 실제 API 응답은 조회하지 않았다. 이전 missing token 문제는 **이번 요청에서는** 해소되었지만 MCP 설정과 Agent UI upgrade의 별도 인과관계는 미확정이다. 이 근거만으로 실제 거부 필드, API 성공 또는 검색 성공을 주장하지 않는다.

이 PR은 관찰만 추가한다. responseSchema, action_token 선택/validation/fallback, current channel/team/membership 권한, query/parser/provenance, 페이지·커서·budget·취소 규칙 및 사용자 반환은 변경하지 않는다. 스키마 필드 거부가 발견되어도 허용 범위 확대/스키마 수정은 main의 증거 검토와 설계 승인 후 **별도 작업**이다. [기존 action-token 경계 진단](slack-action-token-diagnostics.md)과 함께 사용한다.

## 로그 계약

기존 INFO logger에 `slack_search_response_diagnostic`만 기록한다. 호출당 응답 수신 1개, check 통과 1개, 실패 시 마지막 1개(최대 3개)다. 성공에는 추가 본문/결과 요약이 없다. SDK/global debug·환경변수·모델·의존성 변경 없음.

필드는 `stage`, `reason`, `correlationAvailable`, 선택적 `requestId`와 **schema_invalid에만** `schemaField`, `schemaCode`, `schemaMissing`이다. requestId는 기존 identity WeakMap에서만 읽는다. diagnostic correlation이나 context.get/model 항목에서 fallback하지 않는다. 기존 action-token 로그의 같은 trusted requestId와 대조할 수 있으며, 상관 부재 시 새 ID/hash를 만들지 않는다.

requestId 외에는 고정 enum/boolean만 전달한다. logger API는 response/error/Zod issue/path/raw object를 받지 않는다. 원본 오류/API code, headers, 내용, query, 토큰·커서·키워드·길이·배열 크기·resultCount·hash, 사용자/팀/채널 metadata, permalink/private URL, raw payload는 추가 로그에 없다. 모델 입력/응답/DB/파일에 원본 응답이나 진단을 추가하지 않는다. 이 계약은 기존 로그 전체의 비밀 제거를 보장하는 것이 아니다. 운영 공유에는 이 두 진단 메시지만 발췌한다.

### reason 해석

| stage / reason | 의미 |
|---|---|
| preflight / preflight_failed | 기존 identity/input/channel/query/opaque cursor 검증에서 throw. API 이전이며 public status를 바꾸지 않음 |
| authorization / authorization_failed | 기존 live bot/team/channel/member 확인에서 throw. API 이전 |
| prerequisites / prerequisites_missing | 공개채널 확인 이후 workspaceHost 또는 apiCall 부재. 기존 local unavailable |
| transport / api_call_failed | apiCall이 reject/throw. 네트워크 실패일 수도, SDK가 API 오류를 throw한 것일 수도 있음. 원문/code 미조회 |
| transport / response_received | apiCall resolve. API 성공·schema 유효성 보장 아님 |
| api_check / check_failed | 기존 check()가 throw. ok/error 확인 단계이며 원문 오류 code는 기록하지 않음 |
| api_check / check_passed | 기존 check() 통과. 검색 성공/안전한 결과 보장 아님 |
| schema / schema_exception | 기존 safeParse가 예외를 던짐. 스키마 부적합 정상 반환과 구분 |
| schema / schema_invalid | 기존 safeParse 실패. 아래 고정 첫 issue 요약만 기록. nonempty metadata warnings도 max(0) schema 거부로 여기 해당 |
| warnings / warning_present | 파싱 후 truthy top-level warning. 내용 미조회/미기록 |
| result_limit / result_limit_exceeded | 파싱 가능한 messages가 요청 limit 초과. schema 자체의 max(20) 거부와 구분 |
| scope / scope_mismatch | primary/context의 명시적 channel/team/대체 scope가 trusted identity와 불일치 |
| permalink / permalink_invalid | URL 파싱 실패 또는 기존 canonical https/workspace/channel/message 경로 조건 불일치 |
| context_time / context_time_invalid | before/after가 부모 message_ts의 요구 방향과 불일치 |
| thread_scope / thread_scope_mismatch | parent와 context의 명시적 thread_ts 불일치 |
| fingerprint / fingerprint_conflict | 관측한 동일 ts의 본문 충돌. 본문/hash/ts 미기록 |
| budget / budget_exceeded | context 제거 후에도 primary header가 기존 페이지 budget 초과 |
| cursor / cursor_conflict | metadata/top-level next_cursor 둘 다 존재하나 불일치 |
| cursor / cursor_replay | next_cursor가 이전/이미 사용된 API cursor를 반복 |
| validation / validation_exception | 파싱 후 기존 로컬 검증·projection·continuation 처리에서 예상 밖 예외. 원문 미조회 |

기존 unsupported 조기 return(토큰 없음/비공개채널)은 새 실패 레코드를 만들지 않는다. 위 reason은 public status가 아니다. API/check 오류의 기존 unsupported/access_denied/rate_limited 분류 및 메시지는 그대로다. local unavailable reason은 기존 동일 한국어 메시지를 유지한다.

**응답 검증 실패는 검색 0건이 아니다.** 성공적인 빈 messages는 기존 status=ok다. response_received + check_passed만으로 결과 스키마 통과/검색 성공을 주장할 수 없으며, 두 로그 다음에 실패 레코드가 없다는 사실도 로그 손실·logger 예외·취소 가능성 때문에 성공 증명이 아니다.

### schema 요약

첫 Zod issue 하나만 본다(모든 거부 목록 아님). 정적 full path와 비교해 `results`, `messages`, `message_item`, `message_message_ts`, `message_content`, `message_team_id`, `message_channel_id`, `message_is_author_bot` 등 기존 스키마 필드를 구분한다. message의 모든 scope/author/permalink/thread/context 필드, context before/after 배열과 context_item/각 고정 필드, files/channels/users, response_metadata/next_cursor/warnings/item, top-level next_cursor/has_more/warning도 정적 allowlist다. context의 before/after item 필드는 `context_*`로 합치며 index/위치별 값은 출력하지 않는다. 임의 metadata 안의 같은 이름은 일치하지 않는다.

`schemaCode`는 Zod 3의 정적 code allowlist(`invalid_type`, `invalid_string`, `too_big` 등)이며 다른 code/path는 `unknown`이다. `schemaMissing=true`는 첫 issue가 invalid_type이고 own received가 고정 문자열 undefined일 때만 설정한다. false는 해당 필드가 유효하다는 뜻이 아니다. 예: message_team_id + invalid_type + true이면 누락/undefined 거부, false이면 null/다른 타입 거부; message_message_ts + invalid_string이면 기존 timestamp regex 거부. 실제 값/expected type/received type은 출력하지 않는다.

issue/path는 고정 own data descriptor로만 읽는다. path는 최대 7개의 기존 위치만 비교하며 array index는 wildcard로 처리하고 출력하지 않는다. 임의 키 순회, getter, Proxy trap, toJSON 없음. 응답 shape를 추가 검사하지 않으므로 기존 check/Zod가 수행하는 접근 외에 raw response getter를 실행하지 않는다. 로거/진단의 예외는 삼키며 기존 failure/cursor finally cleanup/취소 흐름을 방해하지 않는다.

## 검증과 운영 확인

합성 테스트는 각 local reject reason, API/check/schema 예외, missing/type/code/full-path allowlist, 첫 issue 경계, 악성 metadata/token path·getter·Proxy(폐기 포함)·toJSON 비실행, 성공 내용/ID/토큰 비노출, 로거 예외에도 같은 결과와 API 호출 수, cursor unlock/retry를 확인한다. budget 방어 분기는 합성 byteLength stub으로만 유발한다. 기존 search/authorization/client/action-token/handler/socket/cancellation 회귀를 함께 실행하며 database build를 먼저 한다. 실제 Slack E2E가 아니다.

main 책임:
1. 최종 head 독립 리뷰·실제 diff·검증 SHA 수용 후 pinned squash merge. 배포 SHA와 bot 준비 확인.
2. 기존 접근 가능한 공개채널에서 **새 이벤트 1회**의 실제 slack_search 요청. worker는 운영 E2E/서버/배포/merge를 하지 않는다.
3. 그 trusted requestId의 기존 token 단계와 새 response/check/failure reason/schemaField를 bot 실패 응답과 대조한다. 동시/추가 요청 금지. raw response/debug/credential 공유 금지.
4. 실제 거부 필드는 main에 안전 enum으로 보고. 스키마 완화는 별도 승인 작업으로 분리. 검색 성공을 미리 주장하지 않는다.
5. 근거 확보 후 **임시 response 및 action-token 진단 제거 후속 PR** 필요. worker 제출 후 수정 대기; 최종 stop/워크트리·브랜치 정리 및 `cleanup_completed` 종료 증명은 owner main 담당이다.
