# 대화 전체 3분 제한 / 요청자 취소

## 정책 / 실제 배선

**실제 실행 시작부터 전체 180초 + 요청자 전용 Slack 취소 버튼**만 추가한다. 큐 대기는 제외한다. 새 전체 호출량 cap, 비용 기록/경고/강제 상한, 모델 변경, 운영 설정 또는 DB 변경은 없다. 기존 `maxSteps`, 호출 로그 및 진단 footer를 유지한다.

통합 기준은 main `e2b3298e5e5a2d1c6644995051fa91ad5c0631e1` (Slack read/search/authorization PR #91, 첨부 PR #92, web 포함)이다.

- `ConversationRuntime.acquire()` 직후 `ExecutionScope`를 만든다. DB claim → 초기 control message → source fetch/summary → main → subagent/tool → 성공 persist 시작 전 체크까지 하나의 절대 `deadlineAt`과 signal을 공유한다. 단계별로 180초를 갱신하지 않는다.
- 기존 event dedupe / thread 직렬화 / admission concurrency / cache / DB 성공 turn 정책을 유지한다. queue에는 타이머/UI/registry가 없으며 claim 중복은 UI도 만들지 않는다.
- `handlers.ts`는 plan stream을 열기 **전**, Slack source 조회/요약 **전** 짧은 control message를 스레드에 게시한다. 별도 plan stream은 기존대로 유지해 progress UX를 보존한다. 버튼은 status message에만 두고 plan에는 중복하지 않는다.
- 취소/시간초과 안내는 execution abort와 별개인 bounded delivery scope로 즉시 시작한다. 실제 underlying 작업이 정리 중이라는 사실을 명시한다. 완료/오류/취소/시간초과에서는 버튼을 제거하고 열린 stream도 정리한다. cleanup 실패로 남은 버튼도 registry/state 검증으로 사용할 수 없다.

## 신뢰 / 취소 권한

`CancellationRegistry`는 원래 검증된 Slack event의 `requestId/teamId/channel/threadTs/userId`를 불변 복사하고, 서버 자신의 control post 응답 ts에 bind한다. trusted team을 구할 수 없는 요청에는 status만 제공하며 취소 버튼을 제공하지 않는다.

Bolt action handler의 첫 호출은 `await ack()`다. 이후 검증된 action envelope의 `body.user.id`, `body.team.id`, `body.channel.id`, `body.container.channel_id/message_ts`, 있는 경우 `message.ts/thread_ts`, Bolt `context.teamId` 일치를 확인한다. button `value`는 requestId 조회 힌트일 뿐이다. actor/approved/team/thread 등 button payload, model output, message content를 권한으로 신뢰하지 않는다.

다른 requester/team/channel/thread/message, malformed/unknown/expired/completed/committing/repeated 클릭은 **동일한 unavailable 안내를 클릭 사용자에게만 ephemeral로** 전달한다. 다른 요청자의 취소 여부나 registry 존재를 공개하지 않는다. committing 동안에도 취소를 접수했다고 거짓 안내하지 않고, 동일 안내에서 “결과 저장 중이거나 종료된 요청은 취소할 수 없음”을 설명한다.

active registry는 기존 runtime admission bound만 사용한다. 중단됐지만 미settle인 live entry를 evict하지 않는다. finally 제거 시 controller identity를 비교해 stale cleanup이 새 요청을 지우지 않는다. durable dedupe는 기존 DB event ledger가 담당하며 실패 요청 retry를 재실행하지 않는다.

## shared signal / 실제 종료 / 잔여 작업

`shookie/src/cancellation/execution-context.ts`의 실행 ALS는 기존 agent 호출 로깅 ALS와 별개다. `executionTools()`는 공개 `Tool.execute`를 감싸 public `ToolExecutionContext.abortSignal`과 shared signal을 결합하고, 앞/뒤 절대 deadline 체크 및 실제 Promise 추적을 한다. 모든 기존 tool/schema의 합집합을 유지한다.

- Mastra main `agent.stream`과 직접 위임하는 subagent `agent.generate`에 공개 `abortSignal` 옵션을 명시한다. PostHog 위임도 기존 trusted RequestContext object를 보존한다. 새 모델/step cap을 만들지 않는다.
- thread summary AI SDK `generateText.abortSignal`은 기존 60초 local timeout과 shared signal을 결합한다. source pagination과 summary 결과 뒤 execution 체크로 늦은 원문/요약/답변을 버린다.
- PostHog/GitHub fetch, Git subprocess, web pinned HTTP/MCP/search/readBody, Slack attachment download/parser에 actual signal이 도달한다. 기존 local transport/크기/parse 제한도 그대로 적용한다.
- Slack API 메서드 body의 `signal`은 transport 취소 API가 아니다. source/status/plan은 **전용 WebClient**의 공개 `requestInterceptor`로 Axios HTTP signal을 설정한다. 공용 `app.client`는 변경하지 않는다. 전용 read/search/attachment API client도 execution interceptor로 shared signal을 설정한다. SDK 기본 Axios adapter를 유지하고, unknown custom adapter는 fail closed한다.
- Slack transport는 SDK retry 0, 429 즉시 reject, 최대 15초 HTTP timeout이며 기존 read/search 10초처럼 더 짧은 timeout은 보존한다. 기존 bot auth/header, TLS, agent/proxy, 신뢰된 endpoint/interceptor를 보존한다. endpoint override/localhost는 테스트 DI일 뿐 운영 목적지 설정을 추가하지 않는다.
- attachment parser는 abort/timeout/output limit에서 SIGKILL하지만 **실제 child close 이후에만 Promise/파서 slot이 settle**한다. Git도 실제 close를 기다리며 disk monitor 잔여 Promise를 추적한다. HTTP request close와 signal 없는 DNS Promise도 실행 scope에 추적한다.
- `Promise.race`로 사용자 관측 시간을 제한하는 기존 web/GitHub 경계가 있더라도 실제 작업 Promise는 `trackExecution()`에 남는다. runtime은 commit 전에 및 finally에서 `scope.drain()`을 기다리고, 실제 잔여 작업이 모두 settle된 뒤에만 semaphore와 같은-thread lane을 해제한다. 늦은 DNS 응답 뒤에는 abort 체크로 새 HTTP를 시작하지 않는다.

이것은 “정확히 180초에 모든 OS/SDK 작업이 이미 사라졌다”는 보장이 아니다. signal 없는 DNS/DB 또는 취소를 무시하는 주입 SDK Promise는 강제로 끝낼 수 없다. production HTTP는 abort와 유한 transport timeout, parser/process는 kill+close로 settle하지만, 미settle 잔여 작업은 slot/lane을 계속 보유한다. 안내를 먼저 보냈다는 이유로 조기 release하지 않는다. 이미 실행한 외부 도구 side effect나 Slack progress는 rollback할 수 없다. 동기 web parse도 JS 이벤트 루프 중간 취소는 불가능하므로 기존 크기 제한과 전후 절대 deadline 체크로 늦은 결과를 차단한다.

## commit / deadline / delivery 경주

`control.commit(persist)`의 동기 사전 체크/committing 전환이 선형화 지점이다.

| 순서 | 정책 |
| --- | --- |
| 취소/deadline → commit 시도 | persist 미호출; 늦은 성공 turn/최종 답변 금지 |
| commit 시작 → requester 취소 클릭 | committing 중 취소 unavailable |
| commit 시작 → deadline → persist 성공 | in-flight transaction 실제 결과를 기다림; durable 성공 보존, `fail()` 금지 |
| commit 시작 → deadline → persist 실패 | 성공 없음; 실패 dedupe/친화적 timeout 안내, 늦은 답변 금지 |
| 성공 commit → 로그/Slack delivery 오류 또는 늦은 취소 | 성공 turn을 실패로 뒤집거나 실패 안내로 덮지 않음 |

final 성공 전달은 persist 뒤, 부가 DB logging 앞에 한다. 후속 logging 실패가 답변을 숨기지 않는다. runtime/handler 모두 committed 상태를 확인하여 성공 뒤 `repository.fail()`/오류 invocation 재기록/오류 안내를 하지 않는다. 취소/timeout turn은 다음 history에 넣지 않는다.

`slackDelivery()`는 execution ALS 밖에서 **별도 전체 15초 signal**, 전용 client, retry 0을 사용한다. final stopStream 실패 시 기존 postMessage fallback을 유지하되, delivery signal이 이미 abort된 경우 늦은 fallback을 시작하지 않는다. status cleanup과 action ephemeral도 별도 bounded delivery다. Slack이 요청을 받아들인 뒤 연결이 끊기는 ambiguous 전송은 exactly-once가 아니며 fallback 중복 가능성은 기존처럼 남는다. 이미 시작한 transport의 실제 종료를 기다리는 정책이지 취소 불가능 API를 race만으로 끝났다고 주장하는 방식이 아니다.

## Slack read/search/attachment 보안 보존

`bindSlackReadContext`의 identity/action_token 별도 WeakMap에 바인딩된 **동일 RequestContext object**를 authorization/search/attachment bridge에 전달한다. cancellation registry나 일반 context/model/tool/DB entry로 action_token을 복사하지 않는다. 기존 cursor 상태/매 페이지 live membership/현재 채널 scope/공유채널 차단/DM peer/정확한 message→file 관계 검증을 유지한다. reader를 실행마다 새로 만들어 cursor를 잃지 않는다.

취소 클라이언트도 공유 `silentSlackLogger`를 사용하여 DEBUG에서도 request/response/warning/error/action_token 로그가 no-op이다. 기존 handler의 Slack tool input/output/opaque cursor 및 attachment 로그/progress redaction도 유지한다. sanitized tool/access error가 underlying abort를 숨기더라도 외부 execution checkpoint에서 중단을 계속 검사한다.

## 후속 이미지 도구용 public signal 계약

이미지 후속 task는 이 PR의 tool 등록 합집합과 RequestContext 보안을 보존하며 나중에 연결한다. 사용할 API:

```ts
executionSignal(context?.abortSignal) // shared + public tool signal, 없으면 undefined
executionCheckpoint()               // 앞/뒤 절대 deadline 및 tool abort 검사
executionOperation(() => actualWork(), context?.abortSignal)
trackExecution(actualPromise)      // race/early return 뒤에도 실제 잔여 Promise 소유권 보존
```

HTTP/LLM에는 반환 signal을 actual transport의 `signal`/`abortSignal`로 전달한다. 다운로드/파서는 explicit signal 옵션을 지원한다 (`DownloadDependencies.signal`, `parseAttachment(body, kind, signal?)`). 실제 socket/process 종료를 검증하고, kill/race 직후가 아닌 close/settle 후에 파서/실행 자원을 해제한다. token/actor를 signal 전달용 context에 재바인딩하지 않는다. 새 호출량/비용 cap이나 비용 정책은 추가하지 않는다.

## 검증과 남은 한계

- fake timer/registry: 정확히 180초, 여러 단계 합산/queue exclusion, requester 성공과 다른 user/team/channel/message/thread/위조 payload/repeated/expired/completed/committing 거절, cancellation shared signal/late answer suppression.
- 실제 runtime/handler 통합: source fetch 이전 버튼, 즉시 action ack, fetch/summary/main 취소, 180초 즉시 안내와 잔여 slot/thread 유지, late tool drain, failed dedupe/다음 요청 회복, commit 시작 전/중/후 경주, committed logging/delivery failure 보존, 버튼 정리 및 기존 streaming fallback 회귀.
- 실제 로컬 transport/SDK: Slack/Web/첨부 HTTP socket close, pre-aborted socket 미생성, 15초 HTTP timeout close, 429 무재시도, SDK no-op secret log, TLS/agent/proxy 설정 전달; 실제 AI SDK DeepSeek 요약 HTTP 취소; 실제 Mastra stream/generate provider 및 tool signal; 실제 parser child SIGKILL/close/다음 parse 회복.
- TLS 설정 전달 테스트는 실제 TLS handshake/인증서 E2E가 아니다. **실제 운영 Slack/실제 LLM E2E는 미실행**이며 bot scope/Real-time Search 및 action_token 수신 성공을 로컬 테스트로 보증하지 않는다.
- 실행 큐/registry/ALS는 single-process다. replica 간 서로 다른 event의 thread 직렬화나 process 재시작 뒤 살아 있는 버튼 회수는 보장하지 않는다. 재시작 후 registry에 없는 버튼은 동일 unavailable 응답이다.
