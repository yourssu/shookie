# 공개 채널 검색 로컬 거절: 한시적 안전 진단

## PR110 후속: context 배열 20 가정 제거

배포 sha9598e81의 trusted `slack-event:Ev0C7APLRK8A`에서 두 번
`response_received → check_passed → schema_failed`, `schemaField=context_after`,
`schemaCode=too_big`, `schemaMissing=false`가 관측됐다. 첫 거절은 로컬
`context_messages.before/after.max(20)`이며 API/권한 실패 증거가 아니다.
원본 API body/count/content는 수집하지 않았고 downstream 통과도 미확인이다.
[공식 assistant.search.context 문서](https://docs.slack.dev/reference/methods/assistant.search.context/)의
limit20은 primary 검색 결과/페이지 한도이며 contextual 배열 20 상한은 명시하지 않는다.

이번 후속은 API primary20/page4·커서160 전달키/두 역할 hash·보안 가드를 유지하고,
context API shape 가정 대신 **내부 처리 예산**(페이지 전체 2,048 관측/recognized
text 1,048,576 UTF-8 bytes)을 도입한다. 검색 전용 **공개 출력 limits**는 전체
JSON 96,000 bytes/본문 projection 24,000 bytes이며 공유 thread/history 한도는
불변이다. 구현·malformed 입력 경계·partial 계약은 [운영 도구 문서](slack-read-tools.md)를 참고한다.
예산 초과는 기존 고정 `budget_exceeded`로 전체 실패하며 새 raw/count 로그는 없다.
아래 PR110 한시진단·24,000 비교 cap은 그대로 유지한다(authorization과 무관).

> 합성 >20 context/processing overflow/late invalid/실제 escaped JSON bytes/등록 및
> DB redaction 검증은 실제 검색 성공 증명이 아니다. **actual E2E: NOT RUN**.
> worker는 서버 접속·Slack 게시·merge·배포를 하지 않는다. main의 최종 SHA fresh
> 독립 리뷰와 pinned squash/deploy 후 새 MCP OpenClaw 검색 및 genuine other-channel
> source comparison이 필요하다. 실제 성공 후 main이 별도 진단 제거 task를 만든다.

## PR113 복원 후속: 같은 페이지의 검증된 primary 보존

사용자 원래 요청 '최근 슈타임에 어떤 업데이트 있었는지 슬랙 검색해서 알려줘'의
MCP replay에서 trusted `slack-event:Ev0C79DR6WCE` 네 호출 모두
`response_received → check_passed → schema_passed → cross_role_text_relation`이었다.
양쪽 page primary/context가 존재하고 users/kinds/threadsCompatible=true이나
동일/prefix/substring/trim/줄바꿈 비교는 false였다. API/스키마 실패가 아니며
원본 text/response/IDs/count는 수집하지 않았다. 모든 downstream 통과는 미확정이다.

이번 기능 수정은 모든 기존 검증 후 **양쪽 same-page + all-observation metadata 호환**에서
primary 본문/source/author/thread를 그대로 보존하고 비동일 대체 context 표현을 생략한다.
문자열 동등성이나 교차-role 권한 증명이 아니다. 생략은 complete=false/truncated=true로
cursor traversal에 sticky 유지한다. nonprefix는 primary 잘림 증거가 아니므로
textTruncated를 강제하지 않으며 실제 projection 잘림/기존 exact-prefix 규칙은 유지한다.
같은-role exact hash 충돌·양쪽 same-page 없는 unequal seed promotion은 계속 fail-closed다.
관측 hash/복합 키/160 전달키와 모든 예산·권한·취소 계약은 변경하지 않는다.

PR113의 helper/stage enums/primitive predicates는 그대로 유지한다. 기존
`cross_role_text_relation` enum도 제거하지 않지만 compatible same-page 비동일 본문은
이제 이 reason으로 거절하지 않는다. 새 모듈/로그필드/본문 덤프는 없다.
합성 검증은 실제 전체 coverage 성공 증명이 아니다. **actual E2E: NOT RUN**이며
main이 원래 슈타임 exact MCP 요청과 OpenClaw/current-marker 회귀를 실제 genuine
primary source와 독립 비교해야 한다. 실제 성공 및 별도 요청 전 진단을 제거하지 않는다.

## 목적과 운영 경계 (PR110 당시 진단 추가 범위)

PR108의 공개 채널 검색이 실제 요청에서 로컬 `unavailable`로 거절됐지만 단계가
확정되지 않았다. 이 변경은 **관측만 추가**한다. 권한, 검색 API, 스코프·출처,
당시 PREFIX-only guard, 명시적 kind 증거, all-observations 검사, composite `(channel,ts)` 키,
커서 seed/해시/160-key 제한, 취소, 반환 계약은 그대로다. SUBSTRING/trim/줄바꿈
비교는 진단일 뿐 허용 조건이 아니다. query의 root hint도 thread provenance가 아니다.

토큰·Socket Mode·receiver·thread read 진단을 재도입하지 않는다. 새 API 호출,
일반 API/debug 로그, 모델·설정·scopes·OAuth·자동 가입·history fallback 변경은 없다.
워커는 서버 접속, Slack 게시, 실제 E2E, 머지 또는 배포를 수행하지 않는다.

## 레코드 계약

이름은 `slack_cross_channel_search_diagnostic` 하나다. 검색 호출마다 최대 4개:
`response_received` → `check_passed` → `schema_passed` → 첫 거절 또는 `success`.
조기 거절은 앞의 breadcrumbs가 없을 수 있다. 로거 예외는 삼킨다.

- 모든 필드는 고정 stage/reason/field/code/role/kind enum 또는 boolean이다.
- 유일한 동적 문자열은 인증된 handler가 private WeakMap에 바인딩한 `requestId`.
  `correlationAvailable=false`이면 requestId가 없다. 일반 RequestContext/text의 ID는 무시한다.
- channel/team/user/author/ts, composite key, URL/query/cursor, API 코드·에러 객체·메시지,
  본문·원본 metadata, 토큰 값/해시/접두사/길이, 인덱스·길이·횟수는 기록하지 않는다.
- logger에 전달하기 전에 own data descriptor와 runtime primitive allowlist로 재투영한다.
  caller object spread/getter/proxy/revoked proxy/toJSON/coercion을 사용하지 않는다.
  이 레코드는 모델 응답, 일반 context, cursor 또는 DB에 넣지 않는다.

| stage | 고정 reason |
| --- | --- |
| preflight | preflight_failed, validation_exception |
| authorization | authorization_failed, current_public_required |
| prerequisites | prerequisites_missing (토큰·권한 metadata 관측 없음) |
| scopedtargetverification / resultchannelverification | scoped_target_failed / result_channel_failed |
| transport | transport_failed, response_received |
| check | check_failed, check_passed |
| schema | schema_failed, schema_passed, warning_present |
| primaryscope | primary_scope_mismatch, scoped_result_mismatch |
| contextscope / contexttime / threadscope | context_scope_mismatch / context_time_invalid / thread_scope_mismatch |
| permalink | permalink_parse_failed, permalink_invalid |
| samerolehash | same_role_hash_conflict |
| seed / crossroleuser / explicitkind / thread / relation | cross_role_seed_unverified / cross_role_user_conflict / cross_role_kind_conflict / cross_role_thread_conflict / cross_role_text_relation |
| budget | verification_budget, result_limit_exceeded, budget_exceeded |
| cursorreplay_conflict | cursor_invalid, cursor_conflict, cursor_replay |
| final | success (`finalSuccess=true`) |

API가 throw하면 **pending 고정 단계만** 기록한다. 진단 코드가 error code/message를
읽어서 원인을 추정하지 않는다. 기존 에러 처리의 사용자 status/message/retry delay와
공개 채널 verification 거절은 바꾸지 않는다. `validation_exception`은 분류되지 않은
검증 처리 예외이며 특정 guard 증거로 해석하지 않는다.

## 거절별 안전 부가 필드

- schema: **첫 issue만** `schemaField`, `schemaCode`, `schemaMissing`.
  현재 responseSchema의 전체 고정 path와 맞는 경우만 field label을 반환한다.
  배열 인덱스는 출력하지 않는다. 동적 key/path/received/message는 출력하지 않는다.
  미분류는 `unknown`; `schemaMissing=false`도 존재를 확증하지 않는다.
- scope: `channelIdAgrees/channelAliasAgrees/teamIdAgrees/teamAliasAgrees`.
  primary/context는 reason으로 구분. schema-parsed copies만 검사한다.
- permalink: `permalinkParsed`, `canonicalHttps/canonicalHref/verifiedWorkspace`,
  `noUserinfo/noPort/noHash`, `pathAgrees/pathChannelAgrees/pathMessageTsAgrees`,
  `queryKnown/queryDuplicate/queryEmpty/queryCidAgrees/queryRootValid`,
  `threadMetadataAvailable/queryRootAgrees`. 기존 URL parse와 거절 지점의 parsed 값만 사용한다.
  해당 거절에서 검사하지 않은 필드는 생략한다; 생략은 false가 아니다.
- hash: `role=primary|context`, `origin=page|cursor`, `cursorPresent`,
  `pagePrimaryPresent/pageContextPresent/seedPrimaryPresent/seedContextPresent`.
  기존 pageMetadata의 `primaryKnownKinds/contextKnownKinds=none|bot|participant|mixed|unknown`;
  cursor metadata를 새로 저장/복구하지 않는다. same-role에서는 이전 page 관측만 요약한다.
- cross-role: presence → users → explicit kind → threads 순서의 첫 실패.
  모두 통과한 same-page 비동일 본문은 primary 보존/대체 context 생략(partial)이다.
  과거 text_relation reason은 정확 prefix 관계 거절을 뜻했으며 enum은 유지한다.
  `usersCompatible/kindsCompatible/threadsCompatible`는 pageMetadata의 기존 Set에서만 계산한다.
  missing role은 presence 필드로 구분하고 compatible=true를 명시적 일치로 해석하지 않는다.
- text: `comparisonAvailable=true`일 때만 `equal`, `primaryPrefix/contextPrefix`,
  `primarySubstring/contextSubstring`, `trimEquals/lineEndingEquals`.
  둘 다 page-local validated text이며 **각각 24,000 code units 및 UTF-8 bytes 이하**여야 한다.
  same-role의 primary/context 라벨은 비교의 이전/현재 텍스트 방향을 뜻한다.
  cursor-only 또는 초과 크기는 `comparisonAvailable=false`, 나머지 비교 필드는 생략하여 unknown을 표현한다.
  원문 ephemeral reference는 기존 page map에만 있고 진단용 cursor text/meta retention은 없다.

## 담당자의 다음 검증

1. main이 전체 diff/테스트와 독립 리뷰를 확인한다. tested SHA를 고정하여 머지/배포하고
   live SHA·restart 수를 확인한다. 워커의 synthetic test PASS를 actual E2E PASS로 표시하지 않는다.
2. main이 실제 origin 공개 채널의 **새 인증 이벤트**로 OpenClaw 검색을 수행하고,
   해당 trusted requestId의 고정 stage/reason/predicate만 제한적으로 확인한다.
   broad debug, 원본 API/SDK body·토큰 덤프 또는 응답 본문을 모델 입력에 복사하지 않는다.
3. 새 실제 이벤트의 terminal refusal을 근거로 별도 기능 수정 PR을 결정한다.
   `success`는 로컬 페이지 검증 성공일 뿐: 실제 match와 타 채널/thread source 비교가 끝나야 E2E PASS다.
   로그 부재나 이전 generic conversationError/no persisted tool calls는 transport 미실행 증거가 아니다.
4. 실제 E2E PASS 이후 별도 cleanup PR에서 이 모듈·search 관측·해당 테스트/문서만 제거한다.

**실제 실패 단계는 위 text_relation으로 식별됨. 기능 수정 후 실제 E2E: NOT RUN (main 담당).**

## 로컬 검증과 복구

`yarn workspace database build`, `yarn workspace shookie build` 후 Slack tools,
actual main registration, handler/SDK wiring, cancellation 관련 테스트를 검증한다.
새 테스트는 runtime casts/getter/proxy/revoked/toJSON, whitelist, logger throw,
첫 Zod 누락 필드, metadata 첫 실패, same-page primary 보존/partial과 기존 prefix marker,
same-role/seed-only fail-closed, DB tool redaction, immutable seed/unlock/retry를 검사한다.

전체 suite 및 unrelated clone/snapshot/timeout 재현은 이 bounded task의 검증이 아니다.
기존 clone/snapshot timeout 실패가 해소됐다고 주장하지 않는다. 해당 실패가 나오면
SHA·정확한 command·exit 및 bounded log를 남겨 별도 처리한다. timeout을 늘리거나
assertion을 약화하거나 중복 full suite를 반복하지 않는다. runner 복구 절차는
[test-runner-reliability.md](test-runner-reliability.md)를 참고한다.
