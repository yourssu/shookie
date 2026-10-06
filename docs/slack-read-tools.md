# Slack 명시적 검색·읽기 도구 (기존 bot token only)

## 범위 / 실제 연결

기존 호출 thread 자동 맥락 수집(`slack/slack-thread-source.ts`)은 그대로 유지한다. 모델이 필요할 때 메인 에이전트의 명시적 도구를 호출한다.

- `slack_search`: **현재 공개 채널 메시지의 실제 키워드 검색**. `assistant.search.context` + 기존 bot token + **현재 인증된 이벤트의 action_token** 사용. private/DM/MPIM 검색은 미지원.
- `slack_read_thread`: 현재 요청 채널의 별도 부모 ts/같은 workspace permalink로 원문·댓글 읽기.
- `slack_read_channel`: 현재 요청 채널의 최근 기록 읽기. 댓글/파일은 자동으로 펼치지 않는다.

`src/index.ts`의 기존 `createAgent()` → `agent/index.ts`가 기존 `config.SLACK_BOT_TOKEN`만 사용하는 전용 SDK client 생성 → main factory → `createMainShookieTools` → `createSlackReadTools`. `registerHandlers(app, agent)`가 같은 메인 에이전트에 인증된 event RequestContext를 전달한다. 기존 factory 호출 API는 호환된다. 별도 user token/OAuth/MCP credential, 환경변수, dependency, 쓰기 도구, 앱 권한/배포 설정 변경은 없다.

SDK timeout 10초, `retryConfig: { retries: 0 }`, `rejectRateLimitedCalls: true`. 전용 client의 **모든 SDK logger 메서드는 no-op**이며 DEBUG 설정으로도 요청 action_token/응답/원본 오류를 출력하지 않는다. 실제 SDK + synthetic adapter 테스트로 검증한다. 기존 `app.client`의 스트리밍/재시도 동작은 바꾸지 않는다. 테스트/다른 모듈에서 client를 주입할 때도 같은 비밀로그 차단·timeout·무재시도 정책을 준수해야 한다.

## 공식 bot-token 검색 지원과 운영 설정

공식 문서 확인: 2026-10-04.

- [`search.messages`](https://docs.slack.dev/reference/methods/search.messages/)는 user-token 전용 **legacy API**다. 이 도구는 해당 API를 사용하지 않는다. legacy API 불가를 Slack bot 검색 전체의 불가로 일반화하면 안 된다.
- [`assistant.search.context`](https://docs.slack.dev/reference/methods/assistant.search.context/) / [Real-time Search API 가이드](https://docs.slack.dev/apis/web-api/real-time-search-api/)는 **bot token + action_token** 검색을 지원한다. `search:read.public`은 Bot/User scope, private/im/mpim 검색 scopes는 User 전용이라 이번 범위에서 제외한다.
- 공식 가이드의 `Using the action_token`: bot API 호출마다 action_token이 필수이며 app_mention 또는 message 이벤트로 수신한다. app_mention은 `@app-name` 멘션 시, DM 메시지는 멘션 없이도 수신 가능하다. 이 구현은 현재 공개 채널로만 검색하므로 DM에서 받은 token으로 다른 공개 채널을 검색하지 않는다.
- API 최대 **20 search matches/페이지**, 검색 pagination도 user/workspace rate limit에 포함된다. timestamp sort는 keyword retrieval이며 relevance/semantic 결과와 같지 않을 수 있다. 이 구현은 `disable_semantic_search: true`, timestamp ascending을 명시한다.

**운영자 선행 설정 (이 PR에서 실제 앱 설정은 변경하지 않음)**:

1. 워크스페이스/앱의 AI/Real-time Search 기능 사용 가능 여부와 앱 설정을 확인한다. `feature_not_enabled`이면 지원/설정 안내를 그대로 제공한다.
2. 기존 bot 설치에 최소 `search:read.public`을 운영자가 승인/설치해야 한다. 채널 검증에는 기존 `channels:read`도 필요하다. user search scope/OAuth를 추가하지 않는다.
3. app_mention 또는 해당 message 이벤트 구독 및 **event payload action_token 수신**을 확인한다. 본문의 token 문자열·일반 RequestContext entry·도구 인자로 대체하지 않는다.
4. 토큰 누락/만료·missing_scope·429·API 장애는 빈결과와 다르다. 새 이벤트/관리자 설정 안내를 제공하며 광역 검색, legacy 검색, history 전체 scan, user OAuth로 우회하지 않는다.

[`conversations.history`](https://docs.slack.dev/reference/methods/conversations.history/)는 관련 bot `*:history` scope + bot 참여 대화 읽기를 지원한다. 현재 [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/) Facts/Scopes HTML에도 Bot/User의 channels/groups/im/mpim:history가 표시되지만 **실제 설치별 bot-token replies 성공은 미검증**이다. `not_allowed_token_type`/대화 유형 지원 거절 시 unsupported이며 다른 credential/history scan으로 우회하지 않는다. history/replies는 배포 유형에 따라 15개 및 1회/분 제한이 적용될 수 있어 페이지당 15개만 요청한다.

## 신뢰 / 권한 / action_token 경계

**봇 접근 ≠ 요청자 접근.** 코드에서 매 조회/continuation/bridge 호출마다 검증한다.

1. 인증된 원본 인간 이벤트만 handler가 처리한다 (bot/system/edit/delete 제외). requester, team, 실제 event channel, requestId는 불변 WeakMap identity에 바인딩한다. 모델 text, 과거 댓글, 일반 `RequestContext.get` 값, Assistant의 threadTs-only 현재-view hint는 권한이 아니다. 팀이 없으면 명시적 조회는 fail closed.
2. action_token은 **별도 비공개 WeakMap**에만 보관한다. exported identity/일반 RequestContext entries/model messages/tool input/output/DB identity·tool-call 기록에 넣지 않는다. action_token은 사용자 OAuth token이 아니며 사용자에게 입력/발급을 요구하지 않는다. SDK transport만 해당 값을 사용한다. 응답의 임의 action_token/blocks/auth 필드는 투영하지 않고, 원문에 현재 action_token이 포함되어도 redact + 부분조회 표시한다.
3. target channel은 현재 이벤트 channel과 정확히 같아야 한다. 다른 public/private/DM은 API 호출 전 차단한다. `auth.test` bot/team, `conversations.info` id/context_team 검증 및 shared/Slack Connect/org-shared/MPIM 차단.
4. 일반 C/G 채널은 requester membership을 200명 × 최대 3페이지로 live 확인한다. 봇 membership만으로 통과하지 않으며 못 찾으면 거부한다. DM은 `is_im` 및 peer=user 일치를 확인한다. membership 무한 순회·auto-join 없음.
5. 검색은 info의 `is_private === false`인 현재 public 채널만 지원한다. 고정 `channel_types: ['public_channel']`, `content_types: ['messages']`, `context_channel_id: currentChannel`, 서버가 만든 `in:<#currentChannel>` 필터 사용. query는 일반 문자/숫자/공백/underscore/hyphen 단어만 허용하고 각각 quote한다. `in:`, `from:`, OR/AND/NOT, 괄호/기호 등 caller 연산자는 거부한다. semantic 재해석도 비활성화한다.
6. 실제 검색 match의 필수 channel_id/team_id와 추가 scope fields를 모두 검증한다. context before/after는 공식 schema상 channel/team을 생략하고 검증된 parent match의 scope를 상속한다. 명시적 channel_id/channel/team_id/team이 있으면 모두 일치해야 한다. 잘못된 match/context scope를 조용히 버리고 나머지를 반환하지 않고 **그 페이지 전체를 실패**시킨다. 다른 content types, 잘못된 ts/순서/permalink도 실패한다.
7. 반환 bot actors/원문은 비신뢰 데이터이며 인증/승인 역할로 승격하지 않는다. SDK/도구 errors는 sanitized status/한국어 안내만 반환한다. handler는 Slack tool args/results/cursors를 debug 및 DB tool-call 로그에서 redacted 처리하고 해당 응답 preview도 INFO에 남기지 않는다. 기존 일반 conversation 저장/답변 정책은 유지한다.

최소 read scope: 현재 public에는 `channels:history` + `channels:read`, private 읽기에는 `groups:history` + `groups:read`, bot DM 읽기에는 `im:history` + `im:read`. 읽기 scope가 검색 private/DM 지원을 부여하지 않는다. 파일 scope/metadata/download는 이 모듈의 도구 범위가 아니다.

## 입력 / 출력 / pagination

읽기 ts는 소수점 정확히 6자리 (`1700000000.000001`). permalink는 HTTPS workspace host/archive/current channel/ts 일치, credentials/port/hash/알 수 없는 query/중복 query/모순 ts·channel을 엄격히 검증하며 **HTTP fetch하지 않는다**. 정상 댓글 링크의 `thread_ts=<parent>&cid=<currentChannel>`도 지원한다.

검색 입력 예: `{"query":"출시 plan","limit":20}`. 도구 인자는 strict schema이며 actor/team/action_token/filters를 추가할 수 없다. API response의 공식 예시처럼 1~6자리 fractional ts는 검증 후 6자리로 normalize한다. primary permalink는 인증된 workspace/current channel/message ts에 대응하는 canonical URL만 반환한다. 검색 permalink의 decoded query는 thread_ts/cid만 각각 옵션으로 허용하며 unknown/empty/duplicate는 거부한다. cid는 현재 채널 exact 일치, thread_ts는 기존 API timestamp bounds/6자리 소수 정규화 후 root<=message(BigInt)와 존재하는 metadata.thread_ts 일치를 검증한다. query는 검증 후 제거하고 metadata.thread_ts가 없으면 반환 threadTs/권한/출처로 승격하지 않는다. query 없는 링크와 bare ?/# 경계는 기존대로 유지한다. [관측 근거·공식 문서와 규범 구분·정규화 계약](slack-search-response-diagnostics.md)을 참조한다.

공통 출력: `status`, `message`, source channel/threadTs, message channel/ts/threadTs, author(userId/botId/kind), text, textTruncated, page, nextCursor, complete/truncated, limits. 검색은 `api: assistant.search.context`, primary의 `searchMatch: true` 및 permalink, context의 `searchMatch: false`/contextForTs/contextPosition을 추가한다. 주변 context를 검색 match로 주장하지 않는다. blocks/files/user/channel results는 읽지 않는다.

- 읽기 15개/페이지, 검색 최대 20개 **primary matches**/페이지 (`limit` 1~20), 각 traversal 최대 4페이지. 검색은 주변 context 포함 투영 메시지 최대 40개이며 생략된 context는 truncated다. 모델이 nextCursor를 명시적으로 사용해야 하며 자동 무한 탐색은 없다.
- cursor는 원본 Slack cursor가 아닌 임의 opaque ID, team/requester/current channel/requestId/tool/target 및 검색 query/limit에 바인딩. 10분 만료, 성공 후 1회용, 동시 재사용 거부, 최대 1,000개 보관. continuation마다 live 권한 재확인. 실패 시 원 cursor는 재사용 가능하지만 다른 actor/target/query에 쓸 수 없다.
- 매 페이지는 시간순이다. channel next page는 더 오래된 기록이다. thread/search는 해당 API pagination을 따른다. 여러 페이지의 message를 합칠 때 channel/ts로 중복 제거하고 시간순 정렬한다. 검색 전달 이력은 primary/context를 구분한다: 앞 페이지에 context-only로 보였던 메시지가 다음 페이지 primary match이면 searchMatch=true 및 primary permalink/thread/actor metadata를 다시 반환해 승격한다. 페이지들을 합칠 때 primary를 context보다 우선해야 한다. 이미 전달된 실제 primary 또는 context-only의 context 재등장은 중복 제거한다. 같은 페이지의 여러 context 관계는 첫 번째 검증된 관계(contextForTs/contextPosition) 하나로 대표하며, 동일 ts의 primary가 있으면 primary 하나만 반환한다. 이는 모든 parent-context 관계의 열거가 아니라 메시지 단위 전달 계약이다. 본문 충돌은 역할에 관계없이 실패하며, 한도 때문에 제외된 객체는 전달한 것으로 기록하지 않고 traversal을 truncated로 유지한다.
- text 예산 8,000 JSON 바이트/메시지, 투영 메시지 예산 24,000 JSON 바이트/페이지 (배열 envelope 제외). Unicode/JSON escape 바이트를 보존해 자르며 textTruncated를 표시한다. 빈 text라도 metadata는 보존한다. 검색은 matches를 context보다 우선 투영한다.
- complete는 **전체 cursor traversal에서 반환된 모든 페이지를 합친 조회 범위**다. 마지막 페이지 하나가 전체 결과는 아니다. next cursor/has_more, 텍스트·context 생략, 알려진 thread reply_count 누락/변경은 complete가 아니다. 댓글 수 미확인 thread도 partial. 일반 단일 unthreaded terminal 첫 페이지는 댓글 0으로 간주 가능. Atomic snapshot/동시 편집·삭제 감지는 보장하지 않는다.
- 검색 complete는 API의 **키워드 search result set**에 대한 것이지 채널 전체 기록/모든 관련 의미를 찾았다는 보장이 아니다. channel complete도 모든 thread 댓글/첨부를 읽었다는 뜻이 아니다.
- `ok + []`는 빈결과, unsupported/access_denied/invalid_target/rate_limited/unavailable는 실패/차단. `complete: false`의 실패를 성공 빈결과로 요약하지 않는다. `truncated`는 성공한 partial 조회 표시다.

## 첨부 worker용 안정 public bridge (파일 모듈과 분리)

`shookie/src/tools/slack/authorization.ts`의 승인된 공통 API:

```ts
authorizeCurrentSlackChannel(client, requestContext, { channelId?, workspaceHost? })
// Promise<Readonly<{ identity, channelId, kind, workspaceHost? }>>

readAuthorizedSlackMessage(client, requestContext, { messageTs, threadTs?, channelId? })
// Promise<Readonly<{ channelId, messageTs, threadTs?, fileIds: readonly string[] }>>
```

- 두 함수 모두 기존 sealed RequestContext identity와 bot/team/current channel/live membership 또는 DM peer를 검증한다. raw bot client/token/action_token/auth response를 반환하지 않는다. error는 `SlackReadAccessError`의 sanitized `.status`/`.message`/`.result`만 사용한다.
- `authorizeCurrentSlackChannel` 반환은 감사/scope 메타데이터이지 재사용 가능한 authorization capability가 아니다. cached grant로 후속 조회/다운로드를 승인하면 안 된다.
- exact API는 root/plain 메시지를 `history(oldest=latest=messageTs,inclusive=true,limit=1)`로, reply는 검증된 parent threadTs와 `replies(oldest=latest=messageTs,inclusive=true,limit=15)`로 가져온다. 정확한 messageTs가 단 하나 있어야 하며 scope/thread/partial/중복을 검증한다. reply 조회에 부모를 모르면 실패하며 전역/채널 scan fallback하지 않는다.
- 반환은 **그 exact 메시지의 실제 files[].id만**이다. 부모 message의 첨부를 reply 첨부로 대체하지 않는다. 메시지 text/파일 metadata/URL/files.info/download를 반환하거나 실행하지 않는다. 불변 결과/array다.
- 첨부 worker의 `authorize(fileId,messageTs)`는 trusted 원본 context로 이 exact API를 호출하고 반환 fileIds에 fileId가 실제 포함되는지 확인한 뒤에만 자신의 files.info/download 경로로 진행해야 한다. 모델 text/일반 RequestContext entries/단순 files.info 성공은 메시지 연결/사용자 접근 증거가 아니다. 작업이 지연되거나 새 요청이면 다시 live 검증한다.
- 이 bridge는 user token/OAuth/다른 채널/새 도구를 추가하지 않는다. 첨부 module 및 실제 파일 metadata/download/처리는 해당 worker 소유다. 이 PR은 첨부 구현을 수정하지 않는다.

## 임시 응답 실패 안전 진단

[검색 응답/본문 충돌 진단](slack-search-response-diagnostics.md)과 [thread/channel 읽기 실패 진단](slack-read-response-diagnostics.md)은 trusted requestId 및 고정 enum/boolean만 기록한다. 검증·출처·반환·권한·취소 가드는 그대로이며 원문/hash/길이/ID/커서·토큰을 추가 저장하지 않는다. 실제 검색·thread read는 아직 FAIL인 관측과 합성 테스트 PASS를 구분하고, 근거 기반 fix 및 실제 성공 뒤 임시 진단 제거는 별도 후속이다.

## 임시 action_token 안전 진단

수신의 고정 후보 위치와 실제 선택 → WeakMap 바인딩 → 검색/API 직전 상태만 INFO boolean/enum 로그로 관찰한다. 토큰 선택/권한/fallback은 바꾸지 않는다. [전달 구조 근거·필드 계약·해석 및 단일 UI 멘션 재현](slack-action-token-diagnostics.md)을 따른다. 운영 증거 확보 후 진단 제거 후속 PR이 필요하다.

## 검증 / 실제 Slack E2E 미실행

관련 자동 테스트는 mock Slack API + 실제 Mastra main factory/tool execute/실제 handler 배선 및 실제 SDK synthetic adapter로 token 로그 차단을 검증한다. 검색 성공/공식 shape/context/bots/provenance, scope/query 주입, trusted action_token 전달과 위조 차단, 20 matches·budget·bounded cursor·partial, 설정/권한/429/빈결과 구분, bridge live 권한/exact message/file IDs, 기존 thread/DM 회귀가 포함된다.

**이번 정규화 수정의 실제 Slack/실제 LLM E2E는 worker가 미실행**했다. main의 이전 PR100 E2E에서는 알려진 query가 있는 permalink 때문에 로컬 unavailable였음을 확인했으며 검색 PASS가 아니다. 이번 합성 회귀는 그 query 형태만 재현해 등록 도구의 queryless 반환·metadata.threadTs 미승격을 확인한다. 배포 후 새 Slack thread에서 실제 검색 결과와 원래 SHKO 표식 원문·수정 댓글 출처를 대조하는 검증은 main 책임이다. 공식 API 지원·조회 API 성공·합성 PASS는 운영 워크스페이스 실제 검색 성공을 보증하지 않는다. 운영자는 허용된 테스트 public 채널에서 기존 bot의 scope/feature/action_token event 수신을 확인하고 검색 성공/페이지·context·partial/source를 검증해야 한다. 현재 private/DM에서 읽기와 검색 unsupported의 구분, 다른 private 채널 링크/임의 in: 검색 차단, 429/토큰 만료 안내 및 server 로그 비밀 미기록도 확인한다. 설치 실패를 user token 추가/광역 스캔으로 해결하지 않는다.

전체 기본 timeout suite의 기존 Code Explorer snapshot 실패는 이번 Slack 변경으로 해결했다고 주장하지 않는다. timeout을 늘린 이전 실행은 기본 timeout 문제 해결의 증거가 아니며 해당 원인 진단은 별도 담당 작업이다.
