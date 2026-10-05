# Slack 검색 action_token 임시 안전 진단

이 변경은 원인 확정을 위한 **관찰만** 한다. 실제 운영 이벤트를 아직 검증하지 않았으므로 “Slack이 토큰을 보내지 않는다”는 결론을 내리지 않는다. 검색 권한/범위, 인증, 토큰 선택/validation, 검색 결과, 시간 제한/취소는 기존 동작 그대로다. 다른 위치에서 토큰을 발견해도 자동 fallback 하지 않는다.

## 전달 경로 조사와 고정 후보

공식 문서:
- [Real-time Search / Using the action_token](https://docs.slack.dev/apis/web-api/real-time-search-api/#action-token): bot token 호출에는 action_token 필요. app_mention 및 message.im/mpim/groups/channels(앱 멘션 시) 이벤트에서 받을 수 있으며, app_mention의 **event payload**에 존재한다고 설명한다. 이는 운영 수신 보장이 아니라 API 계약 설명이다.
- [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/): WebSocket envelope의 `payload`가 Events API body이고 그 안의 `event`가 실제 이벤트다.
- [Bolt SlackEventMiddlewareArgs](https://docs.slack.dev/tools/bolt-js/reference/type-aliases/SlackEventMiddlewareArgs/): listener의 event/payload/body 구분.
- [Bolt context](https://docs.slack.dev/tools/bolt-js/concepts/context/): 인증 결과 및 middleware의 추가 정보를 담는 context. action_token 필드는 문서화되지 않았다.

설치된 실제 SDK 코드 확인 (`yarn.lock` 기준 Bolt 4.7.2, Socket Mode 2.0.7):
1. `@slack/socket-mode/dist/src/SocketModeClient.js:244–316`: JSON parse 후 `slack_event`의 `body`에 WebSocket `event.payload`를 전달.
2. `@slack/bolt/dist/receivers/SocketModeReceiver.js:137–148`: 그 body를 `App.processEvent`로 전달. 기본 customPropertiesExtractor는 빈 객체.
3. `@slack/bolt/dist/App.js:423–588`: authorize 성공 후 context를 구성. Events API에서는 `payload = body.event`, `event = payload`이므로 listener의 event와 body.event는 같은 객체다. context는 authorizeResult/customProperties/실행 관련 정보로 구성하며 action_token을 별도로 복사하는 코드는 확인되지 않았다.
4. `shookie/src/index.ts`: 표준 Socket Mode App, custom receiver/extractor 없음. 앱 인증/수신 구성을 이 PR에서 변경하지 않는다.

| 진단 경로 | 근거 / 확실성 | 실제 선택에 사용? |
|---|---|---|
| `event.action_token` | 공식 event payload 설명 + 기존 handler 선택 경로. 운영 존재 여부는 미확인 | 기존대로 이 위치만 |
| `body.event.action_token` | SDK가 제공하는 위 event의 alias. 정상 Bolt 전달에서는 동일해야 함 | 아니오 |
| `body.action_token` | 전체 Events API body의 고정 관찰 후보. 공식문서/설치 SDK에서 top-level 위치는 **확인되지 않음** | 아니오 |
| `context.action_token` | Bolt 인증/middleware context의 고정 관찰 후보. 이 앱/SDK/공식문서에서 공급 경로는 **확인되지 않음** | 아니오 |

WebSocket 바깥 envelope는 listener body가 아니다. `body.payload.*`, camelCase, 파일/블록/본문 내부, 임의 키 탐색은 하지 않는다. 이 네 후보 밖의 위치는 이번 진단으로 배제할 수 없다.

## 보안 및 필드 계약

기본 INFO 수준의 고정 메시지 `slack_action_token_diagnostic`만 추가한다. 전역 로깅 정책, 환경변수, 의존성은 추가하지 않는다. 기존 로그 전체가 이 계약으로 바뀌는 것은 아니므로 운영 공유 시 **진단 레코드만** 발췌한다.

추가 payload 필드는 아래 allowlist만 사용하며, requestId 외의 값은 boolean 또는 고정 enum이다:
- `stage`: `receive`, `selection`, `binding`, `search`, `search_api`
- `eventKind`: `app_mention`, `message`, 또는 correlation을 잃은 search에서 `unknown`
- `requestId`: 기존 `slack-event:<event_id>` 또는 기존 `slack-fallback:<id>` (새 토큰 hash가 아님). 검색에서는 trusted WeakMap의 상관정보/identity에서만 가져오며, 둘 다 없으면 생략한다. model context.get의 requestId는 신뢰하지 않는다.
- 수신: `eventTokenObservation/Present/Usable`, `bodyEventTokenObservation/Present/Usable`, `bodyTokenObservation/Present/Usable`, `contextTokenObservation/Present/Usable`
- 선택: `selectedSource` (항상 `event.action_token`), `selectedUsable`
- 바인딩: `bindingAttempted`, `selectedUsable`, `identityBound`, `tokenBound`
- 검색: `correlationAvailable`, `identityBound`, `tokenBound`

`Observation`은 `absent` / `data` / `accessor` / `blocked`. `Present`는 **own property 슬롯 존재**를 뜻하므로 값이 undefined/null/숫자여도 true일 수 있다. usable은 기존 validation(비어 있지 않은 string, 최대 16,384 문자, U+0000–U+0020 없음)과 완전히 동일하다. **토큰 길이 자체를 기록하지 않는다.** accessor는 존재하지만 읽지 않아 usable=false, Proxy/중간 body.event accessor는 blocked로 표시한다. blocked/accessor의 false를 “토큰 미수신” 증거로 해석하면 안 된다. prototype에서 상속된 필드는 관찰하지 않는다.

진단은 고정 own property descriptor만 읽고 getter, Proxy trap, key 순회, 임의 객체의 stringify/toJSON을 실행하지 않는다. 기존 `event.action_token`의 단일 선택 read는 그대로이며, 진단 때문에 다시 읽지 않는다(기존 선택 경로의 getter 동작을 바꾸는 하드닝은 이번 범위 밖이다). validation은 primitive string에만 적용한다. 로거에는 새로 만든 allowlist primitive 객체만 넘긴다. 토큰 값/부분값/hash/길이, 메시지·파일 본문, 사용자·채널 metadata, private URL, raw event/body/context, 오류 원문은 추가 로그에 넣지 않는다.

토큰은 기존 비저장 WeakMap에만 남는다. 진단 상관정보는 별도 WeakMap의 requestId/eventKind만 저장하고, RequestContext 항목/모델 입력·응답/DB에 진단이나 토큰을 추가하지 않는다. 진단의 후보 위치와 상관정보는 **권한 근거가 아니다**.

## 단계별 해석

같은 requestId의 레코드만 비교한다. 재전송/중복 수신은 receive가 여러 개일 수 있고, 명시적 페이지 검색은 search/search_api가 여러 개일 수 있다.

| 관찰 | 해석 및 다음 확인 |
|---|---|
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
3. 재현 시각을 기록하고 해당 시간대의 **slack_action_token_diagnostic 레코드만**, 그 안의 requestId로 receive → selection → binding → search → search_api를 확인한다. raw debug/socket payload 로깅을 켜거나 토큰을 복사/붙여넣기하지 않는다. 동시에 별도 요청을 보내지 않는다.
4. 위 표대로 안전한 boolean/enum 필드만 보고한다. 실제 운영 증거 전에는 미수신 결론 금지. 검색이 호출되지 않았다면 즉시 같은 요청을 반복하지 말고 그 실행 흐름부터 확인한다.
5. 증거 확보 뒤 **진단 로그·correlation WeakMap 제거 후속 PR이 필요**하다. 영구 수신 경로 수정/다른 위치 fallback/검색 신뢰 경계 변경은 증거와 별도 승인 후 진행한다.

## 테스트

- `action-token-diagnostics.test.ts`: 기존 validation 경계, 누락/정상/잘못된 값, 네 후보 분리, 악성 getter/Proxy(폐기 포함)/toJSON 비실행, allowlist 및 secret 비노출, team 부재/상관관계 상실.
- `handlers.test.ts`: 실제 handler → WeakMap binding → search/API의 동일 requestId 연결, 다른 위치 token 자동 fallback 금지, 토큰의 모델/DB/검색 응답 비노출.
- 기존 Slack search/authorization/client/SDK logger 및 cancellation/handler 회귀 테스트로 권한·검색 결과·취소 불변 확인. database build를 먼저 수행한다.
