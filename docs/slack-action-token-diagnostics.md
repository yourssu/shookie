# Slack 검색 action_token 임시 안전 진단

이 변경은 원인 확정을 위한 **관찰만** 한다. main의 2026-10-06T14:37:13.022Z UI 재현(`slack-event:Ev0C72JPG022`)에서는 authenticated handler의 네 후보 모두 own slot absent, selectedUsable=false, identityBound=true/tokenBound=false, 같은 상관의 search.tokenBound=false이며 API 직전에 도달하지 않았다. 따라서 API 전송만의 문제는 배제했지만 **Slack omission vs SDK/receiver 전달 문제는 미확정**이다. 이번 후속 구현의 SDK 경계 운영 재현은 아직 수행하지 않았다. “Slack이 토큰을 보내지 않는다”는 결론을 내리지 않는다. 검색 권한/범위, 인증, 토큰 선택/validation, 검색 결과, 시간 제한/취소는 기존 동작 그대로다. 다른 위치에서 토큰을 발견해도 자동 fallback 하지 않는다.

## 전달 경로 조사와 고정 후보

공식 문서:
- [Real-time Search / Using the action_token](https://docs.slack.dev/apis/web-api/real-time-search-api/#action-token): bot token 호출에는 action_token 필요. app_mention 및 message.im/mpim/groups/channels(앱 멘션 시) 이벤트에서 받을 수 있으며, app_mention의 **event payload**에 존재한다고 설명한다. 이는 운영 수신 보장이 아니라 API 계약 설명이다.
- [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/): WebSocket envelope의 `payload`가 Events API body이고 그 안의 `event`가 실제 이벤트다.
- [Bolt SlackEventMiddlewareArgs](https://docs.slack.dev/tools/bolt-js/reference/type-aliases/SlackEventMiddlewareArgs/): listener의 event/payload/body 구분.
- [Bolt context](https://docs.slack.dev/tools/bolt-js/concepts/context/): 인증 결과 및 middleware의 추가 정보를 담는 context. action_token 필드는 문서화되지 않았다.

설치된 실제 SDK 코드 확인 (`yarn.lock` 기준 Bolt 4.7.2, Socket Mode 2.0.7):
1. `@slack/socket-mode/dist/src/SocketModeClient.js:244–316`: JSON parse 후 Events API의 **타입별 공개 이벤트**(`app_mention`/`message`)를 먼저 emit한다. args.body는 frame.payload, args.event는 frame.payload.event 그대로이며 복사/필드 삭제가 없다. 그 뒤 공개 `slack_event`를 emit하며 args.body는 같은 frame.payload이다. hello/disconnect는 이 경로 이전에 return한다.
2. `@slack/bolt/dist/receivers/SocketModeReceiver.js:137–148`: 그 body를 `App.processEvent`로 전달. 기본 customPropertiesExtractor는 빈 객체.
3. `@slack/bolt/dist/App.js:423–588`: authorize 성공 후 context를 구성. Events API에서는 `payload = body.event`, `event = payload`이므로 listener의 event와 body.event는 같은 객체다. context는 authorizeResult/customProperties/실행 관련 정보로 구성하며 action_token을 별도로 복사하는 코드는 확인되지 않았다.
4. `SocketModeReceiver.d.ts:59,67`: `client`와 `customPropertiesExtractor`는 공개 지원 API. `App.receiver`는 private이므로 탐색/patch하지 않는다. `shookie/src/slack/socket-mode-app.ts`에서 **명시적인 표준 SocketModeReceiver 1개**와 App을 구성한다. 공개 타입별 이벤트가 `socket_sdk`, 공개 extractor가 `socket_receiver`를 관측한다. extractor는 기존처럼 빈 customProperties를 반환한다. receiver의 기존 slack_event listener 순서를 바꾸거나 prepend하지 않는다.
5. `App.js:82–195,713–740`: 기존 bot token 단일 workspace auth/기본 auth.test/ignoreSelf=true와 Socket Mode defaults를 그대로 유지한다. `@slack/logger` 4.0.1을 직접 의존성으로 선언하여 기존 bolt-app INFO ConsoleLogger를 동일하게 구성한다(전역 LOG_LEVEL이나 SDK debug를 켜지 않음). 기본 implicit receiver가 Socket Mode reconnect retryConfig를 shared clientOptions에 추가하는 순서도 보존한다: app.client는 원래 retry defaults로 먼저 구성되고, 이후 Bolt client options에는 receiver의 reconnect retries가 반영된다. `index.ts`의 userOAuth && userOAuthConfig 조건, customRoutes GET callback/handler 및 installerOptions.port는 receiver로 그대로 전달한다. OAuth 비활성 시 HTTP server는 생기지 않는다. 시작 실패/종료 시 observer를 제거하며 정상 종료는 app.stop()으로 기존 단일 연결을 정리한다.

| 진단 경로 | 근거 / 확실성 | 실제 선택에 사용? |
|---|---|---|
| `event.action_token` | 공식 event payload 설명 + 기존 handler 선택 경로. 운영 존재 여부는 미확인 | 기존대로 이 위치만 |
| `body.event.action_token` | SDK가 제공하는 위 event의 alias. 정상 Bolt 전달에서는 동일해야 함 | 아니오 |
| `body.action_token` | 전체 Events API body의 고정 관찰 후보. 공식문서/설치 SDK에서 top-level 위치는 **확인되지 않음** | 아니오 |
| `context.action_token` | Bolt 인증/middleware context의 고정 관찰 후보. 이 앱/SDK/공식문서에서 공급 경로는 **확인되지 않음** | 아니오 |

WebSocket 바깥 envelope는 listener body가 아니다. `body.payload.*`, camelCase, 파일/블록/본문 내부, 임의 키 탐색은 하지 않는다. 이 네 후보 밖의 위치는 이번 진단으로 배제할 수 없다.

### 관측 경계 / raw frame 미포함

`socket_sdk`는 **SDK가 이미 JSON parse한 뒤 최초 타입별 공개 emit**을 관찰한다. `socket_receiver`는 같은 SDK의 slack_event가 receiver로 들어와 App.processEvent에 넘겨지기 직전인 공개 extractor를 관찰한다. 이후 기존 `receive`는 Bolt authorize 및 기본 middleware/handler 필터를 통과한 관측이다. 따라서 SDK 공개 이벤트 → receiver → authenticated handler의 슬롯 상태/객체 alias는 비교할 수 있다.

설치된 SDK의 raw WebSocket message handler는 내부 메서드이며 raw frame을 노출하는 지원 공개 event/hook은 확인하지 못했다. **실제 raw WebSocket 최초 수신/Slack 원본 frame을 관측한 증명이 아니다.** SDK 공개 단계에서 absent여도 parse 이전 frame/Slack 발신 자체/다른 위치의 omission은 확정하지 못한다. 별도 연결, 수동 socket, private/protected override, monkey patch, node_modules 수정, raw SDK 로그는 사용하지 않는다.

## 보안 및 필드 계약

기본 INFO 수준의 고정 메시지 `slack_action_token_diagnostic`만 추가한다. 전역 로깅 정책, 환경변수, 의존성은 추가하지 않는다. 기존 로그 전체가 이 계약으로 바뀌는 것은 아니므로 운영 공유 시 **진단 레코드만** 발췌한다.

추가 payload 필드는 아래 allowlist만 사용하며, requestId/eventCorrelationId 외의 값은 boolean 또는 고정 enum이다:
- `stage`: `socket_sdk`, `socket_receiver`, `receive`, `selection`, `binding`, `search`, `search_api`
- 공개 SDK/receiver: `correlationTrust=untrusted_event_id`, `correlationAvailable`, 선택적인 `eventCorrelationId`. 고정 own event_id가 primitive string이고 길이 ≤64 및 `^Ev[A-Z0-9]{8,62}$`를 만족할 때만 `slack-event:<event_id>`로 기록한다. 그 외에는 생략하며 hash/fallback을 새로 만들지 않는다. **requestId라는 필드로 기록하지 않으며 인증/권한 근거가 아니다.** ID 자체가 비신뢰 데이터이므로 일치만으로 동일한 인증 주체라고 판단하지 않는다.
- `receive.requestIdTrust=authenticated_handler`: 기존 handler가 인증된 Bolt 경로에서 만든 requestId. 이후 selection/binding/search의 requestId도 기존 handler/봉인 identity/진단 WeakMap만 사용한다.
- `sdkBodyAlias`, `sdkEventAlias`, `receiverBodyAlias`: SDK에서 표시한 동일 body/event 객체가 receiver/handler까지 유지되었는지. 별도 WeakMap에는 boolean marker만 두며 payload/event/토큰/ID를 값으로 보관하지 않는다. sdkEventAlias=false는 SDK args.event와 body.event가 다른 경우도 포함한다. false는 객체 관측 부재이지 token omission 증명이 아니다.
- `eventKind`: `app_mention`, `message`, 또는 correlation을 잃은 search에서 `unknown`
- `requestId`: 기존 `slack-event:<event_id>` 또는 기존 `slack-fallback:<id>` (새 토큰 hash가 아님). 검색에서는 trusted WeakMap의 상관정보/identity에서만 가져오며, 둘 다 없으면 생략한다. model context.get의 requestId는 신뢰하지 않는다.
- 수신: `eventTokenObservation/Present/Usable`, `bodyEventTokenObservation/Present/Usable`, `bodyTokenObservation/Present/Usable`, `contextTokenObservation/Present/Usable`. 공개 SDK/receiver에는 Bolt context가 아직 없으므로 context 슬롯은 absent/false 고정이다(인증 후 context에서 필드가 사라졌다는 뜻이 아님).
- 선택: `selectedSource` (항상 `event.action_token`), `selectedUsable`
- 바인딩: `bindingAttempted`, `selectedUsable`, `identityBound`, `tokenBound`
- 검색: `correlationAvailable`, `identityBound`, `tokenBound`

`Observation`은 `absent` / `data` / `accessor` / `blocked`. `Present`는 **own property 슬롯 존재**를 뜻하므로 값이 undefined/null/숫자여도 true일 수 있다. usable은 기존 validation(비어 있지 않은 string, 최대 16,384 문자, U+0000–U+0020 없음)과 완전히 동일하다. **토큰 길이 자체를 기록하지 않는다.** accessor는 존재하지만 읽지 않아 usable=false, Proxy/중간 body.event accessor는 blocked로 표시한다. blocked/accessor의 false를 “토큰 미수신” 증거로 해석하면 안 된다. prototype에서 상속된 필드는 관찰하지 않는다.

진단은 고정 own property descriptor만 읽고 getter, Proxy trap, key 순회, 임의 객체의 stringify/toJSON을 실행하지 않는다. 기존 `event.action_token`의 단일 선택 read는 그대로이며, 진단 때문에 다시 읽지 않는다(기존 선택 경로의 getter 동작을 바꾸는 하드닝은 이번 범위 밖이다). validation은 primitive string에만 적용한다. 로거에는 새로 만든 allowlist primitive 객체만 넘긴다. 토큰 값/부분값/hash/길이, 메시지·파일 본문, 사용자·채널 metadata, private URL, raw event/body/context, 오류 원문은 추가 로그에 넣지 않는다.

토큰은 기존 비저장 WeakMap에만 남는다. 진단 상관정보는 별도 WeakMap의 requestId/eventKind와 객체 identity용 boolean marker만 저장하고, RequestContext 항목/모델 입력·응답/DB에 진단이나 토큰을 추가하지 않는다. 새 공개 경계의 observer/extractor는 모든 예외(로거 실패 포함)를 삼키고 ack/processEvent 호출, payload 변형, 함수 교체를 하지 않는다. own type=event_callback과 app_mention 또는 message(im)인 human 형태(user/channel/ts primitive, bot_id/subtype own slot 없음)만 관측한다. 본문/파일은 필터에서도 읽지 않는다. hello/disconnect/interactive/다른 event/system/bot subtype/비DM message/malformed·getter·Proxy 필터 대상은 새 로그를 내지 않는다. 인증 전에는 user가 봇 본인인지 확정할 수 없으므로 bot_id 없는 self-user 형태는 공개 단계에서 관측될 수 있으나 기존 Bolt ignoreSelf가 후속 delivery를 차단한다. 대상 이벤트마다 경계당 고정 레코드 1개이며 임의키/배열 순회 또는 raw 로그를 추가하지 않는다. 진단의 후보 위치와 상관정보는 **권한 근거가 아니다**.

## 단계별 해석

기존 authenticated 단계끼리는 같은 requestId의 레코드만 비교한다. 공개 경계는 eventCorrelationId와 authenticated receive.requestId의 제한된 문자열 일치에 더해 **sdkBodyAlias/sdkEventAlias/receiverBodyAlias**를 확인한다. 이는 관찰 상관관계이지 인증 승격/권한 부여가 아니다. ID 생략·alias 부재 시 시간대만으로 연결하지 않는다. 재전송/중복 수신은 경계/receive가 여러 개일 수 있고, 명시적 페이지 검색은 search/search_api가 여러 개일 수 있다.

| 관찰 | 해석 및 다음 확인 |
|---|---|
| socket_sdk 없음 | 공개 emit 미관측/형태 필터/로그 레벨·배포 문제 가능. raw frame 미수신 확정 불가 |
| socket_sdk와 socket_receiver의 같은 alias에서 모두 absent | 설치 SDK의 parse 후 공개 payload에는 슬롯 부재. receiver/Bolt에서만 삭제됐다는 설명은 좁힐 수 있으나 Slack omission은 확정 불가 |
| socket_sdk usable=true → receiver/receive usable=false | alias와 관측 필터를 확인하고 해당 전달 경계 조사. 자동 fallback/권한 변경 금지 |
| socket_receiver 있음, receive 없음 | 인증 실패/ignoreSelf/기존 human·DM·빈 본문 필터 가능. observer는 ack나 재전송을 추가하지 않음 |
| receive 자체 없음 | 이벤트 미전달/인증 실패/기존 human·DM·빈 본문 필터/로그 레벨·배포 문제 가능. **토큰 미수신 확정 불가** |
| 모든 후보 observation=absent | 이 handler에 도달한 수신의 네 own 후보에는 슬롯 없음. 앱 이벤트 설정/RTS 활성화를 확인. 네 후보 밖의 위치나 전체 Slack 계약 위반까지 단정하지 않음 |
| eventTokenUsable=false, 다른 후보 usable=true | 다른 고정 위치에 사용 가능한 문자열 관찰. 자동 fallback 없이 전달 구조를 별도 승인·조사 |
| eventTokenObservation=data, Present=true, Usable=false → selection.selectedUsable=false | 현재 validation에 맞지 않는 선택값(슬롯은 있지만 undefined/null 등도 포함). 토큰 값이나 길이를 요구/공유하지 않음 |
| receive usable=true, selection 없음 | 중복 claim, greeting, 큐/스레드 읽기/취소 등으로 선택 단계에 도달하지 않았을 수 있음. 바인딩 실패 증거가 아님 |
| selection.selectedUsable=true, binding 없음 | capacity/DB/스트리밍 준비/취소 등 모델 실행 전 실패 가능. WeakMap 바인딩 실패로 단정하지 않음 |
| bindingAttempted=false | 기존 team identity 부재로 바인딩 생략. identity/token=false가 예상됨. 인증 정책을 넓히지 않음 |
| bindingAttempted=true, selectedUsable=true인데 identityBound 또는 tokenBound=false | 실제 바인딩 결과 불일치. 바인딩 단계 조사 |
| binding.tokenBound=true → 동일 requestId search.tokenBound=false | WeakMap 전달/재바인딩 실패 의심. selectedUsable=false → tokenBound=false는 정상 reject이며 전달 실패가 아님 |
| binding 이후 search 없음 | 모델이 검색하지 않음 또는 실행 실패/취소 가능. 토큰이 검색 도구에 도달하지 않았다는 증거는 아님 |
| search.correlationAvailable=false | trusted context/진단 WeakMap 상관관계 상실. 새 requestId를 model 항목에서 복원하지 않음. 단일 UI 재현 시간대는 참고만 하고 동시 요청과 임의로 연결하지 않음 |
| search.tokenBound=true, search_api 없음 | 입력 검증, 채널/멤버십/워크스페이스 authorization, private/DM 제한 등 API 이전 경로. 토큰 부재가 아님 |
| search_api 있음 | 기존 권한 체크를 통과하고 API 호출 직전 도달. API 성공/토큰 유효성·만료/권한을 보장하지 않음. 기존의 사용자 친화적 실패 안내로 구분하고 오류 원문 로그를 추가하지 않음 |

## 운영 재현 (main 담당)

1. 독립 리뷰와 main SHA 확인 후 squash merge/배포 성공 및 bot 준비를 main이 확인한다. worker는 운영 E2E/배포/머지를 하지 않는다.
2. 봇과 요청자가 이미 접근 가능한 **공개 채널**의 Slack UI에서 사용자가 한 번만 새 멘션을 전송한다: `@슈키 이 채널에서 출시 키워드를 검색해줘`. 봇 멘션을 Slack UI의 실제 mention으로 선택한다. DM은 기존 공개채널 검색 지원 범위 밖이므로 이 재현에 쓰지 않는다.
3. 실제 UI 새 멘션 **1회**의 재현 시각을 기록하고 해당 시간대의 **slack_action_token_diagnostic 레코드만** 발췌한다. 제한된 eventCorrelationId/인증 후 requestId와 alias 상태를 대조하여 socket_sdk → socket_receiver → receive → selection → binding → search → search_api를 확인한다. 같은 문자열이어도 pre-authorization ID를 authority로 사용하지 않는다. raw debug/socket payload 로깅을 켜거나 토큰을 복사/붙여넣기하지 않는다. 동시에 별도 요청을 보내지 않는다.
4. 위 표대로 안전한 boolean/enum 필드만 보고한다. 실제 운영 증거 전에는 미수신 결론 금지. 검색이 호출되지 않았다면 즉시 같은 요청을 반복하지 말고 그 실행 흐름부터 확인한다.
5. 증거 확보 뒤 **진단 로그·correlation WeakMap 제거 후속 PR이 필요**하다. 영구 수신 경로 수정/다른 위치 fallback/검색 신뢰 경계 변경은 증거와 별도 승인 후 진행한다.

## 테스트

- `socket-mode-app.test.ts`: 설치된 실제 SocketModeClient의 **공개 emit**으로 2.0.7의 parse 후 args/body/event alias를 합성한다. 실제 receiver extractor → 실제 Bolt auth.test/authorize/middleware → 실제 registerHandlers → WeakMap/search/API를 검증한다. token 존재/부재/validation 거부/별도 후보 무fallback, alias 불일치, observer 로거 예외에도 1회 ack/delivery, malformed/getter/Proxy/toJSON 비실행, 제한된 비신뢰 ID, 단일 receiver/client, ignoreSelf, OAuth callback 실제 로컬 GET/port, listener 해제를 포함한다. 연결 start/disconnect와 Slack Web API는 합성 stub이다. **SDK raw frame parser 호출/실제 Slack socket/실제 UI E2E는 이 테스트가 아니다.**
- `action-token-diagnostics.test.ts`: 기존 validation 경계, 누락/정상/잘못된 값, 네 후보 분리, 악성 getter/Proxy(폐기 포함)/toJSON 비실행, allowlist 및 secret 비노출, team 부재/상관관계 상실.
- `handlers.test.ts`: 실제 handler → WeakMap binding → search/API의 동일 requestId 연결, 다른 위치 token 자동 fallback 금지, 토큰의 모델/DB/검색 응답 비노출.
- 기존 Slack search/authorization/client/SDK logger 및 cancellation/handler 회귀 테스트로 권한·검색 결과·취소 불변 확인. database build를 먼저 수행한다.
