# Slack 검색 응답 검증 임시 안전 진단

## 현재 근거와 범위

main의 2026-10-06T16:43:05 새 요청 `slack-event:Ev0C6QG1C3HD`에서는 event/body.event action_token DATA/PRESENT/USABLE=true, SDK/receiver/handler alias 유지, identity/token binding 성공을 확인했다. search_api에 16:43:10.440, 16:43:14.480 두 번 도달했으나 bot은 두 번 모두 로컬 unavailable 안내(`Slack 결과를 안전하게 확인하지 못했습니다...`)를 반환했다. 실제 API 응답은 조회하지 않았다. 이전 missing token 문제는 **이번 요청에서는** 해소되었지만 MCP 설정과 Agent UI upgrade의 별도 인과관계는 미확정이다. 이 근거만으로 실제 거부 필드, API 성공 또는 검색 성공을 주장하지 않는다.

추가 근거: main이 배포한 `b71e9481503009769ac0d59a698d19f60e008233`의 2026-10-06T17:01:27 새 요청 `slack-event:Ev0C6QMH19T9`에서는 tokenBound=true, search_api 도달, response_received/check_passed 이후 `stage=permalink / reason=permalink_invalid`를 확인했다. 따라서 관측한 candidate의 기존 responseSchema와 선행 scope 검증은 통과했지만 링크가 로컬 거부되었다. bot은 검색 두 번 unavailable로 보고했다. **어떤 URL 조건이 불일치했는지는 아직 미확정**이며 query/host 문제라고 추측하지 않는다. 근거는 main의 비밀 없는 `pr99-results.md` / `pr99-new-thread-diagnostics.log`이고 worker는 실제 응답/링크를 조회하지 않았다.

PR99/100은 관찰만 추가했다. 이후 main의 `/tmp/shookie-e2e/pr100-results.md`와 `pr100-new-thread-diagnostics.log`를 worker가 대조했다. 요청 `slack-event:Ev0C79UZGDHS`는 response/check/schema/선행 scope를 통과했고, parsed/canonicalHref/https/host/noUserinfo/noPort/noHash/path 및 pathChannelMatch/pathMessageTsMatch는 true였다. 기존 acceptance의 **유일한 불일치는 NoQuery=false**였고 queryClass=known, thread_ts/cid present, cidMatch=true, duplicate=false였다. parent metadata.thread_ts가 없어서 queryThreadTsAvailable/Match=false였으며 이는 query timestamp 불일치의 증거가 아니다. bot은 unavailable였고 **실제 검색 성공이 아니다**. 원문 검색 URL/query 값/token/body는 조회·복사하지 않았다.

승인된 후속 수정은 이 관측 형태를 최소 지원한다. 기존 responseSchema, action_token 선택, bot/team/current public channel/live membership, API 인자·호출 수, context provenance, 페이지·커서·budget·취소는 유지한다. 기존 URL authority/path 검증 후 decoded thread_ts/cid만 각각 옵션으로 검증하고 queryless 메시지 주소를 반환한다. [기존 action-token 경계 진단](slack-action-token-diagnostics.md)과 함께 사용하며 임시 진단 제거는 별도 후속이다.

## 로그 계약

기존 INFO logger에 `slack_search_response_diagnostic`만 기록한다. 호출당 응답 수신 1개, check 통과 1개, 실패 시 마지막 1개(최대 3개)다. 성공에는 추가 본문/결과 요약이 없다. SDK/global debug·환경변수·모델·의존성 변경 없음.

공통 필드는 `stage`, `reason`, `correlationAvailable`, 선택적 `requestId`다. **schema_invalid에만** `schemaField`, `schemaCode`, `schemaMissing`, **permalink_invalid에만** 아래 고정 predicate vector와 보조 분류가 붙는다. 기존 마지막 실패 레코드 하나를 확장하며 레코드 수는 늘리지 않는다. requestId는 기존 identity WeakMap에서만 읽는다. diagnostic correlation이나 context.get/model 항목에서 fallback하지 않는다. 기존 action-token 로그의 같은 trusted requestId와 대조할 수 있으며, 상관 부재 시 새 ID/hash를 만들지 않는다.

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
| permalink / permalink_invalid | URL 파싱 실패, 기존 canonical https/workspace/channel/message 경로 조건 불일치 또는 허용된 navigation query 검증 실패 |
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

### permalink predicate vector

기존 `new URL()` 결과만 사용한다. raw response/getter를 다시 읽거나 URL을 재파싱하지 않는다. 거부 후 기존 predicate vector를 관찰한다. 여러 불일치는 short-circuit 없이 모두 boolean으로 기록한다. **NoQuery는 search 부재 관찰이지 현재 단독 거부 조건이 아니다**. 나머지 기존 authority/path 조건은 유지한다. 유효한 known query는 검증 후 제거되므로 vector를 기록하지 않는다.

| 필드 | true 의미 |
|---|---|
| permalinkParsed | 기존 URL 파싱 성공 |
| permalinkCanonicalHref | parsed href가 schema-parsed 입력 문자열과 동일 |
| permalinkHttps | protocol이 https: |
| permalinkHost | hostname이 기존 authorization의 trusted workspaceHost와 동일 |
| permalinkNoUserinfo | username/password 모두 비어 있음 |
| permalinkNoPort | parsed port가 비어 있음 |
| permalinkNoHash | parsed hash가 비어 있음 |
| permalinkNoQuery | parsed search가 비어 있음 |
| permalinkPath | pathname이 trusted 현재 채널과 validated message_ts(기존 6자리 소수 정규화)의 정확한 기존 archives 경로와 동일 |

`permalinkParsed=false`이면 나머지 8개 predicate는 **미평가 sentinel false**이며 8가지 불일치가 발생했다는 뜻이 아니다. 성공한 링크/링크 부재에는 vector를 기록하지 않는다. URL parser의 기존 정규화도 그대로다(예: 명시적 기본 port는 parsed port가 비지만 href 불일치 가능). bare `?`/`#`처럼 parsed search/hash가 빈 경우를 새로 거부하지 않는다.

보조 분류는 관찰용이며 개별 boolean/enum만으로 query 허용·권한을 증명하지 않는다:

- `hostClass`: `workspace`(trusted host 일치 우선), `app.slack.com`, `slack.com`, `other` 중 하나. host 원문/접미사/서브도메인/해시를 출력하지 않는다. parse 실패는 other.
- `pathShape`: `archives_message` 또는 `other`. 관찰 regex는 `/archives/` + C/G/D 시작의 2~64자리 대문자 영숫자 ID + `/p` + 1~22자리 숫자 경로만 구분한다. 실제 기존 acceptance 경로는 바뀌지 않는다.
- `pathChannelMatch`, `pathMessageTsMatch`: 위 형태일 때 각각 trusted channel, validated message_ts의 점 제거 값과 **정확히** 동일. 형태 미일치/parse 실패는 false. 다른 채널/시간 값을 출력하지 않는다.
- `queryClass`: `none`(parsed search 없음), `known`(decoded 키가 thread_ts/cid뿐), `unknown`(다른 키, 의미 있는 pair 없는 search, parse/보조 관찰 실패). 기존 512자 입력 제한 아래 parsed URLSearchParams를 최대 512 pair까지만 관찰한다. 임의 응답 metadata 키 순회는 없고 원문/decoded 키·값은 남기지 않는다.
- `queryThreadTsPresent`, `queryCidPresent`: 각 알려진 decoded parameter가 관찰되었는지. percent-encoded 키도 URLSearchParams의 기존 해석에 따른다.
- `queryThreadTsAvailable`: schema-validated parent message의 thread_ts 존재 여부. raw response thread 값을 다시 읽지 않는다.
- `queryThreadTsMatch`, `queryCidMatch`: 해당 parameter가 존재하고 **모든 출현 값**이 각각 validated parent thread_ts(형식 검증 후 fractional 6자리 정규화), trusted channel과 일치. 누락/빈 값/잘못된 timestamp는 false. thread_ts가 parent에 없으면 thread match는 false이며 query root 검증 실패라는 뜻이 아니다. 이 flag는 root<=message 시간 검증을 대신하지 않는다.
- `queryDuplicate`: thread_ts 또는 cid가 중복 출현했는지. unknown 키는 중복 여부/원문을 기록하지 않는다. 중복 known 키만 있어도 class는 known이지만 같은 값이라도 거부한다.

query 보조 관찰 예외에는 class=unknown/parameter booleans=false를 사용하고 필수 predicate는 유지한다. 기타 진단 예외에는 기존 permalink_invalid 요약만 남길 수 있으며 로거 예외는 삼킨다. vector 부재는 허용/성공 증명이 아니다. 로거 API는 primitive 인수만 받고 runtime enum allowlist 및 `=== true`로 재투영한다. 허위 cast/object/getter/Proxy/toJSON를 로거에 전달하지 않는다.

**실제 원문 URL은 공유·로그·모델 입력·DB·파일에 추가하지 않는다.** hostname/path/query 키·값/채널·팀·timestamp/hash/token/내용/원본 response/errors/길이도 기록하지 않는다. 안전 enum/boolean과 WeakMap의 trusted requestId만으로 원인을 대조한다.

### 공식 문서의 예시와 보장 구분

2026-10-06 worker가 직접 확인한 [assistant.search.context 공식 문서](https://docs.slack.dev/reference/methods/assistant.search.context/)는 permalink를 “a permalink to the message”라고 설명한다. response sample은 `https://mycompany.slack.com/archives/C012345ABC/p123456789`, message_ts는 `123456.7890`이며 sample의 channel_id조차 링크의 채널 문자열과 다르다. 이는 **예시이지 현재 로컬 canonical predicate를 보장하는 규범이 아니다**. [Real-time Search 공식 가이드](https://docs.slack.dev/apis/web-api/real-time-search-api/)도 workspace archives 링크와 6자리 timestamp 예시를 보여주지만, 확인한 본문에는 host/query/thread_ts/cid/경로 및 URL timestamp encoding에 대한 명시적 보장을 찾지 못했다. sample에 query가 없다는 사실은 응답에 query가 없다는 보장이 아니다.

이번 worker는 [chat.getPermalink 공식 문서](https://docs.slack.dev/reference/methods/chat.getPermalink/)도 독립 확인했다. 문서는 channel + message_ts로 메시지 URL을 얻으며 threads/all conversation types를 처리한다고 설명한다. threaded response 설명은 path의 p 값이 댓글이고 query는 top-level 메시지를 참조한다고 명시하며 thread_ts/cid 예시를 제공한다. 이는 query가 붙은 댓글 URL을 이해하는 근거이나 **assistant.search.context가 항상 같은 host/path/query 형식이나 두 parameter를 보장한다는 규범은 확인하지 못했다**. 문서 예시의 URL과 response channel 문자열도 다르므로 sample을 정합성 보장으로 취급하지 않는다. chat.getPermalink를 새로 호출하지 않는다.

### 승인된 검색 permalink 정규화

1. 입력 URL 최대 512자와 기존 parse/href canonical/HTTPS/trusted workspace host/no userinfo/no port/no nonempty hash/정확한 current channel + canonical message_ts path 가드를 그대로 유지한다.
2. search가 있을 때만 URLSearchParams의 decoded pair를 최대 512회 순회한다. 키는 thread_ts/cid만 허용하며 빈 키·알 수 없는 키·중복(같은 값 포함)·빈 값·의미 있는 pair 없는 search는 전체 페이지 unavailable이다. encoded 키/순서는 허용목록 검증에 영향을 주지 않는다.
3. cid는 trusted current channel과 exact 일치해야 한다. thread_ts는 기존 apiTs와 동일한 whole 1~16자리/fraction 1~6자리 숫자 형식 검증 후 fractional 6자리로 정규화한다. BigInt로 root<=message_ts를 비교하고 schema metadata.thread_ts가 있으면 정규화 문자열도 같아야 한다.
4. metadata.thread_ts가 없으면 query root는 형식·시간 검증만 한다. 권한/identity/source/반환 threadTs/context provenance로 승격하지 않는다. cid-only/thread-only도 같은 안전 조건으로 검증한다.
5. 유효한 query는 **검증된 queryless workspace/channel/message 주소**로 반환한다. 원문 query 값은 모델/응답에 남기지 않는다. query 없는 legacy 반환과 빈/누락 permalink, bare ?/# parser 경계는 그대로 유지한다(query 있는 bare #는 queryless 주소로 정리).
6. 외부 host/다른 채널·message path/noncanonical href/port/userinfo/nonempty hash, unknown/duplicate/empty/malformed/future/thread metadata 불일치는 unavailable이다. 잘못된 match skip, lookup/fetch/fallback, API/scope/token/config 확대는 없다.

임시 진단 계약의 로그 수·privacy는 유지한다. 이번 수정의 합성 PASS는 실제 검색 PASS가 아니며 제거 후속 PR이 필요하다.

## 검증과 운영 확인

합성 테스트는 각 URL predicate 거부와 동시 다중 불일치의 정확한 전체 vector, canonical accepted/링크 부재의 무진단 유지, known/unknown/encoded/중복 query와 trusted thread context 비교, query 보조 예외의 필수 flag 유지, parsed copy를 사용해 raw permalink getter 접근을 늘리지 않음, primitive logger runtime allowlist 및 폐기 Proxy/toJSON 비실행, logger throw 중 permalink 거부와 cursor retry를 확인한다. 추가로 각 local reject reason, API/check/schema 예외, missing/type/code/full-path allowlist, 첫 issue 경계, 악성 metadata/token path·getter·Proxy(폐기 포함)·toJSON 비실행, 성공 내용/ID/토큰 비노출, 로거 예외에도 같은 결과와 API 호출 수, cursor unlock/retry를 확인한다. budget 방어 분기는 합성 byteLength stub으로만 유발한다. 기존 search/authorization/client/action-token/handler/socket/cancellation 회귀를 함께 실행하며 database build를 먼저 한다. 실제 Slack E2E가 아니다.

추가 합성 회귀는 observed known thread_ts/cid + metadata.thread_ts 부재를 실제 등록된 slack_search→handler trusted context→API mock으로 재현한다. queryless 반환·threadTs 미승격·Slack tool logger/DB redaction을 검증한다. reader 테스트는 옵션/order/encoded 키, timestamp fraction 정규화·BigInt 경계·metadata 일치, malformed UTF-8/unknown/empty/duplicate/future/authority 거부 및 실패 cursor unlock/retry를 검증한다. **원문 E2E body/수정값을 fixture에 복사한 것이 아니며 실제 Slack 검색 성공을 보증하지 않는다.**

main 책임:
1. 최종 head 독립 리뷰·실제 diff·검증 SHA 수용 후 pinned squash merge. 배포 SHA와 bot 준비 확인.
2. 기존 접근 가능한 공개채널에서 **새 이벤트 1회**의 실제 slack_search 요청. worker는 운영 E2E/서버/배포/merge를 하지 않는다.
3. 그 trusted requestId의 기존 token 단계와 response/check/failure reason/schemaField 또는 permalink predicate flags/고정 보조 enum을 bot 응답과 대조한다. raw response/debug/credential 공유 금지. 배포 SUCCESS/live SHA/restarts 확인 뒤 새 Slack thread 실제 검색 결과를 원래 SHKO 표식 thread 원문·수정 댓글 출처와 대조해야 한다.
4. 조회 API 응답/합성 테스트/로그만으로 실제 검색 PASS를 주장하지 않는다. 검색 없는 unavailable를 PASS로 대체하지 않는다. 추가 스키마·링크 정책 변경은 별도 승인/설계가 필요하다.
5. 근거 확보 후 **임시 response 및 action-token 진단 제거 후속 PR** 필요. worker 제출 후 수정 대기; 최종 stop/워크트리·브랜치 정리 및 `cleanup_completed` 종료 증명은 owner main 담당이다.
