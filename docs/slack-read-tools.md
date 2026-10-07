# Slack 명시적 검색·읽기 도구 (기존 bot token only)

## 범위 / 실제 연결

기존 호출 thread 자동 맥락 수집(`slack/slack-thread-source.ts`)은 그대로 유지한다. 모델이 필요할 때 메인 에이전트의 명시적 도구를 호출한다.

- `slack_search`: **같은 workspace 비공유 공개 채널의 실제 키워드 검색**. `channel` 생략은 native workspace-public 검색, 지정하면 해당 공개 채널만 검색한다. `assistant.search.context` + 기존 bot token + **현재 인증된 이벤트의 action_token** 사용. 현재 origin은 공개 채널이어야 한다. private/DM/MPIM에서의 검색, 외부 workspace/공유 채널 검색은 미지원.
- `slack_read_thread`: 현재 요청 채널의 기존 읽기를 유지하며, **다른 비공유 공개 채널**의 명시적 `channel + 부모 ts` 또는 같은 workspace HTTPS permalink도 지원한다. 타 채널 full thread는 요청자 live membership과 bot 읽기 권한이 필요하다. 타 private/DM/MPIM·공유 채널은 차단한다.
- `slack_read_channel`: 현재 요청 채널의 최근 기록 읽기. 댓글/파일은 자동으로 펼치지 않는다.

`src/index.ts`의 기존 `createAgent()` → `agent/index.ts`가 기존 `config.SLACK_BOT_TOKEN`만 사용하는 전용 SDK client 생성 → main factory → `createMainShookieTools` → `createSlackReadTools`. `registerHandlers(app, agent)`가 같은 메인 에이전트에 인증된 event RequestContext를 전달한다. 기존 factory 호출 API는 호환된다. 별도 user token/OAuth/MCP credential, 환경변수, dependency, 쓰기 도구, 앱 권한/배포 설정 변경은 없다.

SDK timeout 10초, `retryConfig: { retries: 0 }`, `rejectRateLimitedCalls: true`. 전용 client의 **모든 SDK logger 메서드는 no-op**이며 DEBUG 설정으로도 요청 action_token/응답/원본 오류를 출력하지 않는다. 실제 SDK + synthetic adapter 테스트로 검증한다. 기존 `app.client`의 스트리밍/재시도 동작은 바꾸지 않는다. 테스트/다른 모듈에서 client를 주입할 때도 같은 비밀로그 차단·timeout·무재시도 정책을 준수해야 한다.

## 공식 bot-token 검색 지원과 운영 설정

공식 문서 확인: 2026-10-04.

- [`search.messages`](https://docs.slack.dev/reference/methods/search.messages/)는 user-token 전용 **legacy API**다. 이 도구는 해당 API를 사용하지 않는다. legacy API 불가를 Slack bot 검색 전체의 불가로 일반화하면 안 된다.
- [`assistant.search.context`](https://docs.slack.dev/reference/methods/assistant.search.context/) / [Real-time Search API 가이드](https://docs.slack.dev/apis/web-api/real-time-search-api/)는 **bot token + action_token** 검색을 지원한다. `search:read.public`은 Bot/User scope, private/im/mpim 검색 scopes는 User 전용이라 이번 범위에서 제외한다.
- 공식 가이드의 `Using the action_token`: bot API 호출마다 action_token이 필수이며 app_mention 또는 message 이벤트로 수신한다. app_mention은 `@app-name` 멘션 시, DM 메시지는 멘션 없이도 수신 가능하다. 이 구현은 공개 origin에서만 검색을 허용하므로 DM에서 받은 token으로 공개 채널을 검색하지 않는다. `search:read.public`은 설치된 workspace에서 요청자가 접근 가능한 모든 공개 채널을 native RTS로 검색한다. 요청자가 대상 채널 member일 필요는 없으며 bot 미가입만으로 검색 결과를 버리지 않는다. `context_channel_id`는 항상 trusted origin이다. model target으로 origin context를 바꾸지 않는다.
- API 최대 **20 search matches/페이지**, 검색 pagination도 user/workspace rate limit에 포함된다. timestamp sort는 keyword retrieval이며 relevance/semantic 결과와 같지 않을 수 있다. 이 구현은 `disable_semantic_search: true`, timestamp ascending을 명시한다.

**운영자 선행 설정 (이 PR에서 실제 앱 설정은 변경하지 않음)**:

1. 워크스페이스/앱의 AI/Real-time Search 기능 사용 가능 여부와 앱 설정을 확인한다. `feature_not_enabled`이면 지원/설정 안내를 그대로 제공한다.
2. 기존 bot 설치에 최소 `search:read.public`을 운영자가 승인/설치해야 한다. 채널 검증에는 기존 `channels:read`도 필요하다. user search scope/OAuth를 추가하지 않는다.
3. app_mention 또는 해당 message 이벤트 구독 및 **event payload action_token 수신**을 확인한다. 본문의 token 문자열·일반 RequestContext entry·도구 인자로 대체하지 않는다.
4. 토큰 누락/만료·missing_scope·429·API 장애는 빈결과와 다르다. 새 이벤트/관리자 설정 안내를 제공하며 legacy 검색, 광역 history scan, auto-join, user OAuth로 우회하지 않는다. native workspace-public 검색은 지원 범위지만 history 광역 순회 fallback은 아니다.

[`conversations.history`](https://docs.slack.dev/reference/methods/conversations.history/)는 관련 bot `*:history` scope + bot 참여 대화 읽기를 지원한다. 현재 [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/) Facts/Scopes HTML에도 Bot/User의 channels/groups/im/mpim:history가 표시된다. main의 현재 설치에서 별도 bot-token direct API 구조 검증 이후 PR103의 **실제 명시적 thread read 3페이지 complete E2E PASS**를 확인했다. 다른 설치의 지원이나 이번 진단 제거 코드의 배포 후 재검증을 보장하지 않는다. `not_allowed_token_type`/대화 유형 지원 거절 시 unsupported이며 다른 credential/history scan으로 우회하지 않는다. history/replies는 배포 유형에 따라 15개 및 1회/분 제한이 적용될 수 있다. 명시적 reader의 공개 pageSize/응답 상한은 15이며 history API limit은 15다. thread API limit은 부모 1자리 예약을 위해 모든 페이지에서 14다(부모 없는 continuation도 14). main의 별도 direct API 구조 관측에서 root+요청 reply가 첫 페이지와 continuation에 포함됐기 때문이며, Slack 공식 limit 문구가 부모 추가를 명시한 것은 아니다. 15 초과 응답은 계속 unavailable이고 자른 뒤 cursor 이동/추가 조회는 없다. 이는 직접 API 구조 근거이지 Shookie E2E PASS가 아니다.

## 신뢰 / 권한 / action_token 경계

**봇 접근 ≠ 요청자 접근.** 코드에서 매 조회/continuation/bridge 호출마다 검증한다.

1. 인증된 원본 인간 이벤트만 handler가 처리한다 (bot/system/edit/delete 제외). requester, team, 실제 event channel, requestId는 불변 WeakMap identity에 바인딩한다. 모델 text, 과거 댓글, 일반 `RequestContext.get` 값, Assistant의 threadTs-only 현재-view hint는 권한이 아니다. 팀이 없으면 명시적 조회는 fail closed.
2. action_token은 **별도 비공개 WeakMap**에만 보관한다. exported identity/일반 RequestContext entries/model messages/tool input/output/DB identity·tool-call 기록에 넣지 않는다. action_token은 사용자 OAuth token이 아니며 사용자에게 입력/발급을 요구하지 않는다. SDK transport만 해당 값을 사용한다. 응답의 임의 action_token/blocks/auth 필드는 투영하지 않고, 원문에 현재 action_token이 포함되어도 redact + 부분조회 표시한다.
3. **기존 origin 권한은 유지**: 매 page `authorizeCurrentSlackChannel`로 `auth.test` bot/team, origin `conversations.info`, requester membership/DM peer 및 shared/Slack Connect/org-shared/MPIM 차단을 검증한다. `read_channel`, 자동 thread 맥락, exact attachment/image bridge는 현재 이벤트 channel만 허용하며 새 public helper로 교체하지 않는다.
4. **타 공개 thread는 별도 보수적 정책**: origin 검증 이후 target `conversations.info`의 C형 ID, exact id/context_team_id, `is_channel === true`, `is_private === false`, `is_group === false`, non-IM/MPIM/nonshared를 검증하고 requester membership을 200명 × 최대 3페이지로 live 확인한다. 매 continuation도 동일하게 확인한다. 미확인·SDK not_in_channel/missing_scope는 정직한 권한 실패이며 bot 참여/읽기 권한을 안내한다. native RTS snippets는 full thread 접근 증거나 재사용 capability가 아니다. auto-join/user-token/history fallback 없음. 기존 현재 private/DM 읽기는 그대로다.
5. **공개 검색은 native RTS 사용자 접근 필터가 권한 근거**: target requester membership을 추가 강제하지 않는다. 모든 unique 결과 채널의 live info에서 위의 public/sameworkspace/nonshared 조건을 확인하며 scoped target도 API 전에 확인한다. SDK metadata 조회가 거절되면 페이지 전체 실패한다. cache는 한 operation/page에서 최대 20 unique primary 채널 metadata 검증만 중복 제거하며 global permission cache/후속 capability 저장은 없다. 고정 `channel_types: ['public_channel']`, `content_types: ['messages']`, `context_channel_id: trustedOrigin`. `channel` 생략 시 origin `in:`을 붙이지 않고 지정 시 서버가 `in:<#target>`만 붙인다. query는 일반 문자/숫자/공백/underscore/hyphen 단어만 허용하고 각각 quote한다. `in:`, `from:`, OR/AND/NOT, 괄호/기호 등 caller 연산자는 거부한다. semantic 재해석도 비활성화한다.
6. 실제 검색 match의 필수 C형 channel_id/team_id와 추가 scope aliases를 모두 검증한다. primary team은 trusted team과 exact 일치, scoped channel은 explicit target과 exact 일치해야 한다. message.channel은 origin이 아닌 실제 결과 채널이다. context before/after는 공식 schema상 channel/team을 생략하고 검증된 parent match의 scope를 상속한다. 명시적 channel_id/channel/team_id/team이 있으면 모두 일치해야 한다. 잘못된 match/context scope를 조용히 버리고 나머지를 반환하지 않고 **그 페이지 전체를 실패**시킨다. 다른 content types, 잘못된 ts/순서/permalink도 실패한다.
7. 반환 bot actors/원문은 비신뢰 데이터이며 인증/승인 역할로 승격하지 않는다. SDK/도구 errors는 sanitized status/한국어 안내만 반환한다. handler는 Slack tool args/results/cursors를 debug 및 DB tool-call 로그에서 redacted 처리하고 해당 응답 preview도 INFO에 남기지 않는다. 기존 일반 conversation 저장/답변 정책은 유지한다.

최소 read scope: 현재 public에는 `channels:history` + `channels:read`, private 읽기에는 `groups:history` + `groups:read`, bot DM 읽기에는 `im:history` + `im:read`. 읽기 scope가 검색 private/DM 지원을 부여하지 않는다. 파일 scope/metadata/download는 이 모듈의 도구 범위가 아니다.

## 입력 / 출력 / pagination

읽기 ts는 소수점 정확히 6자리 (`1700000000.000001`). permalink는 HTTPS workspace host/archive/실제 target channel/ts 일치, credentials/port/hash/알 수 없는 query/중복 query/모순 ts·channel을 엄격히 검증하며 **HTTP fetch하지 않는다**. 정상 댓글 링크의 `thread_ts=<parent>&cid=<targetChannel>`도 지원한다.

검색 입력 예: `{"query":"출시 plan","limit":20}` (workspace_public), `{"query":"출시 plan","channel":"C123","limit":20}` (해당 공개 채널만). 도구 인자는 strict schema이며 actor/team/action_token/filters를 추가할 수 없다. API response의 공식 예시처럼 1~6자리 fractional ts는 검증 후 6자리로 normalize한다. primary permalink는 인증된 workspace/실제 result channel/message ts에 대응하는 canonical URL만 반환한다. 검색 permalink의 decoded query는 thread_ts/cid만 각각 옵션으로 허용하며 unknown/empty/duplicate는 거부한다. cid는 실제 result 채널 exact 일치, thread_ts는 기존 API timestamp bounds/6자리 소수 정규화 후 root<=message(BigInt)와 존재하는 metadata.thread_ts 일치를 검증한다. query는 검증 후 제거하고 metadata.thread_ts가 없으면 반환 threadTs/권한/출처로 승격하지 않는다. query 없는 링크와 bare ?/# 경계는 기존대로 유지한다. [관측 근거·공식 문서와 규범 구분·정규화 계약](slack-search-response-diagnostics.md)을 참조한다.

공통 출력: `status`, `message`, optional source channel/threadTs, message channel/ts/threadTs, author(userId/botId/kind), text, textTruncated, page, nextCursor, complete/truncated, limits. 검색은 `api: assistant.search.context`, `searchScope: workspace_public | channel`을 추가한다. workspace-public 출력에는 source 자체를 생략하며 origin을 검색 출처처럼 위장하지 않는다. channel scope의 source.channel은 actual target이다. 각 message.channel은 실제 채널로 필수다. 검색 primary의 `searchMatch: true` 및 permalink, context의 `searchMatch: false`/contextForTs/contextPosition을 추가한다. 주변 context를 검색 match로 주장하지 않는다. blocks/files/user/channel results는 읽지 않는다.

- 읽기 15개/페이지, 검색 최대 20개 **primary matches**/페이지 (`limit` 1~20), 각 traversal 최대 4페이지. 검색은 주변 context 포함 투영 메시지 최대 40개이며 생략된 context는 truncated다. 모델이 반환된 nextCursor를 그대로 복사해서 명시적으로 사용해야 하며 placeholder/재구성/자동 무한 탐색은 없다.
- cursor는 원본 Slack cursor가 아닌 임의 opaque ID, team/requester/trusted origin channel/requestId/tool/target 및 검색 scope/optional target/query/limit에 바인딩. workspace↔channel, 서로 다른 target/origin/query/requester로 재사용 불가. 10분 만료, 성공 후 1회용, 동시 재사용 거부, 최대 1,000개 보관. continuation마다 live 권한 재확인. 실패 시 원 cursor는 재사용 가능하지만 다른 actor/target/query에 쓸 수 없다.
- 매 페이지는 시간순이다. channel next page는 더 오래된 기록이다. thread/search는 해당 API pagination을 따른다. 여러 페이지의 message를 합칠 때 channel/ts로 중복 제거하고 시간순 정렬한다. 검색 전달 이력은 primary/context를 구분한다: 앞 페이지에 context-only로 보였던 메시지가 다음 페이지 primary match이면 searchMatch=true 및 primary permalink/thread/actor metadata를 다시 반환해 승격한다. 페이지들을 합칠 때 primary를 context보다 우선해야 한다. 이미 전달된 실제 primary 또는 context-only의 context 재등장은 중복 제거한다. 같은 페이지의 여러 context 관계는 첫 번째 검증된 관계(contextForTs/contextPosition) 하나로 대표하며, 동일 (channel,ts)의 primary가 있으면 primary 하나만 반환한다. 모든 observed/pageObserved/pageMetadata/shortPrimary/projected/deliveredRoles/fingerprints 키는 JSON [channel,ts] tuple이다. 서로 다른 채널의 같은 ts/본문/actor/thread metadata는 독립적이며 hash 충돌·metadata 합성·누락·잘못된 승격을 일으키지 않는다. 이는 모든 parent-context 관계의 열거가 아니라 메시지 단위 전달 계약이다. 같은 역할(primary-primary/context-context)의 본문 hash 충돌은 모두 실패한다. 다른 역할은 동일 본문 또는 **같은 페이지에서 검증한 primary.text가 context.text의 정확 prefix**인 표현 관계만 허용하며, 그 prefix 관계의 명시적 author/thread 충돌은 실패한다. page-local 역할별 metadata primitive Set으로 모든 관측의 cross-role 조합을 검증하므로 양쪽 최신 객체의 metadata 생략이 앞선 명시적 충돌을 지울 수 없다. 역할 중 한쪽의 metadata가 전부 unknown이면 기존 wildcard 의미를 유지하며 cursor에 이 metadata를 보관하지 않는다. 짧은 primary 본문과 primary metadata/searchMatch/permalink를 유지하고 textTruncated=true 및 partial을 표시한다. 긴 context의 본문/author/threadTs를 primary에 합성하지 않는다. cursor의 같은 역할 hash는 정확 비교하고, 다른 역할 seed만 있는 비동일 본문 promotion은 양쪽 같은-page prefix 증거 없이는 실패한다. 기존 exact context→primary promotion은 유지한다. role hash는 실제 전달 (channel,ts)에만 페이지당40×최대4=160 composite keys, key당 최대2개(최대320 hash)로 보관하며 원문/actor/thread metadata는 cursor에 저장하지 않는다. 실패 attempt는 seed를 변경하지 않고 finally unlock한다. 한도 때문에 제외된 key는 전달한 것으로 기록하지 않고 traversal을 truncated로 유지한다.
- **검색 전용 출력 예산**: 본문 text projection은 최대 24,000 JSON UTF-8 바이트/메시지, **반환 전체 JSON은 최대 96,000 bytes/페이지**다. 배열 구분자·envelope·한국어 안내·source·limits·opaque cursor까지 포함하며 complete/partial 양쪽 envelope 비용을 예약하고 최종 실제 직렬화 비용도 검증한다. primary matches의 metadata/본문을 context보다 우선한다. Unicode/JSON escape 경계를 보존해 자르고 textTruncated를 표시한다. context 생략·본문 잘림·짧은 primary-prefix 표현은 complete=false/truncated=true이며 빈 text라도 metadata는 보존한다.
- **공유 읽기 예산은 불변**: thread/history는 기존 본문 8,000 JSON bytes/메시지, 투영 메시지 24,000 JSON bytes/페이지(배열 envelope 제외)를 유지한다. 자동 thread context/첨부/이미지 한도도 변경하지 않는다.
- **검색 내부 처리 예산(공개 limits/API shape와 별도)**: 페이지 전체 primary+before+after **2,048 관측**, 인정된 primary.content/context.text 문자열 총 **1,048,576 UTF-8 bytes**다. 중복·출력 생략 대상도 합산한다. context 배열의 API 상한을 20으로 가정하지 않는다. 전체 예산 초과는 페이지 전체 unavailable이며 초과 데이터를 자른 후 성공을 주장하지 않는다. non-text schema 필드는 4,096 code units를 선행 안전 상한으로 둔다(cursor의 기존 4,096, permalink 512, ID/timestamp/권한 비교 등 기존 정상값 검증은 그대로). giant/malformed payload를 regex/UTF-8 스캔/오류 수집 전에 bounded 처리한다.
- raw 검증 입력은 고정된 schema 키/배열 index만 한 번 읽어 inert snapshot으로 만든 뒤 기존 Zod 의미 검증을 수행한다. 배열 length를 먼저 검사하고 모든 recognized text의 code-unit 선행 체크 후 bounded UTF-8 bytes를 합산한다. raw JSON.stringify/toJSON/unknown-key 열거/iterator/coercion 및 예산 측정용 getter/Proxy 재읽기는 없다. unknown 필드/임의 file·channel·user·warning payload는 순회하지 않는다. 예산 내의 **모든 관측**이 scope/provenance/author-kind/thread/role hash/PREFIX 가드를 통과한 후에만 출력 선택·본문 projection·전달 hash state를 만든다. 예산을 넘어서 검증하지 않은 항목은 결과/해시/출처에 저장하지 않으며 페이지 전체 실패다.
- complete는 **전체 cursor traversal에서 반환된 모든 페이지를 합친 조회 범위**다. 마지막 페이지 하나가 전체 결과는 아니다. next cursor/has_more, 텍스트·context 생략, 알려진 thread reply_count 누락/변경은 complete가 아니다. 댓글 수 미확인 thread도 partial. 일반 단일 unthreaded terminal 첫 페이지는 댓글 0으로 간주 가능. Atomic snapshot/동시 편집·삭제 감지는 보장하지 않는다.
- 검색 complete는 해당 query/scope의 API **키워드 search result set**에 대한 것이지 workspace/채널 전체 기록이나 모든 관련 의미를 찾았다는 보장이 아니다. 빈결과는 그 query/scope에서 못 찾았다는 의미이며 workspace에 글이 없다는 확정이 아니다. 채널 ID/이름을 모르면 workspace 검색 후 실제 message.channel/permalink와 실제 thread/root metadata로 명시적 thread를 읽는다. navigation query root를 실제 parent metadata로 승격하지 않는다. 검색 partial/snippets와 full thread read를 구분하고 실제 출처를 인용한다. 타 공개 채널에서 찾은 파일/이미지는 첨부 접근 자동 확대를 뜻하지 않는다. channel complete도 모든 thread 댓글/첨부를 읽었다는 뜻이 아니다.
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

## 임시 진단 제거 / 과거 관측 아카이브

PR106에서 `slack_action_token_diagnostic`, `slack_search_response_diagnostic`, `slack_read_response_diagnostic` 3종 emit과 진단 전용 helper/correlation/observer/extractor/dispose API를 제거했으며 현재 코드에도 없다. [검색 응답/본문 충돌](slack-search-response-diagnostics.md), [thread/channel 읽기 실패](slack-read-response-diagnostics.md), [action_token 전달 구조](slack-action-token-diagnostics.md) 문서는 과거 근거 아카이브다. 현재 활성 로그 계약이나 재현 지침으로 사용하지 않는다.

실제 event-only 토큰 선택·validation·비공개 WeakMap identity/token binding, 모든 검색·읽기·출처·취소 가드와 SDK 로그 차단/안전 오류/도구·DB redaction은 유지한다. 표준 단일 SocketModeReceiver/client, Bolt 기본 INFO ConsoleLogger/client retry/customRoutes/port/start/stop 및 `@slack/logger` 의존성도 그대로다. Radar/mention-groups transport diagnostics는 PR106 제거 대상이 아니었으며 이번 공개 채널 확장에서도 변경하지 않는다.

## 검증 / PR106 운영 회귀와 PR108 타 채널 E2E 구분

관련 자동 테스트는 mock Slack API + 실제 Mastra main factory/tool execute/실제 handler 배선 및 실제 SDK synthetic adapter로 token 로그 차단을 검증한다. 검색 성공/공식 shape/context/bots/provenance, scope/query 주입, trusted action_token 전달과 위조 차단, 20 matches·budget·bounded cursor·partial, 설정/권한/429/빈결과 구분, bridge live 권한/exact message/file IDs, 기존 thread/DM 회귀가 포함된다.

**이전 운영 검증 기록:** PR105의 기본 search-only 검색은 원문·수정 댓글 출처 대조 PASS인 정직한 partial이었고, PR103의 독립 thread read는 3페이지 complete PASS였다. 이전 PR100의 permalink 거부는 당시 FAIL 이력이지 현재 결과가 아니다. 합성 회귀는 queryless 반환·metadata.threadTs 미승격을 포함한 기존 기능 가드와 임시 emit 부재를 확인한다.

**PR106 제거 후 실제 배포·최종 회귀 완료 (2026-10-06):** main의 pinned squash SHA `6e1d4e615a22a0db2efc39cee9e43df76af307a9` 배포는 build/deploy SUCCESS였고 실제 실행 이미지와 재시작 0을 E2E 전후 확인했다. 새 Slack 요청의 기본 키워드 검색은 실제 primary 출처·원문 대조 PASS이며 `complete=false/truncated=true/nextCursor=null/textTruncated=true`인 partial을 유지했다. 별도 명시적 thread 읽기는 성공한 3페이지 후 complete PASS였다. 다만 모델이 placeholder cursor를 한 번 만들어 `invalid_target`을 받은 뒤 복구한 이력이 있어 모든 thread invocation PASS로 주장하지 않는다. read-only DB 확인은 실제 search→thread 호출 순서, channel reader 미사용 및 tool-call redaction을 확인한 것이며 raw API 상태·본문·전체 coverage 증거는 아니다. bounded 운영 로그에서 3종 임시 emit 부재를 확인했다. 20 matches/전체 query pagination/다른 requester 등은 여전히 미검증이다.

**PR108 공개 cross-channel 확장:** 이번 확장의 실제 배포·타 채널 Slack/LLM E2E는 아직 미수행이다. PR106의 현재 채널 검색·독립 thread PASS를 이번 타 채널 PASS로 승격하지 않는다. main의 최종 SHA diff·fresh review·pinned squash·deploy SUCCESS/live SHA/restarts 확인 후 origin 테스트 채널에서 실제 다른 비공유 공개 채널의 검색 source/text와 해당 full thread continuation(요청자 member+bot 읽기 권한)을 대조해야 한다. origin 키워드 검색 회귀, 현재 private/DM 읽기와 검색 unsupported의 구분, 타 private/DM·공유 채널 링크/임의 in: 차단, 기존 current-only history/첨부/image 권한, 429/토큰 만료 안내 및 로그 비밀 미기록도 확인한다. worker는 merge/배포/서버/실 Slack posting/E2E를 실행하지 않는다. 공식 API 지원·조회 API 성공·합성 PASS는 이번 운영 성공을 보증하지 않으며 user token 추가/광역 스캔으로 실패를 우회하지 않는다.

이번 public cross-channel 확장의 합성 검증은 기본 workspace 검색의 두 공개 target, scoped target/origin context, native search 비가입 요청자 허용 vs full thread membership 거부, public/team/shared/aliases/permalink 검증, 복합 키 동일 ts 독립성, scope/target cursor binding·실패 seed 불변성, 실제 factory/handler WeakMap·DB redaction 및 기존 첨부/image current-only 권한을 포함한다. 이 PR의 실제 Slack posting/배포/E2E는 worker가 수행하지 않는다. main의 final pinned SHA 배포 후 origin 테스트 채널에서 실제 다른 공개 채널 공지 검색/source 원문 대조와 실제 해당 thread read/continuation, origin 검색 회귀를 수행해야 한다. 기존 PR105/106의 기본 검색·독립 thread PASS를 이번 타 채널 실제 E2E PASS로 주장하지 않는다.

전체 기본 timeout suite의 기존 Code Explorer snapshot 실패는 이번 Slack 변경으로 해결했다고 주장하지 않는다. timeout을 늘린 이전 실행은 기본 timeout 문제 해결의 증거가 아니며 해당 원인 진단은 별도 담당 작업이다.
