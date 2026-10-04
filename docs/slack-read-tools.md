# Slack 명시적 읽기 도구 (bot token only)

## 범위와 실제 연결

기존 호출 스레드 자동 맥락 수집(`slack/slack-thread-source.ts`)은 그대로 유지한다. 별도 스레드/채널 읽기는 모델이 필요할 때 **메인 에이전트**의 아래 도구로 요청한다. send/update/delete, 채널 가입, 파일/첨부 읽기는 제공하지 않는다.

- `slack_read_thread`: 현재 요청 채널 안의 부모 메시지 `ts` 또는 같은 워크스페이스의 Slack permalink로 원문과 댓글을 읽는다.
- `slack_read_channel`: 현재 요청 채널의 최근 메시지 기록을 읽는다. 댓글을 자동으로 펼치지 않는다.
- `slack_search`: 검색 지원 여부를 정직하게 반환한다. **bot-token-only에서는 `unsupported`이며 실제 검색을 실행하지 않는다.**

실행 경로: `src/index.ts`의 기존 `createAgent()` → `agent/index.ts`가 **기존 `config.SLACK_BOT_TOKEN`만** 사용하는 전용 WebClient 생성 → `createMainShookieAgent` → `createMainShookieTools` → `createSlackReadTools`. 같은 프로세스의 `registerHandlers(app, agent)`가 인증된 Slack 이벤트로 만든 RequestContext에 신뢰된 읽기 identity를 바인딩한다. Slack user OAuth·MCP·웹 도구·첨부 모듈과 연결하지 않는다. 새 환경변수/의존성/credential은 없다. 기존 factory 호출 인자는 그대로 유효하며, 테스트용 `createAgent({ slackClient })` 주입이 가능하다.

전용 SDK 클라이언트는 `rejectRateLimitedCalls: true`, `retryConfig: { retries: 0 }`, 요청 timeout 10초다. 기존 `app.client`의 재시도/스트리밍 동작은 변경하지 않았다.

## 공식 API token 지원 확인

공식 reference를 **2026-10-04**에 읽어 다음을 확인했다. 문서 지원 표는 실제 설치 권한/실행 성공을 보증하지 않는다.

| API | 공식 reference 확인 | 이 구현 |
|---|---|---|
| [`search.messages`](https://docs.slack.dev/reference/methods/search.messages/) | Facts/Scopes에는 **User token**만 표시, `search:read`; `not_allowed_token_type` 오류 정의 | bot token에서 호출 자체를 하지 않고 `unsupported` 반환. 검색은 빈결과가 아니다 |
| [`conversations.history`](https://docs.slack.dev/reference/methods/conversations.history/) | Bot token + 관련 `*:history`, bot이 참여하는 대화만 접근 가능 | 현재 채널의 제한된 최근 기록 페이지 조회 |
| [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/) | 현재 reference HTML의 Facts/Scopes에는 Bot token 및 User token 각각 `channels:history`, `groups:history`, `im:history`, `mpim:history`가 표시됨. [공식 메시지 읽기 가이드](https://docs.slack.dev/messaging/retrieving-messages/#pulling_threads)는 thread를 replies로 읽도록 안내 | 현재 채널의 명시된 thread 조회만 시도. 설치/대화 유형이 `not_allowed_token_type` 또는 `method_not_supported_for_channel_type`를 반환하면 `unsupported`. user token 추가나 history 스캔으로 우회하지 않음 |

과거 `conversations.replies` bot 지원에 대한 안내와 현재 reference가 다를 수 있다. 이 PR은 **실제 워크스페이스의 공개/비공개 채널·DM에서 bot-token replies 성공을 검증했다고 주장하지 않는다.** 기존 자동 thread reader의 동작도 이 변경으로 보장/확장하지 않는다.

공식 history/replies reference의 rate-limit 안내: Marketplace/internal customer-built app은 Tier 3, 비-Marketplace 상용 배포의 새 앱/설치는 1회/분 및 최대 15개 제한이 적용될 수 있다. 적용 유형에 따라 달라진다. 한 번에 15개만 요청하고 자동 재시도/대체 경로 전환을 하지 않는다. membership 조회도 API 호출 예산에 포함된다.

## 권한 경계 (코드 강제)

**봇 접근 권한 ≠ 요청자 접근 권한.** 프롬프트의 약속만으로 제한하지 않는다.

1. 인증된 `app_mention`/DM 이벤트의 requester/user, team, 실제 event channel, requestId를 handler가 WeakMap에 불변 복사본으로 바인딩한다. 모델 입력이나 일반 `RequestContext.get('userId')` 값으로 identity를 만들지 않는다. 팀 누락은 명시적 읽기에 fail closed한다. 과거 댓글·다른 봇·본문의 `userId=ADMIN` 같은 문자열 및 Assistant의 threadTs-only 현재-view hint는 권한이 아니다.
2. 조회 대상은 **현재 이벤트 channel과 정확히 일치**해야 한다. 다른 공개/비공개 채널·다른 DM은 API 호출 전 차단한다. 따라서 DM에서 사용자가 보고 있는 별도 채널을 읽는 기능도 제공하지 않는다.
3. `auth.test`로 bot identity 및 trusted event team과 token workspace의 일치를 확인한다. permalink hostname도 auth 응답의 workspace hostname과 같아야 한다.
4. `conversations.info` 응답 channel ID/팀 정보를 검증한다. Slack Connect/외부 공유/조직 공유 채널 및 MPIM은 지원하지 않는다. 일반 채널은 매 페이지마다 `conversations.members`로 **요청자 membership**을 확인한다 (200명씩 최대 3페이지, 미확인은 거부). DM은 `is_im` 및 peer `user === requester`를 확인한다. 큰 채널에서 요청자를 3페이지 안에 찾지 못하면 안전하게 거부하며 membership 전체 무한 순회하지 않는다.
5. 반환 메시지에 channel/team이 있으면 현재 scope와의 일치를 확인한다. thread는 부모 ts, 각 댓글의 thread_ts 및 반환 부모의 reply_count도 검사한다. 잘못된 scope/충돌 원문은 해당 페이지 결과를 노출하지 않고 실패한다.
6. 도구 인자는 strict schema라 actor/team/requestId를 전달할 수 없다. 광역 검색은 제공하지 않으며 `in:`/`channel:` 쿼리도 거부한다. 어떤 쿼리도 검색 API나 전역 history scan으로 실행되지 않는다.

최소 bot scope: 조회하는 대화 종류에 맞는 `channels:history` + `channels:read`, `groups:history` + `groups:read`, 또는 `im:history` + `im:read`. read scope는 info/members 확인용이다. 이 구현에서 MPIM/공유 채널을 지원하기 위한 권한 추가는 불필요하다. `search:read` user scope나 별도 user OAuth는 추가하지 않는다. scope가 없으면 `access_denied`이며 기존 설치 권한을 몰래 확장하지 않는다.

## 입력/반환과 완전성

```json
{"ts":"1700000000.000001"}
```

또는 `https://<workspace>.slack.com/archives/<currentChannel>/p1700000000000001`를 `url`로 지정한다. 링크가 댓글을 가리키면 정상 Slack query `thread_ts=<parent ts>&cid=<currentChannel>`도 지원한다. HTTPS, workspace host, archive path, ts(소수점 6자리)를 엄격하게 검사하고 credentials/port/hash/알 수 없는 query/중복 query/서로 충돌하는 ts·channel을 거부한다. 링크는 **HTTP로 가져오지 않는다**.

결과에는 `status`, 한국어 `message`, `source.channel/threadTs`, 각 메시지의 channel/ts/threadTs, author(userId/botId/kind), 원문 text, `textTruncated`, 부모의 `replyCount`가 있다. 다른 bot도 원문 작성자 데이터로 반환하며 assistant/승인자로 승격하지 않는다. 파일/blocks 등은 투영하지 않는다.

- **페이지 크기 15, 최대 4페이지**: 모델이 반환된 `nextCursor`를 동일 도구/대상에 명시적으로 전달해야 한다. 단일 호출은 메시지 페이지 1개만 가져온다. 최대 페이지에 도달하면 `nextCursor: null`, `complete: false`, `truncated: true`다. 무한 자동 탐색은 없다.
- cursor는 원본 Slack cursor가 아닌 서버 내 불투명 임의 ID이며 team/user/current channel/requestId/tool kind/target thread에 바인딩된다. 10분 만료, 성공 소비 후 1회용, 전체 보관 수 1,000개 제한. 모든 continuation에서도 권한을 다시 확인한다. 이전 턴/requestId·다른 사용자/채널/대상으로 재사용하면 거부한다. 실패한 권한 조회는 cursor를 소비하지 않는다.
- 각 페이지 메시지는 **시간순**이다. thread 페이지는 Slack의 replies pagination을 따른다. channel은 최근 기록부터 조회하므로 다음 페이지는 더 오래된 기록이다. 여러 페이지를 합칠 때 channel/ts로 중복 제거 후 시간순으로 정렬한다.
- 메시지 하나의 JSON text 예산은 8,000바이트, 페이지 투영 메시지 예산은 24,000바이트다. UTF-8 문자 경계/JSON escape 바이트를 보존해 자르고 `textTruncated`를 표시한다. 본문 일부가 잘리면 원문 전체라고 표현하면 안 된다.
- `complete`는 **이 cursor traversal에서 반환된 모든 페이지를 합한 범위**의 완전성이다. 마지막 페이지 하나만 전체 thread라고 해석하면 안 된다. next cursor/has_more, 이전 페이지 text 잘림, root reply_count 대비 누락, 조회 중 count 변경이 있으면 complete가 아니다. 댓글 수가 없는 실제 thread는 부분조회로 표시한다. thread_ts/reply_count가 없는 평범한 단일 메시지의 첫 terminal 페이지만 댓글 0개로 간주할 수 있다. Slack은 atomic snapshot을 제공하지 않으므로 동시 편집/삭제를 완전히 감지/보장할 수 없다.
- channel의 `complete: true`는 메시지 기록 pagination이 끝났다는 뜻일 뿐 **모든 thread 댓글/파일/첨부를 읽었다는 의미가 아니다**. channel 읽기에서 replyCount가 보이면 댓글은 thread 도구로 별도 조회해야 한다.
- `ok` + 빈 channel messages는 빈결과다. `unsupported`, `access_denied`, `invalid_target`, `rate_limited`, `unavailable`은 조회 실패/차단이며 빈결과로 요약하지 않는다. 실패의 `complete: false`는 성공 결과가 없음을 뜻한다. `truncated`는 성공한 부분조회에만 적용한다.

원본 Slack error/token/헤더/stack은 도구 오류나 신규 로그에 노출하지 않는다. Slack 도구 args/result(원문·cursor 포함)는 handler의 debug 및 DB tool-call 로그에서 redacted 처리하고 Slack 도구를 사용한 최종 응답 preview도 INFO 로그에 남기지 않는다. 기존 conversation 저장/최종 답변은 봇의 일반 대화 정책을 따르며 이번 도구가 별도 원문 저장소를 추가하지 않는다.

## 검증과 실제 Slack E2E 한계

자동 테스트는 Slack API **mock** 및 실제 Mastra factory/tool execute/Slack handler 배선을 검증한다. 현재 채널 제한, 다른 private 채널 차단, trusted actor/team, bot identity, membership/DM peer, query scope, permalink/ts, 반환 scope, 429/unsupported/오류/빈결과 구분, 페이지/opaque cursor 권한 바인딩·만료, partial/truncated, 원문/다른 bot/순서를 검증한다. 기존 자동 thread context와 DM 회귀 테스트도 유지한다.

**실제 Slack E2E는 미실행**이다. 추가 credential 없이 운영자가 허용된 테스트 채널에서 기존 bot으로 다음을 확인해야 한다:

1. 현재 일반/비공개 채널의 top-level 멘션에서 같은 채널의 다른 thread 링크 읽기, root+다른 bot 댓글 원문/순서 확인.
2. 현재 채널 최근 기록 조회와 15개 초과 thread의 nextCursor 진행·부분조회 표시 확인.
3. 다른 private 채널 링크, DM에서 별도 채널 링크, query `in:private`의 차단 확인.
4. 현재 bot DM의 thread/channel 읽기 및 다른 DM peer 차단 확인.
5. 설치 scope가 부족하거나 replies bot 지원이 거절되면 해당 `access_denied`/`unsupported` 안내를 그대로 확인. token 교체·user OAuth 추가·전역 스캔으로 해결하지 않기.
6. 서버 로그에서 bot token/raw Slack errors/Slack tool 원문·cursor가 기록되지 않음을 확인.

검색 성공 E2E는 이 설계에서 불가능하다. `slack_search`가 `unsupported`를 정직하게 반환하는 것이 기대 동작이다.
