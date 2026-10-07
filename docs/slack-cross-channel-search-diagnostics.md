# 공개 채널 교차 검색 진단 제거 — 과거 관측 아카이브

이 문서는 PR110의 한시진단과 PR111의 실제 검증 근거를 보존한다. 현재 활성 로그
계약이나 재현 지침이 아니다. `cross-channel-search-diagnostics.ts`와 전용 테스트,
검색의 stage/breadcrumb/predicate/비교/성공·실패 emit은 제거했다.
`slack_cross_channel_search_diagnostic` 및 앞서 제거한 3종 임시 emit은 production에 없다.
기능·권한·pagination 설명은 [Slack 읽기 도구](slack-read-tools.md)를 기준으로 한다.

## 과거 실패와 PR111 기능 제약

PR110 배포 `9598e81`의 trusted `slack-event:Ev0C7APLRK8A`에서 두 번
`response_received → check_passed → schema_failed`가 관측됐다. 첫 issue는
`context_after / too_big / schemaMissing=false`였다. 당시 로컬 context 배열의
`.max(20)` 거절이며 API/권한 실패의 증거는 아니었다. 원본 API body/count/content는
수집하지 않았고 이 관측만으로 downstream 성공을 주장하지 않는다.
[공식 assistant.search.context 문서](https://docs.slack.dev/reference/methods/assistant.search.context/)의
limit20은 primary 결과/페이지 한도이며 context 배열의 20 상한은 명시하지 않는다.

PR111은 context API shape 가정 대신 고정키·single-read `validationSnapshot`과
내부 처리 예산을 적용했다. 진단 제거 후에도 다음 계약은 불변이다.

- 페이지 전체 primary+context 2,048 관측, recognized text 총 1,048,576 UTF-8 bytes,
  non-text metadata 선행 상한 4,096 code units. 예산 초과는 페이지 전체 unavailable이며
  초과 데이터를 자른 뒤 성공 처리하지 않는다. unknown/raw 객체 순회·직렬화는 없다.
- primary 최대20/page4, context 포함 display40/page, 전달 cursor160 composite keys와
  역할별 원문 hash. 반환 전체 JSON96,000 bytes/page, per-text projection24,000 JSON bytes.
- 모든 관측의 역할별 user/kind/thread Set과 same-role hash 검사 유지. 비동일 cross-role은
  presence → users → explicit kind → thread → 정확 PREFIX 순서로 short-circuit한다.
  SUBSTRING/trim/줄바꿈 비교는 과거 진단뿐이었으며 허용 조건이 아니었다.
- canonical permalink 및 known navigation query acceptance는 그대로다. root hint는
  thread provenance/권한이 아니며 검증 후 query를 제거한다.
- live 권한·actual source·role promotion·composite 키·cursor replay/binding/seed 불변성,
  output 검증 후 cursor transaction·finally unlock·취소 계약을 유지한다.
- 인증된 requestId/action_token의 비공개 WeakMap binding, SDK 로그 차단, 안전 오류,
  도구/DB redaction, current-only history/첨부/image 경계와 표준 SocketMode/logger는 불변이다.

## PR111 실제 성공 근거 (main 제공, 제거 worker의 E2E 아님)

새 실제 MCP 요청 `p1791350565366419`의 trusted `slack-event:Ev0C7ENK7VM2`에서
`response_received / check_passed / schema_passed / success`를 3회 확인했다.
최종 bot 결과는 workspace_public pages1–3 모두 status=ok였고,
terminal은 `complete=false / truncated=true / nextCursor=null`인 **정직한 partial**이었다.
진단 success는 각 로컬 페이지 검증 성공이지 전체 workspace coverage의 증거가 아니다.

실제 other-channel primary `C0AKBED3QDQ / p1774425171175779`의 내용은
독립 MCP read와 일치했다: **genuine primary 한 건의 source comparison PASS**다.
운영 bot의 “primary 48” 주장은 bot 결과 요약으로 구분하며, 48건 전부의 내용에 대한
독립·exhaustive 검증 PASS로 승격하지 않는다. raw body/token/count 로그를 수집하지 않았다.
이 아카이브에도 본문·토큰·원본 응답·cursor를 복사하지 않는다.

## 제거 PR의 검증 경계

worker의 로컬 검증은 합성 Slack tools/실제 main registration·handler 배선/취소 및
DB·shookie build다. 등록 경로의 >20 context 회귀와 보안/DB 거절 검증을 보존한다.
전체 suite 및 실제 Slack E2E는 **NOT RUN**이며 기존 unrelated snapshot/clone timeout이
해소됐다고 주장하지 않는다. timeout/assertion을 완화하지 않는다.

main이 최종 tested SHA의 fresh 독립 읽기전용 full-diff 리뷰, pinned merge/deploy 및
새 MCP cross-channel search/continuation, other-channel thread/current marker 회귀와
임시 emit 부재 확인을 담당한다. 위 PR111의 이전 PASS는 진단 제거 배포 후 최종 회귀
PASS를 대체하지 않는다. worker는 서버 접속·Slack 게시·머지·배포·실제 E2E를 실행하지 않는다.
