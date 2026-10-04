# Slack 스레드 맥락

## 동작과 신뢰 경계

- 채널 최상위 `app_mention`은 해당 event 본문을 사용한다(슈키 멘션만 제거). DB 이력을 섞지 않는다.
- 기존 스레드 댓글의 `app_mention`은 **그 event의 channel/thread만** `conversations.replies`로 조회한다. 최상위 원문부터 현재 멘션까지 시간순으로 전달한다. 현재 입력을 별도로 덧붙이지 않는다.
- 이전 슈키 답변은 native `assistant`, 사람 및 다른 봇은 `user`. JSON 본문의 작성자 ID/봇 ID/시각은 **비신뢰 데이터**이며 인증·권한·승인의 근거가 아니다. 실제 actor는 기존 trusted event의 RequestContext로만 전달한다.
- 파일/이미지/첨부는 다운로드하거나 해석하지 않고 `text`만 사용한다. 첨부 자체의 내용을 읽었다고 주장하지 않는다.
- DM은 기존 DB 기반 최근 15턴/48,000 UTF-8 byte 경로를 유지한다. 모든 경로는 기존 claim/dedupe, 스레드 직렬 처리, 성공한 현재 user/assistant pair의 DB 저장을 유지한다. Slack 원문이나 요약을 DB 대화 턴으로 재삽입하지 않는다.

## 전체 조회와 길이 제한

cursor를 끝까지 읽고 root/current 존재, reply_count, 중복 일관성, 빈 페이지, warning/error, 반복 cursor 및 `has_more`를 검사한다. cursor 없는 `has_more`는 부분조회로 처리한다(추측으로 시간 페이지를 건너뛰지 않는다). 1,000페이지/원문 4MB 안전 한도 초과도 부분조회로 처리한다. 새 댓글과의 race 재조회/스냅샷 보장은 이번 범위에 없다.

48,000 UTF-8 byte를 초과하면 **root 원문 + 오래된 댓글 요약(user 데이터) + 연속된 최근 댓글 원문(현재 멘션 포함)**을 전달한다. 오래된 모든 댓글은 동일한 `LLM_BASE_URL`/`LLM_MODEL`로 도구 없이 순차 요약하며, 요약 여부/댓글 수를 context에 명시하고 응답에서도 요약 사실을 알리도록 지시한다. 요약은 system 권한으로 승격하지 않는다. 요약 입력도 실제 JSON 인코딩 기준 48,000 byte 이하, 요약 출력은 8,000 byte 이하로 검사한다. 모델 토큰 한도 및 도구/기본 system 프롬프트 크기는 이 byte 한도와 별개다.

root/현재 원문 보존이 불가능하거나 오래된 개별 댓글이 38,000 byte를 초과하여 안전하게 요약하지 못하는 경우, 요약 실패/잘린 출력/빈 출력/크기 초과, 조회 실패/부분조회 시 **답변용 모델 및 plan 스트림 실행을 차단**하고 한국어 안내만 보낸다. 조용히 일부 댓글을 버리거나 불완전 맥락으로 답하지 않는다.

## Slack 앱 권한과 실제 환경 검증

공식 근거: [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/), [pagination](https://docs.slack.dev/apis/web-api/pagination/).

조회는 **기존 `app.client`의 bot token만** 사용하며 별도 인증 설정이나 인증 전환 경로를 추가하지 않는다. 조회 대상은 trusted bot-mention event의 channel/thread만이다. 토큰/원본 Slack response를 로그·사용자 안내에 출력하지 않는다.

현재 공식 method Facts의 Bot token 항목은 `channels:history`, `groups:history`, `im:history`, `mpim:history`를 표시하고 usage info에는 과거의 bot DM-only 설명이 없다. 과거 설명과 상충하므로 **bot token으로 채널 스레드가 항상 가능/불가능하다고 단정하지 않는다**. 환경에 따라 `not_allowed_token_type`, `missing_scope`, `no_permission`, 멤버십/접근 제한이 발생할 수 있으며 모두 fail-closed 안내 처리한다. 실제 설치 환경의 E2E 검증이 필요하다.

Slack 앱 권한 설정은 사용자가 직접 담당한다. 공개 채널은 `channels:history`, 비공개 채널은 필요할 때만 `groups:history` 및 앱의 해당 채널 접근을 확인한다. 이 PR은 앱 권한/운영 설정이나 DB를 변경하지 않으며 환경변수·Secret·배포 계약을 추가하지 않는다. 내부 앱은 공식 Tier 3 적용 여부를 확인해야 한다. 상업적 비-Marketplace 신규 설치의 경우 1회/분 및 페이지 최대 15개 제한이 있으므로 다중 페이지 실제 동작/ratelimit를 실제 환경에서 확인해야 한다. 요청 limit은 15로 설정한다.

## 검증 구분

구현자 검증: synthetic Slack API 페이지/권한오류/부분조회, 실제 handler/runtime 연결, native 역할/작성자, current/root 중복 방지, DB 저장/dedupe/DM 회귀, Unicode byte budget, 요약 실패 차단 및 TypeScript 빌드.

**실제 Slack E2E 미실행**: 기존 bot token으로 공개/비공개 채널 조회, 앱 scope/멤버십, pagination/rate limit, Slack UI 출력 및 실제 LLM 요약 품질은 검증하지 않았다. 실제 LLM 네트워크 호출도 실행하지 않았다. 배포 전 대상 설치 환경에서 확인해야 한다.
