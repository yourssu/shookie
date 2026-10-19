# 요청·모델·도구 관측 지표

사용자 답변/footer를 바꾸지 않고 기존 logger의 info `observability`에 작은 구조화 객체를 추가한다. DB/schema/migration, 모델/설정, prompt, 호출량·비용 정책은 변경하지 않는다. [전달 계약](response-delivery.md), [취소/실제 drain 계약](conversation-cancellation.md)은 그대로다.

## 상관관계와 수명

- DB claim 성공 이후 실행의 `ExecutionScope.metrics`에 collector를 붙인다. 기존 execution ALS를 사용하되 RequestContext/인증 정보는 변경하지 않는다. 모든 main/tool 레코드는 동일한 **무작위 UUID `correlationId`**를 쓴다. 원래 Slack request/session/event/actor/team/channel/thread ID는 metrics에 복사하지 않는다.
- `kind`는 `request`, `model_call`, `tool`. tool 이름은 코드에 고정한 등록 이름 allowlist만 허용하며 나머지는 `other`, model은 고정 label `main`이다. 인자/본문/원시 결과/출처 URL/오류 message·stack/secret은 metrics 필드가 아니다.
- claimed 실행은 source/생성/저장/전달 실패·취소에도 handler finally에서 **terminal request 객체를 한 번만 생성**한다. duplicate claim/동일 pending event, admission/input 거절, claim 전 DB 실패에는 실행 metrics를 만들지 않는다. 프로세스 crash/종료의 terminal 기록은 보장하지 않는다.
- sink는 최대 256개의 scalar-only 객체 큐다. 한 번의 detached `setImmediate`에 하나씩 기존 logger로 넘기고 unref한다. 실행은 sink/log를 await하지 않으며, full이면 신규 레코드를 버린다. logger/sink의 동기 throw와 sink Promise rejection은 격리한다. 따라서 overload/종료 시 **실제 로그에 terminal이 반드시 남는다는 보장은 없다**. 로그 전송 실패를 비즈니스 실패로 바꾸거나 재실행하지 않는다.
- 기존 동기 console logger를 별도 thread로 옮기지는 않았다. 느린 console은 detached flush 시 이벤트 루프를 지연시킬 수 있다. hot path에는 로그 I/O await/새 payload serialization이 없지만 무영향/측정 성능 개선을 주장하지 않는다.

## 요청 레코드: 시간 경계와 상태

모든 elapsed 값은 `performance.now()`의 monotonic 차이(ms, 0 이상)다. 미관측은 `null`이며 0으로 대체하지 않는다.

| 필드 | 의미 |
| --- | --- |
| `firstModelDeltaMs` | handler 수신 → root run의 첫 nonempty public `text-delta.payload.text`. reasoning/nested/tool/control 제외. 전송/가시성 확인과 다르다. |
| `firstConfirmedTextMs` | handler 수신 → 실제 본문을 포함한 preview post/update의 정상 ACK(known ts, warning 없음), 또는 final-only fallback start/post의 `ok`+`ts` ACK 중 최초. greeting도 실제 post ACK만 인정. control message는 제외. provisional text일 수 있으며 canonical 정답/최종 완료 지표가 아니다. |
| `generationMs` | main `agent.stream` 직전 → stream 소비/usage·steps·finishReason 수집/canonical 검증 완료. 실패는 해당 실패 경계까지. source 조회/summary/setup, preview seal 대기, save/delivery는 제외. 도구 실행은 포함. |
| `finalDeliveryMs` | 저장 후 final reconcile/fallback 시작 → 최종 전송 확인 또는 전달 실패/미확인 판정. 독립 delivery scope의 cooldown/drain 대기도 포함. |
| `finalConfirmedDeliveryTotalMs` | handler 수신 → 최종 전달 **전체** 성공 확인. append/stop/final ACK 손실이면 `null`. 첫 텍스트 ACK가 먼저 있었더라도 전체 성공을 지어내지 않는다. |
| `totalMs` | handler 수신 → runtime 실제 drain, 부가 DB 로깅, error 안내/control cleanup까지 끝난 handler terminal. queue/source/save/delivery 시간을 포함하며 위 필드들의 단순 합이 아니다. |

`requestStatus`: `success` / `saved_delivery_uncertain` / `stopped` / `error`.
`generationStatus`, `saveStatus`, `deliveryStatus`: 단계별 `not_started`, `success`, `error`, `cancelled`, `limited`, `uncertain` (내부 진행 중에는 `running`). `stopStatus`: `none`, `cancelled`, `timeout`.

생성 성공·저장 성공은 delivery uncertain과 공존한다. 실제 deadline signal은 commit 도중 발생할 수 있으므로 durable 성공과 stop reason도 별개다. first text ACK 뒤 append/stop 실패는 first-confirmed 값은 유지하지만 최종 delivery는 uncertain이다. ACK 손실/false/missing-ts는 최초 가시성 성공을 만들지 않는다. 오류/취소 안내는 assistant answer TTFT로 세지 않는다. 전송을 재시도/repost하지 않는다.

예시(설명용 수치이며 운영 측정이 아님):

```json
{"kind":"request","correlationId":"<random UUID>","requestStatus":"saved_delivery_uncertain","generationStatus":"success","saveStatus":"success","deliveryStatus":"uncertain","stopStatus":"none","firstModelDeltaMs":20,"firstConfirmedTextMs":70,"generationMs":90,"finalDeliveryMs":30,"finalConfirmedDeliveryTotalMs":null,"totalMs":150}
```

## 모델 사용량: API가 제공한 값만

- pinned Mastra public `onStepFinish`의 typed `step.usage`를 사용한다. 완료된 모델 step마다 `kind:model_call`, `status:completed`, `step`(0부터)을 기록한다. 마지막 canonical 성공과 모델 step 완료는 다르다. 다음 호출이 실패해도 이전 완료 step의 usage는 남는다. 사용량이 노출되지 않은 실패/취소 중 호출은 추정하지 않는다.
- callback이 전혀 없는 adapter에서는 완료 후 `streamResult.steps`만 fallback으로 사용한다. callback과 steps를 이중 기록하지 않고, aggregate `streamResult.usage`를 이 레코드에 더하거나 별도 합산하지 않는다.
- `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`는 nonnegative safe integer 또는 `null`. 실제 pinned DeepSeek wire → Mastra 경로에서 `usage.raw.raw`로 보존된 provider usage를 검증했다. `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`/`prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`의 실제 존재를 사용한다. SDK가 optional cache/reasoning에 기본 0을 채워도 wire에 없으면 `null`이다. raw/provider metadata 자체는 로그하지 않는다.
- raw가 없는 adapter는 공개 input/output optional 필드만 이용하며 cache/reasoning은 unknown이다. 향후 다른 provider/adapter는 해당 wire 의미를 다시 검증해야 한다. cache miss 파생값/비용/품질 점수는 추가하지 않았다.
- 기존 DB용 aggregate token/invocation/agent-call 기록과 그 기존 기본값 의미는 **변경하지 않았다**. 새 step metrics와 DB aggregate를 함께 합산하면 이중 계산이다. thread summarizer/image helper 모델 사용량은 이번 범위에서 추가 노출하지 않는다.

## 도구: 시간과 안전한 크기 scope

기존 `executionTools` wrapper 한 곳에만 결합했다. WeakSet을 유지해 중복 wrapper/측정을 만들지 않는다. 동일 execute receiver/input/RequestContext와 원래 반환 객체/rejection을 보존한다. 기존 shared/explicit abort 체크·추적·실제 drain을 유지한다. ALS 없는 실행은 metrics 없이 동작한다.

`elapsedMs`는 public execute 진입 → 기존 cancellation operation의 실제 반환/실패까지다. underlying 작업이 cancellation을 무시하면 실제 settlement까지 포함하며, 도구 내부에서 race 후 조기 반환한 잔여 작업 전체 시간이라고 주장하지 않는다. `status`는 실행 경계의 `success`/`error`/`cancelled`. 반환 envelope의 allowlisted own data-property `status`는 별도 `resultStatus`(`success`/`error`/`partial`/`cancelled`/`unknown`)다. 도구가 실패 envelope를 반환해도 JS 실행 자체는 success일 수 있다. `partial`/`truncated`는 top-level own boolean data-property가 있을 때만 기록하며 없으면 `null`이다.

| 크기 필드 | scope |
| --- | --- |
| `totalResultBytes`, `totalResultBytesStatus` | primitive 결과의 JSON UTF-8 serialized byte 수. string은 quotes/JSON escaping 포함, number/nonfinite/null/boolean도 JSON 규칙. object/array/class/BigInt/undefined/function/symbol은 `null`/`unknown`. |
| `dataJsonBytes`/`textJsonBytes`/`contentJsonBytes`, 각각 `…Status` | plain non-Proxy object의 고정 최대 3개 own DATA descriptor 중 **문자열인 값 하나**를 JSON string으로 표현했을 때의 UTF-8 byte 수. 필드 키/바깥 envelope 크기는 제외. 각각 독립 측정이며 절대 합산해 total이라고 하지 않는다. GitHub `data` JSON 문자열의 크기는 이 scope로 관측 가능하다. |

각 string 측정은 최대 65,536 bytes에 도달하면 중단하고 값은 65,536, status는 `capped`(실제 크기의 하한: **`>=65,536`**)다. 그 미만만 `exact`. 거대한 문자열 전체의 Buffer/TextEncoder/JSON.stringify를 만들지 않는다. UTF-8 multibyte/surrogate pair/JSON escaping을 bounded scan으로 계산한다. 세 필드 모두 있어도 scan 양은 고정 예산 3개다.

object 전체는 `Object.keys`/`ownKeys` 자체도 무제한 임시 배열을 만들 수 있어 측정하지 않는다. Node `util.types.isProxy`로 Proxy를 먼저 제외하고, plain/null-prototype object의 고정 property descriptor만 읽는다. getter/toJSON/constructor/Proxy trap 호출, 키 열거, recursive traversal, nested JSON 파싱은 없다. cycle, class, array, nested structured output은 탐색하지 않는다. descriptor 예외는 격리하고 unknown을 유지한다. 따라서 전체 구조화 결과가 작거나 크다고 단정할 수 없으며 nested truncation flag도 추정하지 않는다. **capped는 size 측정 상한이지 실제 도구 응답 truncated=true라는 뜻이 아니다.**

예시(설명용):

```json
{"kind":"tool","correlationId":"<same UUID>","tool":"github_read","elapsedMs":12,"status":"success","totalResultBytes":null,"totalResultBytesStatus":"unknown","dataJsonBytes":240,"dataJsonBytesStatus":"exact","textJsonBytes":null,"textJsonBytesStatus":"unknown","contentJsonBytes":null,"contentJsonBytesStatus":"unknown","partial":null,"truncated":null,"resultStatus":"unknown"}
```

## 남아 있는 로그 / 검증

기존 `[diagnostic]` finishReason/steps/textLen/token 로그, generation/delivery/status 로그, debug step 로그, DB tool/invocation 기록은 제거하지 않았다. 기존 Slack read redaction도 유지한다. 기존 내용 excerpt/debug/서드파티 framework error logging 전체를 content-free로 만드는 변경은 아니며, privacy 보장은 새 `observability` 레코드의 allowlisted scalar 필드에 대한 것이다. 새 verbose/debug payload 로깅은 없다.

최신 main 호환성 검증 SHA: `9cb40cf4d70e1faf5326878bff900366f978560e`. A의 squash main `40b34673bcae9eae43b5b1c6a1363f193145e4fa`를 일반 merge로 통합했으며 충돌이 없었다. main 대비 diff는 B metrics/좁은 delivery hook/문서/전용 테스트에만 한정된다. A 파일은 수정하지 않았다.

- 최신 SHA에서 `yarn workspace database build && yarn workspace shookie build`: pass.
- 최신 SHA에서 `yarn workspace shookie test src/telemetry src/slack/delivery-metrics.test.ts src/slack/handlers.test.ts src/tools/code-explorer/github-read.test.ts src/tools/code-explorer/github-query-projection.test.ts`: pass, 181 tests / 7 files (6.81s).
- 최신 SHA에서 아래 cancellation/delivery partition도 재실행: pass, 138 tests / 12 files (21.16s).
- `telemetry/github-result.integration.test.ts`는 실제 최신 `readGithub`에 합성 HTTP 응답을 주입하여 최근 PR list/큰 Unicode detail의 `data:string` 결과를 기존 wrapper로 실행한다. own data JSON-string byte 측정이 정확하고 전체 envelope는 unknown이며, top-level truncated와 반환 객체 identity를 보존하고 본문/URL을 metrics에 담지 않는지 검증한다. live 측정이 아니다.

초기 구현 검증 SHA: `bba956fa35ae4d02cb9affa265af530126591009` (당시 base `f8665b4349e133e6f5066157aa2a68627aed38e2`). 문서 후속 커밋은 런타임 코드를 변경하지 않는다. 초기 검증 기록:

- `yarn workspace database build && yarn workspace shookie build`: pass. DB build는 TypeScript 산출물 생성만 하며 DB 접속/마이그레이션 실행이 아니다.
- `yarn workspace shookie test src/telemetry src/slack/delivery-metrics.test.ts src/slack/handlers.test.ts`: pass, 89 tests / 4 files (6.00s).
- `yarn workspace shookie test src/cancellation src/slack/live-answer.test.ts src/slack/live-answer-provider.test.ts src/slack/conversation-runtime.test.ts src/slack/final-delivery.test.ts src/logger.test.ts`: pass, 138 tests / 12 files (21.91s).
- fake trusted monotonic clocks + gated ACK로 delta/preview 확인/finish 분리, fallback start ACK 뒤 stop 실패/ACK loss/unsupported/throwing hook/no replay, greeting missing ACK, correlated single terminal·duplicate suppression·generation/save/delivery/cancel 독립 상태, 실제 pinned DeepSeek→Mastra offline wire의 step/aggregate/optional usage 보존을 검증했다.
- huge Unicode/JSON-string data/escaping/cap 경계/cycle/BigInt/class·array/Proxy·getter 무실행, tool async return/reject/RequestContext/drain/cancel/missing scope/중복 wrapper/throwing metrics/동기·비동기 sink 실패를 검증했다.
- 초기 regression 실행에서 새 detached timer가 fake timer 잔여 개수 검사에 잡혔고, native scheduler reference + unref로 수정 후 위 cancellation partition 전체를 재검증했다. 다른 owner의 테스트는 수정하지 않았다.
- 실제 Slack/DeepSeek 네트워크 E2E, 운영 배포/서버/DB 작업, 전체 repository test suite는 미실행. 실측 latency/비용 절감이나 응답 품질 개선 주장은 하지 않는다. A 선병합 후 최신 main 호환성은 위 검증으로 확인했으며 독립 리뷰/최종 병합 판단은 main 소유다.
