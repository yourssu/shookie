# 생성 중 Slack 답변 전달 / canonical completion

## 현재 계약

Mastra와 기존 단일 모델 run을 유지한다. 추가 synthesis 호출, marker prompt, 모델·도구·인가 변경은 없다. 기존 `deliverFinalAnswer`는 생성 중 스트리밍이 아닌 **완료 후 fallback 전송**이다. 현재 정상 경로는 생성 중 public delta를 동일 Slack 메시지에 실제 반영한다.

- 첫 루트 assistant `text-delta`는 즉시 `chat.postMessage`로 보낸다. 본문에 `생성 중 · 미확정 답변`, metadata에 `shookie_response_preview`를 포함한다. 이후 `chat.update`로 같은 서버 응답 ts만 갱신한다. 생성 종료까지 본문을 모아두는 방식이 아니다.
- public prose도 도구 실행 전 중간 안내일 수 있다. 완료라고 부르지 않는다. `step-start`에서 내부 누적기를 초기화하되 tool-only step 때문에 화면을 지우지 않는다. 다음 public text가 나오면 해당 step의 preview로 교체한다.
- `from === AGENT`, 명시적으로 지정한 main runId, 정확한 `text-delta.payload.text`만 허용한다. reasoning, tool args/results, raw, system, nested/wrapped agent 이벤트는 전송하지 않는다. 전문 에이전트의 `generate` 결과는 main의 tool-result에 들어가므로 직접 노출하지 않는다.
- **성공 저장 전에도 preview는 이미 보인다.** save-before-visible 보장은 최종 확정 본문에만 적용한다. 저장/전달/생성 성공을 분리한다.

## pinned provider / canonical source

설치된 DeepSeek adapter는 provider `delta.reasoning_content`를 `reasoning-*`, `delta.content`를 `text-*`로 분리한다. Mastra의 `convertFullStreamChunkToMastra`는 provider text delta를 `{type:'text-delta', from:'AGENT', runId, payload:{text}}`로 변환한다. 비슷한 모양의 reasoning payload를 answer로 간주하지 않는다.

실제 offline wire 회귀에서 Mastra `streamResult.text`는 **모든 step의 public text를 연결**한다. 도구 전 문구 + 최종 문구가 섞이므로 더 이상 이를 canonical 저장 source로 사용하지 않는다. `streamResult.steps`의 **마지막 완료된 루트 step**만 검사한다:

1. run `finishReason === 'stop'`
2. 마지막 step의 toolCalls가 없음
3. 마지막 step.text가 non-whitespace public text

이 조건에서만 exact step.text를 durable 저장한다. 마지막 tool-only/도구+텍스트/빈 step에서 이전 step을 끌어오거나 reasoning/전문 에이전트 텍스트로 대체하지 않는다. `length`/`steps`는 이전의 경고 후 성공 정책과 달리 생성 한도에 따른 미완료이며 저장·committed marker·markDelivered를 하지 않는다. unknown/error/abort도 fail closed한다. 기존 requester cancel/180초 timeout checkpoint가 우선한다. 한도 미완료는 별도 친화적 안내로 구분하며 자동 재시도하지 않는다. 과거 이미 저장된 aggregate turn은 변경하지 않는다.

## persist / finalize / 실패

preview 소비를 seal하고 타이머/대기 snapshot을 버린 뒤 **실제 in-flight mutation settlement**를 기다린다. 이 fencing/drain 이후에만 commit을 시작한다. 따라서 늦은 preview update가 canonical 본문을 덮어쓸 수 없다.

persist 성공 후 동일 `chat.update` 요청에 canonical renderer 본문·feedback 1개·`shookie_response_committed` metadata를 함께 보낸다. 기존 markdown→blocks renderer와 fallback text를 사용하므로 streamed body 아래 본문을 덧붙이지 않는다. final ACK와 warning 없음이 확인된 뒤만 markDelivered/control 삭제를 한다. control 삭제 실패는 known control의 bounded update만 허용하고 final 재전송 사유가 아니다.

- 생성/저장 실패 및 cancel: known preview를 독립 15초 cleanup scope에서 미완료로 표시하고 preview marker를 유지한다. 한도 종료는 '생성 한도에 도달해 중단된 미완성 답변'으로 표시한다. cancel/timeout control은 기존 전용 안내를 유지한다.
- preview transport cap/429/timeout/불확실 update는 **preview 갱신만 freeze**하며 생성·저장 실패나 최종 전달 포기를 의미하지 않는다. 정상 canonical answer를 저장하고 exact known ts + 실제 preview in-flight drain이 있으면, 같은 ts에 canonical 본문/feedback/committed marker를 **단 한 번 별도 최종 update**한다. 이는 실패한 preview mutation replay가 아니라 새 content/phase이며 새 post나 final 재시도는 하지 않는다. cap은 preview용이며 final에는 기존 renderer 제한을 적용한다.
- 명시적 HTTP 429 `Retry-After`는 pinned SDK의 구조화된 `slack_webapi_rate_limited_error.retryAfter`(초)로만 기록한다. finite/nonnegative 수만 허용하고 overflow는 안전한 최대값으로 포화시키며 여러 응답 중 최대 notBefore를 유지한다. 요청 소유 `SlackCooldown` capability를 preview/final/cleanup과 controls가 공유한다(전역/다른 요청 상태는 변경하지 않음). final의 독립 전체 15초 scope 안에서 허용 시각까지 abortable wait한 뒤 한 번 전송한다. 대기가 deadline 이상이면 타이머/네트워크 없이 빠르게 skip하고 '생성/저장 완료, 전달 미확인'으로 남긴다. final 자체의 새 429도 controls.finish 전에 반영된다. 생성/save 실패 preview cleanup 및 control status/update/delete/delete-fallback도 동일 guard를 따른다. 취소 즉시 알림보다 알려진 제한 준수가 우선한다. 긴 cooldown으로 control 문구/버튼이 남을 수 있지만 registry는 제거되어 클릭을 거절한다. 불가능한 순차 15초 대기는 하지 않는다.
- final update/Retry-After 대기 전 phase를 finalizing으로 바꾼다. ACK 손실 시 실제 committed 메시지가 보일 수 있으므로 이후 cleanup으로 preview/error를 덮어씌우지 않는다. durable 성공도 실패로 뒤집지 않는다. 저장 성공 이후의 render/finalization 실패·rate-limit deadline 초과는 **일반 미완성 생성 문구로 preview를 덮지 않는다**. 성공 저장만으로 Slack preview marker를 committed로 승격하지 않으며 control은 전달 미확인 안내를 유지한다. 오래된 preview가 남아도 기존 '생성 중 · 미확정' label 덕분에 canonical 완료 답변으로 취급하지 않는다.
- ambiguous post로 ts를 모르면 cleanup/repost하지 않는다. 생성 실패/저장 실패/전달 미확인/한도/cancel/timeout을 control에서 구분한다. 확인된 final 전에는 control을 삭제하지 않는다.
- preview creation을 시도하지 않았거나 구조화된 명시적 `unknown_method`/`method_not_supported`/`not_allowed_token_type`/`missing_scope` 거절로 메시지 미생성이 확인된 경우만 기존 final-only fallback을 허용한다. 나머지 불확실 전송은 no-replay다. native fallback의 append/stop도 불확실하면 재게시하지 않는다.

## bounded backpressure / transport

모델 소비는 Slack을 await하지 않는다. one-inflight + latest snapshot 1개이며 delta queue는 없다. 첫 public delta 즉시, 후속 갱신은 최소 1.5초 간격 coalescing(분당 약 40회)으로 rate-limit을 방어한다. 인위적 typing delay가 아니다. 실행 전체 최대 preview API 60회, final 1회와 cleanup 최대 1회다. step text에는 별도의 두 상한을 적용한다: Slack 문자 수에 보수적인 **24,000 UTF-16 code units**와 step text의 **64,000 UTF-8 bytes**다(미확정 안내 prefix와 요청 envelope에는 고정 크기 overhead가 추가된다). 다중바이트 한글은 code-unit 상한 이내여도 byte 상한에 먼저 걸릴 수 있다. 누적 문자열 전체를 UTF-8로 측정하므로 delta 경계의 surrogate pair를 잘못 이중 계산하지 않는다. cap이면 preview만 freeze하며 known ts의 별도 final update 가능성은 유지한다. 앱은 장기 참조로 text/대기/inflight의 최대 3개 bounded snapshot만 유지하며 전체 delta 이력이나 요청 queue를 쌓지 않는다. 갱신 중 임시 문자열도 같은 문자 상한 이내의 고정 개수뿐이다. 각 snapshot은 이중 상한 이내이고 SDK 요청도 one-inflight이므로 앱이 보유한 preview 데이터는 delta 개수와 무관하게 bounded다(프로세스 전체 heap의 정확한 byte cap을 주장하지 않으며 final renderer/model 결과 메모리는 별도다). surrogate pair가 delta 경계를 가로지르면 trailing high surrogate를 보류한다.

전용 WebClient를 사용하고 retry 0, 429 즉시 reject, HTTP timeout 최대 15초, execution signal을 실제 Axios transport에 전달한다. cancel 후 새 text를 보내지 않는다. 이미 in-flight인 HTTP의 서버 적용을 되돌린다는 보장은 없다. 실제 settlement/drain 전에 같은-thread runtime lane을 해제하지 않는다. cleanup/final delivery는 실행 ALS 밖 독립 전체 15초 scope다. 공유 client/서버/worker를 종료하지 않는다.

## Slack 계약과 history isolation

공식 [postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)와 [update](https://docs.slack.dev/reference/methods/chat.update/)는 metadata를 지원한다. update의 text+blocks/metadata를 같은 요청으로 교체한다. native stream은 필수가 아니다: [stopStream](https://docs.slack.dev/reference/methods/chat.stopStream/)의 blocks는 본문 아래 추가이며, update는 진행 중 native stream에 `streaming_state_conflict`를 반환한다. startStream에는 metadata가 문서화되지 않아 preview 이력 식별에 의존하지 않는다.

`conversations.replies` 모든 페이지에 `include_all_metadata:true`를 사용하고 completeness를 검사한 뒤 **검증된 own user ID 또는 user 없는 own bot ID + 정확한 preview/control marker**만 모델 history에서 제외한다. committed 메시지는 포함한다. 사람/다른 봇/ID 없는 spoof/metadata 없는 동일 문구는 삭제하지 않는다. metadata payload/관련 없는 metadata는 모델에 투영하지 않는다. DM durable history도 성공 canonical turn만 포함한다.

metadata는 custom schema manifest/Slack 운영 지원 영향을 받는다. API warning이 있으면 성공 확정하지 않는다. marker가 사라졌거나 경고 없이 무시되면 text 기반으로 대신 지우지 않으므로 재시작 후 incomplete history isolation을 보장할 수 없다. 실제 Slack metadata 보존·UI·feedback 렌더링은 **live 미검증**이며 추가 manifest/권한/운영 설정을 임의 변경하지 않았다. exactly-once 보장도 아니다.

## 검증

- `live-answer-provider.test.ts`: 실제 pinned DeepSeek/Mastra adapter + synthetic offline HTTP response. pre-tool→도구/전문 에이전트 generate→최종, 여러 tool-only step, reasoning 구분, aggregate와 마지막 step의 차이, 빈/도구+text/length 마지막 step.
- `handlers.test.ts`: gated async stream에서 모델 종료 전 첫 public text 도착; no-/single-/multi-tool, persist 후 exact canonical reconcile, feedback 1회, 실패/한도/unknown/error/abort 저장 금지.
- `live-answer.test.ts`: one-inflight slow transport, rate-limit/cap 이후 known ts final 성공, Retry-After 대기/deadline 초과, abort 전후/append 중 실제 drain, ambiguous post/update/final ACK, unsupported fallback, Unicode/markdown, 최종 overwrite fencing. `handlers.test.ts`도 UTF-8/call cap/preview ACK loss/429 이후 저장·최종 성공과 no-ts/final ACK loss/긴 Retry-After의 전달 미확인을 구분한다.
- `slack-thread-source.test.ts`: own preview 제외/committed 포함, participant/다른 bot/spoof/marker 누락 보존.
- `cancellation/slack-transport.test.ts`: 실제 localhost WebClient HTTP post/update wire, metadata와 known ts 확인, gated model 종료 전 도착. 실제 HTTP 429 Retry-After 뒤 known ts의 별도 final update 한 번, final 자체 429의 controls 공유/registry 제거/no-network skip도 검증한다. 기존 socket close/timeout/429/no-retry 회귀 유지.
- 실제 Slack 쓰기/실제 DeepSeek 호출/배포/DB 변경은 실행하지 않았다. mocks/localhost 검증을 live E2E로 주장하지 않는다.
