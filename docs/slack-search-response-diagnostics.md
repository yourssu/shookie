# Slack 검색 응답 검증 임시 안전 진단 (아카이브)

> **정책 갱신:** 아래 PR102/104의 PREFIX-only·비prefix/primary-longer 거절 문구는
> 당시 정책 이력이다. 현재는 양쪽 SAME-PAGE 검증 + 모든 관측의 user/explicit-kind/thread
> 호환을 통과한 비동일 cross-role에서 primary를 그대로 보존하고 대체 context를 생략한다.
> 동등 representation/권한 승인이나 본문/source 합성이 아니며 sticky partial이다.
> nonprefix만으로 primary.textTruncated를 설정하지 않는다(실제 projection 및 기존
> exact-prefix short-primary 규칙 유지). same-role exact hash와 unequal seed-only 거절은
> 그대로다. PR113에서 복원한 별도 cross-channel 진단은 추가/확대/제거하지 않는다.
> 최신 계약은 [읽기 도구](slack-read-tools.md)와
> [cross-channel 진단 및 후속 기능](slack-cross-channel-search-diagnostics.md)을 따른다.

> **현재 코드: 임시 진단 제거됨.** 아래 로그 계약·진단 필드·당시 테스트/운영 절차는 과거 이력이며 현재 emit 계약이 아니다. `search-diagnostics.ts`의 첫 Zod issue 요약·permalink predicate·role 비교/로거 및 source-only 집계를 제거했다. 기능용 KindEvidence의 bot/participant 캐시, PageMetadata의 users/knownKinds/threads, pageObserved는 유지한다. 아래 명시적 kind 지식과 known query 정규화 기능 가드는 그대로이며 오래된 projected-kind 진단을 현재 explicit-known Set으로 소급 해석하지 않는다.
>
> **main이 전달한 제거 전 실제 근거:** PR105 배포 및 live SHA/restarts=0 확인 뒤 search-only 새 이벤트에서 실제 searchMatch·원문/수정 댓글 출처 대조가 PASS였다. 검색은 complete=false/truncated=true/nextCursor=null/textTruncated=true인 정직한 partial이다. PR103 독립 thread read는 3페이지 complete PASS다(안전 요약: `/tmp/shookie-e2e/pr105-results.md`). history fallback을 검색 PASS로 대체하지 않았다. 20 matches/전체 query pagination/다른 requester E2E는 미검증이다.
>
> **현재 제거 코드 vs 운영 완료:** 임시 action-token/search/read 3종 emit 및 전용 plumbing을 코드에서 제거했지만 이 변경의 배포 후 실제 재검증은 아직 미수행이다. main이 최종 SHA 전체 diff·fresh review·pinned squash·deploy SUCCESS/live SHA/restarts=0 확인 후 새 Slack 이벤트 실제 검색과 독립 thread read·출처/도구 결과 및 3종 임시 emit 부재를 재검증해야 한다. worker는 merge/배포/서버/E2E를 실행하지 않는다. stop/exit/cleanup_completed까지 main이 확인한 뒤 최종 완료로 보고한다.

## 과거 근거 및 진단 계약 (아카이브)

## 현재 근거와 범위

main의 2026-10-06T16:43:05 새 요청 `slack-event:Ev0C6QG1C3HD`에서는 event/body.event action_token DATA/PRESENT/USABLE=true, SDK/receiver/handler alias 유지, identity/token binding 성공을 확인했다. search_api에 16:43:10.440, 16:43:14.480 두 번 도달했으나 bot은 두 번 모두 로컬 unavailable 안내(`Slack 결과를 안전하게 확인하지 못했습니다...`)를 반환했다. 실제 API 응답은 조회하지 않았다. 이전 missing token 문제는 **이번 요청에서는** 해소되었지만 MCP 설정과 Agent UI upgrade의 별도 인과관계는 미확정이다. 이 근거만으로 실제 거부 필드, API 성공 또는 검색 성공을 주장하지 않는다.

추가 근거: main이 배포한 `b71e9481503009769ac0d59a698d19f60e008233`의 2026-10-06T17:01:27 새 요청 `slack-event:Ev0C6QMH19T9`에서는 tokenBound=true, search_api 도달, response_received/check_passed 이후 `stage=permalink / reason=permalink_invalid`를 확인했다. 따라서 관측한 candidate의 기존 responseSchema와 선행 scope 검증은 통과했지만 링크가 로컬 거부되었다. bot은 검색 두 번 unavailable로 보고했다. **어떤 URL 조건이 불일치했는지는 아직 미확정**이며 query/host 문제라고 추측하지 않는다. 근거는 main의 비밀 없는 `pr99-results.md` / `pr99-new-thread-diagnostics.log`이고 worker는 실제 응답/링크를 조회하지 않았다.

PR99/100은 관찰만 추가했다. 이후 main의 `/tmp/shookie-e2e/pr100-results.md`와 `pr100-new-thread-diagnostics.log`를 worker가 대조했다. 요청 `slack-event:Ev0C79UZGDHS`는 response/check/schema/선행 scope를 통과했고, parsed/canonicalHref/https/host/noUserinfo/noPort/noHash/path 및 pathChannelMatch/pathMessageTsMatch는 true였다. 기존 acceptance의 **유일한 불일치는 NoQuery=false**였고 queryClass=known, thread_ts/cid present, cidMatch=true, duplicate=false였다. parent metadata.thread_ts가 없어서 queryThreadTsAvailable/Match=false였으며 이는 query timestamp 불일치의 증거가 아니다. bot은 unavailable였고 **실제 검색 성공이 아니다**. 원문 검색 URL/query 값/token/body는 조회·복사하지 않았다.

승인된 후속 수정은 이 관측 형태를 최소 지원한다. 기존 responseSchema, action_token 선택, bot/team/current public channel/live membership, API 인자·호출 수, context provenance, 페이지·커서·budget·취소는 유지한다. 기존 URL authority/path 검증 후 decoded thread_ts/cid만 각각 옵션으로 검증하고 queryless 메시지 주소를 반환한다. [기존 action-token 경계 진단](slack-action-token-diagnostics.md)과 함께 사용하며 임시 진단 제거는 별도 후속이다.

## PR101 후속 관측: 본문 충돌·읽기 실패 (진단 전용)

main이 전달한 `/tmp/shookie-e2e/pr101-results.md` / `pr101-new-thread-diagnostics.log`의 새 요청 `slack-event:Ev0C80QH8AL8`에서는 PR101 배포 성공·live SHA 확인·restarts=0 후 response_received/check_passed 다음에 `fingerprint_conflict`가 두 번(17:37:54.022Z / 17:37:56.870Z) 관측되었다. 해당 후보들의 링크·scope·schema 선행 검증은 통과했지만 **실제 검색은 FAIL**이다. 같은 요청의 별도 스레드 읽기도 두 번 unavailable였으며, 채널 읽기에서 부모만 찾은 것은 검색 또는 스레드 읽기 PASS가 아니다. 역할 조합/페이지 원천 및 읽기의 정확한 로컬 실패 분기는 아직 미확정이다. 이번 worker는 실제 응답 본문/URL/query를 조회·복사하지 않고 전달된 안전 요약만 사용한다.

이번 단일 PR은 아래 충돌 vector와 [읽기 실패 고정 reason](slack-read-response-diagnostics.md)만 추가한다. 기존 sha256(text) 충돌 가드, 반환·primary promotion·context 대표 선택·schema·authority·query·cursor/budget·권한·취소 정책을 완화하지 않는다. 형식 차이/요약/잘림/동시 수정 등 **실제 원인을 아직 단정하지 않는다**. evidence 기반 수정은 main의 별도 설계·PR이며 실제 성공 후 임시 진단 제거도 별도 후속이다.

## 로그 계약

기존 INFO logger에 `slack_search_response_diagnostic`만 기록한다. 호출당 응답 수신 1개, check 통과 1개, 실패 시 마지막 1개(최대 3개)다. 성공에는 추가 본문/결과 요약이 없다. SDK/global debug·환경변수·모델·의존성 변경 없음.

공통 필드는 `stage`, `reason`, `correlationAvailable`, 선택적 `requestId`다. **schema_invalid에만** `schemaField`, `schemaCode`, `schemaMissing`, **permalink_invalid에만** 아래 고정 predicate vector와 보조 분류, **fingerprint_conflict에만** 아래 역할/원천/보조 비교 vector가 붙는다. 기존 마지막 실패 레코드 하나를 확장하며 레코드 수는 늘리지 않는다. requestId는 기존 identity WeakMap에서만 읽는다. diagnostic correlation이나 context.get/model 항목에서 fallback하지 않는다. 기존 action-token 로그의 같은 trusted requestId와 대조할 수 있으며, 상관 부재 시 새 ID/hash를 만들지 않는다.

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

### fingerprint conflict vector

기존 마지막 `fingerprint_conflict` 레코드 하나만 확장한다. 실패 반환 및 최대 3개 search record는 그대로다.

- `priorRole`, `currentRole`: `primary` / `context` / `unknown`. role-aware 수정 후 먼저 primary 후보들 다음 context 후보들의 **동일 역할 hash**를 전부 검사하고, 그 다음 다른 역할 표현 관계를 검증한다. 동일 역할 충돌의 prior는 해당 역할의 가장 최근 page 관측이며 없으면 그 역할 cursor hash seed다. cross-role 충돌의 prior는 비교하는 반대 역할 page 객체이며 없으면 반대 역할 seed다. 최초 객체·primary 우선 projected 대표·과거 전달 winning role을 prior로 오인하지 않는다. 따라서 여러 충돌이 있으면 동일 역할 충돌이 cross-role 충돌보다 먼저 관측될 수 있다.
- `priorOrigin`: `page` / `cursor` / `unknown`. page는 직전 비교 본문이 이번 페이지의 검증된 후보인 경우, cursor는 과거 전달 fingerprint seed뿐인 경우다. origin은 Slack 원문 생성 원인/시간을 뜻하지 않는다.
- `firstPage`, `cursorPresent`: 이전 continuation 부재/호출의 opaque cursor 존재 boolean만 기록한다. cursor 값·페이지 번호·메시지 ts/ID·hash·길이는 출력하지 않는다.
- `comparisonAvailable`: 양쪽 **page-local primitive 본문**이 존재하고 각각 기존 24KB 이하일 때만 true다. 큰 문자열을 진단 때문에 스캔하지 않도록 code-unit 선행 한도도 사용한다. cursor에는 기존 fingerprint/role만 있으며 **이전 원문을 추가 저장하거나 복구하지 않는다**. cursor-only 충돌/크기 초과/보조 비교 예외에는 false다.
- `trimEqual`: available일 때 양쪽 JS `trim()` 결과가 동일한지. `lineEndingEqual`: CRLF 및 단독 CR을 LF로 바꾼 결과가 동일한지. unavailable일 때 두 false는 **미평가 sentinel**이지 차이 확정이 아니다.
- `prefixRelation`: available일 때 변형하지 않은 문자열의 prefix 관계 `previous_prefix` / `current_prefix` / `neither`, 그 외 `unknown`. 이는 snippet/잘림/원문 형식의 원인 증명이 아니다. prefix/equality flag만으로 guard 완화 근거를 만들지 않는다.

기존 schema/scope/time 검증을 통과한 후보 참조만 페이지 로컬 role별 Map으로 추적한다(전체 관측 상한 820개: 20 primary + 20×40 context). 각 역할의 최신 관측을 갱신하며 budget으로 반환하지 않는 후보도 포함한다. role별 기존 SHA-256 hash를 분리하고 실제 전달 ts에만 최대160 ts×2 hash를 cursor에 보관한다. 원문 복사·cursor/DB/파일 원문 지속보관은 없고, 반환 전에 기존 projection이 본문을 수정하기 전의 비교만 한다. raw response/context getter/Proxy/toJSON 접근을 추가하지 않는다. logger에는 primitive 인수만 전달하고 enum runtime allowlist/boolean strict equality로 재투영한다. 로거 throw는 같은 unavailable 및 finally unlock을 유지한다.

### 공식 문서의 예시와 보장 구분

2026-10-06 worker가 직접 확인한 [assistant.search.context 공식 문서](https://docs.slack.dev/reference/methods/assistant.search.context/)는 permalink를 “a permalink to the message”라고 설명한다. response sample은 `https://mycompany.slack.com/archives/C012345ABC/p123456789`, message_ts는 `123456.7890`이며 sample의 channel_id조차 링크의 채널 문자열과 다르다. 이는 **예시이지 현재 로컬 canonical predicate를 보장하는 규범이 아니다**. [Real-time Search 공식 가이드](https://docs.slack.dev/apis/web-api/real-time-search-api/)도 workspace archives 링크와 6자리 timestamp 예시를 보여주지만, 확인한 본문에는 host/query/thread_ts/cid/경로 및 URL timestamp encoding에 대한 명시적 보장을 찾지 못했다. sample에 query가 없다는 사실은 응답에 query가 없다는 보장이 아니다.

이번 worker는 [chat.getPermalink 공식 문서](https://docs.slack.dev/reference/methods/chat.getPermalink/)도 독립 확인했다. 문서는 channel + message_ts로 메시지 URL을 얻으며 threads/all conversation types를 처리한다고 설명한다. threaded response 설명은 path의 p 값이 댓글이고 query는 top-level 메시지를 참조한다고 명시하며 thread_ts/cid 예시를 제공한다. 이는 query가 붙은 댓글 URL을 이해하는 근거이나 **assistant.search.context가 항상 같은 host/path/query 형식이나 두 parameter를 보장한다는 규범은 확인하지 못했다**. 문서 예시의 URL과 response channel 문자열도 다르므로 sample을 정합성 보장으로 취급하지 않는다. chat.getPermalink를 새로 호출하지 않는다.

2026-10-06 이번 worker가 다시 확인한 같은 `assistant.search.context` 문서의 Contextual messages는 관련 메시지의 before/after 목록과 원래 메시지가 스레드 안이면 그 스레드로 context를 제한한다고 설명한다. 예시는 primary `content`와 context `text`를 사용하며 `highlight` 기본값은 false다. 확인한 본문에서 **동일 ts의 content/text가 정확히 동일하다는 보장, snippet/잘림/formatting 보장**은 찾지 못했다. 예시/보장 부재는 판단 보조이지 위 실제 충돌의 원인 증거가 아니다. 가드를 바꾸지 않는다.

### PR102 후속 안전 근거와 최소 기능 수정

main의 `/tmp/shookie-e2e/pr102-results.md` / `pr102-new-thread-diagnostics.log`를 확인했다. `slack-event:Ev0C8118NH9N`에서 thread read는 18:00:21.872Z `response/result_limit_exceeded`, search는 response/check 통과 후 18:00:22.076Z `primary→context`, `priorOrigin=page`, `firstPage=true`, `comparisonAvailable=true`, `trimEqual=false`, `lineEndingEqual=false`, `prefixRelation=previous_prefix`였다. 이는 동일 ts의 짧은 primary가 긴 context의 정확 prefix인 **해당 관측** 근거다. 봇 최종 응답은 generic processing failure였으며, 개별 로컬 가드 근거가 그 최종 실패의 모든 원인을 설명하거나 전체 E2E PASS를 뜻하지 않는다.

PR102 당시 허용은 same-page 검증 primary-prefix-context에 한정했다(현재 생략 정책은 상단 갱신 참조). 같은 역할 hash 충돌/비prefix/primary-longer는 unavailable이며 normalization으로 허용하지 않는다. prefix 관계에서 명시적 author/thread 충돌도 실패한다. 모든 page-local 관측의 role별 user/kind/thread primitive Set을 집계해 **모든 primary-context 쌍**의 명시적 값이 양립하는지 검증한다(역할 중 한쪽에 알려진 값이 전혀 없으면 기존 unknown wildcard). 최신 객체가 metadata를 생략해도 앞선 명시적 값은 사라지지 않는다. 이 집계는 schema 관측 상한 안에서만 존재하며 cursor에 metadata를 추가 저장하지 않는다. exact-equal cross-role의 기존 metadata 계약과 동일 역할 본문 hash 가드는 바꾸지 않는다. primary 원본 본문/metadata를 유지하고 확인된 짧은 표현은 textTruncated=true, complete=false/partial로 표시한다. cursor에는 역할 hash와 deliveredRoles만 bounded 유지하고 긴 context hash로 primary hash를 덮어쓰지 않는다. 다른 역할 seed만으로 nonidentical continuation promotion을 추측 허용하지 않으며, 같은-page 양쪽 증거가 필요하다. 모든 scope/time/thread 검증은 projection/생략보다 먼저 수행한다.

별도 direct API 구조 관측에서는 limit15 응답에 root+요청 reply, limit14의 첫/continuation 응답에 root+reply가 public15 이내임을 안전 boolean으로 확인했다. 공식 Slack limit 설명에는 부모가 별도 추가된다는 명시가 없어 관측 근거와 구분한다. 명시적 thread reader만 API14로 부모 자리를 예약하고 history API15/public pageSize15/응답15 상한/root dedup/count/budget/maxPages4를 유지한다. direct API 성공은 Shookie PASS가 아니다. 이번 합성 테스트도 live 검색/명시적 thread read 성공을 보증하지 않는다. worker는 서버/E2E/배포/merge를 실행하지 않는다. main이 fresh review/pinned squash/deploy SUCCESS/live SHA/restarts=0 확인 후 새 이벤트 actual search(status/matches/partial/source) 및 independent thread read를 원문·수정 댓글과 대조한다. history fallback은 검색 PASS 대체가 아니며, 실제 성공 후 임시 진단 제거를 별도 관리한다.

독립 리뷰가 발견한 양 역할의 최신 객체에서 metadata가 생략되어 앞선 명시적 충돌이 지워지는 경우를 수정했다. 미수정 SHA `33d58e556d8ab472fc94b7963cc22d13797c8eaf`에서 새 합성 회귀 8개 중 thread/author 각각 1개(총2개)가 status=ok로 실패하는 것을 먼저 실행 확인했다. 수정 후 상호 최신 생략/순서 permutation, unknown metadata positive 및 exact-equal 기존 계약 회귀가 통과했다. fixtures는 합성값이며 원문 운영 본문/URL/수정값을 복사하지 않았다.

### PR103 후속: metadata 거부 원인 분리 (진단 전용)

owner main이 전달한 PR103 운영 요약에서는 배포 성공/live SHA/restarts=0 이후 새 이벤트의 search가 여전히 `fingerprint_conflict`로 실패했다. `primary→context`, page/firstPage, comparisonAvailable=true, trim/lineEndingEqual=false, previous_prefix였다. 즉 same-page primary-prefix-context인데 기존 aggregate users/kinds/threads 중 하나 이상에서 거부되었으며 **정확한 첫 필드는 아직 미확정**이다. 같은 운영 요약에서 독립 명시적 thread read는 실제 3페이지/complete=true와 원문·수정 댓글·출처 대조로 **PASS**, search는 **FAIL**이다. worker는 원문 응답/본문/URL/토큰을 조회·복사하지 않았다. client의 SDK14/public15 및 thread handling을 변경하지 않는다.

정적 가설: context의 optional `is_author_bot`가 빠지고 user가 존재하면 기존 projection은 participant를 추론한다. primary의 required boolean은 명시적이다. 그러나 실제 실패 필드와 flag 존재 여부는 아직 관측하지 않았으므로 **추론된 participant를 명시적 모순이나 실제 원인으로 단정하지 않는다**. 공식 예시/런타임 가정/합성 테스트는 실제 관측 증명이 아니다.

기존 마지막 fingerprint 레코드에 다음 **고정 enum만** 추가한다. 성공 호출에 새 content/결과 로그는 없고 최대 3개는 유지한다.

| 필드 | 고정값 및 의미 |
|---|---|
| `failure` | `same_role_text`: 기존 같은 역할 hash 충돌. `cross_role_seed_unverified`: 다른 역할 hash가 달라도 현재 페이지 양쪽 증거가 없음. `cross_role_user` / `cross_role_kind` / `cross_role_thread`: 기존 aggregate compatibility의 첫 실패. `cross_role_text_relation`: 위 metadata를 통과했으나 context가 primary의 정확 prefix 확장이 아님. `unknown`: 진단 sentinel/runtime 비허용 입력 |
| `primaryKnownKinds`, `contextKnownKinds` | PR104 당시: `none` / `bot` / `participant` / `mixed`. **당시 policy가 사용한 projected non-system kind Set** 요약이며 inferred participant도 포함했다. 후속 수정 이후의 현재 의미는 아래 explicit-known Set 참조 |
| `primaryKindSource`, `contextKindSource` | `explicit_bot` / `explicit_participant` / `inferred_participant` / `unknown` / `mixed`. 아래 source 근거를 모든 page-local 관측에서 누적한 요약 |

source 근거는 schema-parsed projection 시점에 캐시한 primitive 값만 사용한다. primary의 required true/false는 각각 explicit_bot/explicit_participant이며 user가 없어 projected system이어도 false의 명시적 근거는 유지한다. context의 제공된 boolean true 또는 bot_id 존재는 explicit_bot, 제공된 false는 user 부재여도 explicit_participant다. false와 bot_id가 함께 있으면 mixed다. optional boolean 부재/undefined이고 bot_id도 없을 때 user 존재로 projected participant가 되면 inferred_participant, 그 외에는 unknown이다. bot_id/user ID **값은 source side metadata에 넣거나 출력하지 않는다**. schema에 boolean으로 파싱된 값만 명시적 flag로 취급하며 raw own-property/getter를 추가 검사하지 않는다.

각 역할의 모든 관측 source를 유한 enum Set으로 누적한다. 서로 다른 근거(unknown 포함)가 함께 있으면 mixed다. 이는 명시적 모순 확정이 아니라 **근거가 혼합됨**을 뜻한다. 최신 context가 flag/user를 생략해도 앞선 근거를 지우지 않는다. 같은 역할 text guard는 aggregate 완성 전 먼저 실패하므로 이 경우 knownKinds=none/source=unknown은 **미평가 sentinel**이다. cross-role seed의 부재 역할도 none/unknown이며 cursor에 source를 저장·복구하지 않는다.

guard 순서는 그대로다: 모든 same-role hash → 기존 seed repeat 예외 → 양쪽 page 증거 → users → kinds → threads → 본문 prefix. OR/AND의 기존 short-circuit 순서대로 첫 실패 하나만 분류한다. exact-equal cross-role의 metadata 처리도 바꾸지 않는다. `failure=cross_role_kind`는 **기존 projected-kind policy 거부**만 증명하며 양 역할 source가 명시적이라는 증명은 아니다. source enum으로 security guard를 완화하지 않는다. body/hash/역할 반환/source/provenance/partial/cursor/dedup/budget/권한/token/취소 정책은 유지한다.

side metadata는 기존 최대 820개 관측의 페이지 안에서만 존재한다. logger는 primitive 인수와 runtime allowlist만 받으며 실패 분류·source에는 외부 문자열/ID/hash/길이/ts/URL/본문/토큰/커서/count가 없다. object cast/폐기 Proxy/getter/toJSON은 실행하지 않고 logger throw를 삼킨다. cursor/DB/도구 output에는 새 진단 metadata를 저장하지 않는다. 합성 회귀는 첫 실패 순서, explicit false vs omitted/user 추론/bot flag/bot_id, 최신 생략·순서별 all-observation 집계, 성공 partial/동일 output, generic unavailable/throwing logger/cursor unlock, registered tool/DB redaction 및 raw getter 접근 불증가를 검증한다.

main은 최종 SHA 실제 diff/fresh review 후 pinned squash와 deploy SUCCESS/live SHA/restarts를 확인하고 **새 actual search 이벤트 1회**에서 failure와 두 역할 source/knownKinds를 대조한다. 검색 성공은 이 PR에서 보장하지 않는다. 그 실제 근거를 사용한 최소 기능 수정은 새 task/PR에서 진행하며 actual search matches/source 및 독립 thread read PASS까지 후속 검증한다. worker는 merge/배포/서버/E2E를 실행하지 않는다. 실제 검색 성공 후 임시 진단 제거는 별도 PR이다.

### PR104 후속: 명시적 kind 지식과 출력 추론 분리

owner main이 전달한 `/tmp/shookie-e2e/pr104-new-thread-diagnostics.log` / `pr104-results.md` 요약에서 search-only 요청 `slack-event:Ev0C76S997BL`은 response_received/check_passed 이후 두 번 `cross_role_kind`로 실패했다. `primary→context`, page/firstPage, previous_prefix이며 당시 `primaryKnownKinds=bot / primaryKindSource=explicit_bot`, `contextKnownKinds=participant / contextKindSource=inferred_participant`였다. user compatibility는 선행 통과했으나 kind 다음의 thread compatibility는 완료 증명이 없다. 이는 **명시적 primary bot vs user만으로 추론된 context participant**를 당시 정책이 거부한 근거다. context의 명시적 false 모순이 아니다. 실제 검색은 unavailable/FAIL이며 응답 원문/context/URL/token을 조회·복사하지 않았다. PR103의 별도 명시적 thread read 실제 PASS(SDK14)는 유지하며 이 수정은 client/thread reader를 변경하지 않는다.

PR104 후속 당시 same-page primary-prefix-context의 kind 호환성은 출력 `author.kind`가 아니라 개별 schema-validated 객체에서 캐시한 boolean/presence 근거로 판단한다:

| validated 근거 | explicit-known kind Set |
|---|---|
| primary required `is_author_bot=true` | `{bot}` |
| primary required `is_author_bot=false` | `{participant}` (user 없어 출력 system이어도 known) |
| context optional true 또는 유효한 bot_id 존재 | `{bot}` |
| context optional false | `{participant}` (user 없어도 known) |
| context false + bot_id 존재 | `{bot, participant}` (개별 명시적 모순) |
| context flag 부재/undefined + bot_id 부재 | 빈 Set/unknown (user 존재는 human proof가 아님) |

`primaryKnownKinds`/`contextKnownKinds`는 이제 이 **explicit-known Set의 모든 page 관측 누적 요약**이다. none=명시적 근거 없음, bot/participant=해당 단일 근거, mixed=양쪽 근거. primary false나 context false는 projected system이어도 participant다. context-only user의 output participant는 기존 출력 추론일 뿐 명시적 human 증명이 아니다. output projection·identity·authorization 계약은 바꾸지 않으며 kind를 사용자 신원/접근권한 증명에 사용하지 않는다.

source enum의 의미/집계는 유지한다. unknown+explicit 또는 inferred+explicit 관측이 함께 있어 source=mixed라도 knownKinds는 단일 bot/participant일 수 있고 양립하면 허용한다. **source=mixed를 known contradiction으로 역변환하지 않는다.** 개별 false+bot_id는 양쪽 known flag를 누적하므로 상대가 known이면 fail-closed다. 서로 다른 관측의 true/false도 양쪽 Set에 남으며 나중 생략/undefined가 앞선 근거를 지우지 않는다. 한 역할 전체가 unknown이면 기존 wildcard를 유지한다. same-role 실패의 미평가 none/unknown 및 cursor-only 역할 부재 sentinel도 그대로다. `cross_role_kind`는 이제 이 explicit-known compatibility의 첫 실패이며, 오래된 PR104 projected-policy 실패와 구분해야 한다.

PR104 후속 당시 users → explicit-known kinds → threads → 정확 prefix 순서는 유지했다(현재 마지막 prefix는 거절 조건이 아니라 short-primary marker에만 사용한다). 모든 page 관측을 검증하며 same-role sha256 충돌은 항상 fail-closed다. 비prefix/primary-longer/다른 user/thread, authority/channel/team/scope 가드는 그대로다. exact-equal cross-role의 legacy metadata 처리도 그대로다. output author/thread/source를 context로 승격하지 않으며 짧은 primary 원본과 textTruncated=true/partial을 유지한다. metadata는 페이지 로컬 parsed primitive 캐시에만 있고 cursor에는 전달된 최대160 ts×2 role hash만 보관한다. raw own-property 검사/getter 접근, 로그 필드/레코드 수/allowlist, DB/커서 보관, API/config/model/env/dependency/SDK14/public15는 변경하지 않는다.

회귀는 실제 등록 handler→slack_search→API mock에서 명시 bot primary/같은 user·flag 없는 context/정확 prefix 및 알려진 permalink query를 합성 재현한다. status=ok/실제 match 객체/source/partial/queryless/primary bot 유지 및 thread 미승격과 logger/DB redaction을 검증한다. 기존 user 존재만으로 kind negative로 삼은 사례는 inferred가 known이 아니므로 **명시적 false로 보강**했다. false(유무 user)/false+bot_id/primary false+system/모든 관측 true-false·최신 생략·순서 permutation, source 혼합이지만 known 일치 positive, context-only 출력 계약 및 기존 author/thread/hash/cursor/cancellation/privacy 회귀를 유지한다. 합성 PASS는 live 검색 PASS가 아니다.

main이 최종 tested SHA 실제 diff/fresh 독립 리뷰 후 pinned squash/deploy SUCCESS/live SHA/restarts를 확인하고 새 actual search의 status=ok와 matches/source/partial을 원래 출처에 대조해야 한다. unavailable/history fallback 또는 원래 thread-read PASS는 검색 PASS의 대체가 아니다. 다음 guard 실패가 나오면 안전 고정 진단의 실제 원인만 별도 후속으로 수정한다. worker는 서버/E2E/배포/merge를 실행하지 않는다. 실제 성공 이후 임시 진단 제거는 별도 PR/review/deploy/회귀 E2E다.

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
3. 그 trusted requestId의 기존 token 단계와 response/check/failure reason/schemaField 또는 permalink predicate flags/고정 보조 enum, 충돌 역할/원천/available 비교 vector 및 thread/channel read reason을 bot 응답과 대조한다. 필요하면 같은 이벤트 안에서 원래 대상에 대한 명시적 thread read를 사용한다. raw response/debug/credential 공유 금지. 배포 SUCCESS/live SHA/restarts 확인 뒤 새 Slack thread 실제 검색 결과를 원래 SHKO 표식 thread 원문·수정 댓글 출처와 대조해야 한다.
4. 조회 API 응답/합성 테스트/로그만으로 실제 검색 PASS를 주장하지 않는다. 검색 없는 unavailable/채널 부모 발견을 PASS로 대체하지 않는다. 근거 확인 후 최소 fix를 별도 task/PR로 설계하며, 실제 검색/source 및 thread read 통과까지 후속 진행은 owner main 책임이다. PR104까지의 진단 PR 자체에는 acceptance 변경이 없었다. 현재 기능 수정의 kind acceptance/진단 의미 변경은 위 PR104 후속 항목 참조.
5. 근거 확보 후 **임시 response 및 action-token 진단 제거 후속 PR** 필요. worker 제출 후 수정 대기; 최종 stop/워크트리·브랜치 정리 및 `cleanup_completed` 종료 증명은 owner main 담당이다.
