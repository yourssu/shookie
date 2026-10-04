# 대화 전체 실행 제한 / 요청자 취소

## 정책과 현재 구현 단계

승인 정책은 **실제 실행 시작부터 전체 180초 + 요청자 전용 취소 버튼**이다. 대기열 시간은 포함하지 않는다. 새 전체 호출량 cap, 비용 기록/경고/강제 상한, 모델 변경, 운영 설정 또는 DB 변경은 없다. 기존 `maxSteps`와 호출 로그를 유지한다.

현재 독립 모듈 (`shookie/src/cancellation/`)과 그 단위 테스트만 추가되어 있다. 아직 Slack action 등록, control message, runtime 및 agent/tool 전파는 연결되지 않았다. 아래 통합 계약은 선행 Slack read/첨부/shared handlers 및 web 변경을 main에 squash 통합한 뒤 적용한다. 이 단계 테스트 통과는 실제 Slack E2E 또는 provider 실행 취소 성공을 의미하지 않는다.

## 단일 실행 범위

- `ConversationRuntime.acquire()`가 완료된 직후 `ConversationControl`을 만들고, 큐에는 컨트롤러/타이머를 만들지 않는다. DB claim, source fetch, summary, main, subagent, tool에 하나의 `signal`과 절대 `deadlineAt`을 공유한다. 단계마다 180초를 갱신하지 않는다.
- `checkpoint()`는 타이머 콜백이 늦어져도 절대 시각을 검사한다. `operation(fn)`은 실제 underlying Promise를 기다리고 앞/뒤 체크로 늦은 결과를 버린다. 단독 `Promise.race`로 실제 작업 종료를 주장하지 않는다.
- 취소/시간초과는 provider 에러를 친화적인 `ConversationStoppedError`로 정규화한다. 사용자에게 raw error나 token을 전달하지 않는다.
- `finish()`는 실제 실행·persist 작업이 settle된 뒤에만 호출한다. runtime semaphore와 동일 thread 직렬화도 그때만 해제한다. 중단된 잔여 작업이 실행 중이면 slot/lane을 계속 보유해야 한다. 반응성을 위해 종료 안내를 먼저 보내더라도 이를 실행 settlement로 간주하면 안 된다.
- 지원하지 않는 SDK 호출은 명시적인 transport timeout/무재시도로 settle을 제한하고, residual ownership을 유지한다. 메모리/DB Promise처럼 signal 없는 호출도 timeout 경주만으로 slot을 해제하지 않는다. 강제 DB rollback/새 연결 설정을 추가하지 않는다.

## 취소 소유권과 UI 통합 계약

1. 검증된 원래 Slack event의 `requestId/teamId/channel/threadTs/userId`를 server registry에 복사한다. trusted team을 구할 수 없는 요청에는 취소 버튼을 제공하지 않는다. 메시지 본문/모델/첨부 내용에서 actor를 추론하지 않는다.
2. runtime acquire와 claim 성공 후 **source fetch/summary 이전**에 짧은 초기 status/control message를 스레드에 게시한다. 버튼 `value`는 requestId 조회 힌트뿐이며 actor/승인 데이터는 없다. 서버 자신의 post 응답 ts로 registry에 bind한다. 다른 메시지/팀/채널 버튼은 일치하지 않는다.
3. Bolt action handler는 먼저 `await ack()`하고 취소 상태 조회보다 먼저 acknowledgement를 끝낸다. 이후 검증된 `body.user.id`, `body.team.id`, `body.channel.id`, `body.container.channel_id/message_ts`(및 있는 경우 message thread)를 읽는다. 채널/메시지 필드 불일치, 잘못된 형식, app/team 불일치는 거절한다. untrusted button payload의 actor/approved/thread를 신뢰하지 않는다.
4. 잘못된 사용자/팀/스레드/메시지, unknown, expired, committing, completed, 반복 클릭은 모두 동일한 친화적 unavailable 안내를 **클릭 사용자에게만** 전달한다. 다른 요청자의 취소 여부나 registry 존재를 유출하지 않는다. accepted는 즉시 종료 확정이 아닌 “취소를 접수하고 정리 중”으로 안내한다.
5. 초기 control message를 plan 안내와 중복하지 않도록 짧게 유지한다. 기존 plan stream은 그대로 사용한다. 최종 성공/오류/취소/시간초과에서 control message 버튼을 제거하고 plan stream도 정리한다. 정리 실패로 UI가 남아도 registry/state 검증으로 추가 실행/취소가 불가능하다.
6. active registry는 기존 runtime admission bound만 사용한다. 실행 중(중단됐지만 미settle 포함) entry를 임의로 evict하지 않는다. finally에서 controller identity를 비교해 제거하여 stale cleanup이 새 실행을 지우지 않는다. durable dedupe는 기존 event ledger가 담당한다.

## commit / deadline / delivery 경주

`control.commit(persist)`의 동기 사전 체크/committing 전환이 선형화 지점이다.

| 순서 | 정책 |
| --- | --- |
| 취소 또는 deadline → commit 시도 | persist를 호출하지 않음; 성공 turn 생성 금지 |
| commit 시작 → 요청자 취소 클릭 | committing 동안 취소 불가/동일 unavailable 안내 |
| commit 시작 → deadline → persist 성공 | 이미 시작한 transaction의 결과를 기다림; durable 성공 보존, `fail()` 금지 |
| commit 시작 → deadline → persist 실패 | 성공 없음; 실패 dedupe 유지, 늦은 답변 전송 금지 |
| 성공 commit → 로그/Slack delivery 오류 또는 늦은 취소 | 성공 turn/로그 상태를 취소 실패로 바꾸지 않음 |

runtime catch는 `isCommitted`를 확인하여 성공 뒤 `repository.fail()`을 호출하지 않는다. callback이 commit을 안 했으면 기존 실패 처리를 유지한다. 취소나 timeout turn은 다음 대화 history에 넣지 않는다. Slack final 안내/성공 delivery는 실행 signal과 분리된 **별도 bounded delivery scope**를 사용한다. 실행 timeout 뒤 final 안내를 aborted execution signal로 보내면 안내가 사라진다. post/stop 응답이 늦어지거나 ambiguous일 때 무제한 retry/fallback을 하지 않고, 이미 시작한 전송의 residual settlement도 명시한다. Slack의 전송 원자성/이미 보내진 progress의 회수까지 보장하지 않는다.

## 설치된 SDK 공개 API 확인

- Mastra `@mastra/core` 공개 `AgentExecutionOptionsBase.abortSignal`은 `agent.stream()`/`agent.generate()` 양쪽 옵션에 있다 (`dist/agent/agent.types.d.ts`). 메인과 직접 위임하는 서브에 같은 signal을 명시한다. `RequestContext`는 신뢰된 identity 및 필요시 실행 제어 전달에 사용하며 모델이 signal/actor를 만들지 않는다.
- Mastra 공개 `ToolExecutionContext.abortSignal`이 제공된다 (`dist/tools/types.d.ts`). 각 도구에서 해당 signal을 실제 fetch/HTTP/subprocess에 넘겨야 한다. 옵션을 넣었다는 사실만으로 모든 nested tool이 중단된다고 주장하지 않는다. SDK stream settlement와 늦은 tool continuation을 각각 검사한다.
- thread summary의 AI SDK `generateText`는 `abortSignal`을 사용한다. 기존 60초 개별 timeout이 있다면 `AbortSignal.any([shared, localTimeout])`로 결합하고 전체 deadline은 유지한다.
- fetch/Node HTTP/git subprocess는 AbortSignal을 지원한다. PostHog/GitHub/web/첨부 다운로드 및 parse 각각에서 실제 signal, settle, 전후 checkpoint를 확인한다. 동기 parse는 JS 이벤트 루프상 중간 취소가 불가능하므로 기존 크기 제한과 앞/뒤 절대 deadline 검사로 늦은 결과를 막는다.
- 설치된 Slack WebClient는 메서드 argument의 signal을 transport signal로 해석하는 공개 API가 없다. 단순히 `conversations.replies({ signal })`로 넘기면 Slack API body일 뿐이다. 공개 `WebClientOptions.requestInterceptor`/`adapter`의 Axios request config에는 signal을 전달할 수 있다. 전용 실행 client + interceptor에서 shared signal을 넣고 `retryConfig: { retries: 0 }`, `rejectRateLimitedCalls: true`, bounded `timeout`을 적용하는 방식을 검토한다. 원래 client를 전역 변경하거나 취소 scope 간 interceptor를 공유하지 않는다. 기본 SDK는 무제한에 가까운(약 30분 재시도/timeout=0) 대기여서 그대로 두고 180초 종료를 주장할 수 없다.

## 검증 구분

독립 fake-timer 테스트: 실행 시작 시각/정확히 180초/여러 단계 합산, 절대 시각 재검사, shared signal, cooperative underlying abort, signal 무시 Promise의 실제 settlement 보유와 late result/commit 차단, commit 시작 전/중/후 경주, registry requester/team/channel/message/thread/중복/만료/종료/위조 metadata 거절.

통합 후 필수 테스트: 실제 acquire 뒤 timer 생성과 queue exclusion, action 즉시 ack 및 사용자 한정 안내, source fetch 이전 버튼, 실제 Mastra/HTTP/subagent/tool 전파, residual slot/lane 보유, deadline 이후 bounded delivery, 버튼/stream 정리, DB dedupe/성공 commit 보존/다음 요청 회복 및 기존 Slack streaming fallback 회귀. 실제 Slack E2E는 별도이며 단위/로컬 mock 테스트와 구분하여 보고한다.
