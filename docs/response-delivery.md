# P0 응답 UX / 최종 전달

## 현재 범위

Mastra, 모델/provider 설정, main prompt, 서비스 도구 등록/위임, Radar guidance 소비는 base 동작을 유지한다. 이 PR은 응답 UI와 안전한 전달·오류/취소 회귀만 변경한다. 직접 도구/선택적 전문 조사·간결성 지침/Radar 지침 소비 중단(2단계), 로컬 지침 loader/캐시/후속 맥락(3단계)은 이 PR에서 달성하지 않는다.

- 생성 중에는 요청별 짧은 상태/취소 제어만 표시한다. plan/raw 도구 인자·결과, 추론, 도구 전 텍스트는 보내지 않는다.
- 정상 최종 답변에서 도구/토큰/비용 debug footer를 제거한다. 별도 모델 재작성은 없다.
- 최종 답변을 성공 저장한 뒤에만 전달한다. 저장 성공과 delivered 성공은 별개이며 전달 실패가 저장된 성공을 실패로 뒤집지 않는다.
- 최종 전송 성공을 확인한 뒤 해당 요청의 control을 삭제한다. 삭제 실패는 답변 재전송 사유가 아니다. 실패 시 이미 알고 있는 해당 control의 channel/ts에만 별도 15초 bounded scope로 update를 한 번 시도해 버튼을 없애고 '요청 처리를 마쳤어요.'로 바꾼다. ambiguous delete가 실제로 성공했다면 update의 message_not_found도 허용하며 새 post/재시도 루프는 없다. 전달 미확인은 '답변 전달 상태를 확인하지 못했어요. 일부 또는 전체가 표시되었을 수 있으며 자동 재전송하지 않습니다.'로 안내하고 버튼은 registry에서 비활성화한다. 취소/실패 안내는 보존한다.
- control post에 `shookie_request_control` metadata를 부여한다. 자동 Slack source reader는 전체 원문 completeness 검증 후, 검증된 슈키 작성자(user ID 또는 user 없는 메시지의 bot ID)와 정확한 metadata가 모두 일치하는 control만 모델 이력에서 제외한다. 사람/다른 봇의 동일 문구·metadata와 슈키의 metadata 없는 일반 발화는 보존한다. 텍스트 문구만으로 제거하지 않는다. metadata 없는 legacy control은 이 방식으로 식별할 수 없으므로 보존한다. 작성자 ID가 없는 메시지의 spoofed marker도 제거하거나 assistant로 승격하지 않는다.

### Replies metadata 계약 확인

`readSlackThread`는 **모든** `conversations.replies` 페이지에 `include_all_metadata: true`를 지정한다. 공식 [replies API](https://docs.slack.dev/reference/methods/conversations.replies/)는 이 값을 'Return all metadata associated with this message'로 정의한다. 설치된 `@slack/web-api` 7.15.2의 `dist/types/request/conversations.d.ts`도 `ConversationsRepliesArguments extends IncludeAllMetadata`와 `include_all_metadata?: boolean`(기본 false)을 제공한다. [metadata 가이드](https://docs.slack.dev/messaging/message-metadata/)의 Web API 예시는 true일 때 `event_type`과 `event_payload`를 함께 반환한다. 즉 event_type만 켜는 옵션이 아니라 payload까지 포함하는 전체 metadata 요청이다. false일 때 marker가 반드시 반환된다고 가정하지 않는다.

필터에는 정확한 event_type만 투영하고 event_payload·다른 event_type·기타 metadata는 모델 이력으로 전달하지 않는다. 플래그는 기존 메시지에 없는 metadata를 만들거나 해당 marker의 존재를 보장하지 않는다. 가이드에는 custom schema의 app manifest 등록 및 invalid metadata가 warning과 함께 무시될 수 있다는 운영 전제가 있다. 이 PR은 앱 설정/manifest를 변경하거나 등록 작업을 하지 않았고 live metadata 보존 여부도 미검증이다. marker가 없거나 무시된 legacy/운영 메시지는 text 기반으로 대신 지우지 않는다.

## Buffered final-only 전달 계약

이 구현은 **생성 완료 후 청크 전달**이며 **생성 중 실시간 토큰 스트리밍이 아니다**. 실제 생성 스트리밍은 미완료/후속이다. 도구 전 텍스트를 최종 답변으로 안전하게 구분할 수 없는 상태에서 노출하지 않는다. sleep/타이핑 지연이나 별도 모델 출력 재작성은 없다.

최종 markdown은 최대 2개, 각 12,000 code points 이하로 `chat.startStream`/선택적 `chat.appendStream`/`chat.stopStream`에 전달한다. 진입 길이 검사는 UTF-16 기준 24,000자로 더 보수적이다. 정상 2~3 API 호출, 알려진 stream 실패 정리까지 최대 4회다. team 누락/긴 답변은 기존 Markdown→blocks renderer로 한 번 전송한다.

공식 https://docs.slack.dev/reference/methods/chat.stopStream/ 계약은 stop의 `blocks`를 streamed markdown **아래에 추가**한다. 따라서 stop에는 feedback `context_actions`만 붙이고 본문 blocks는 다시 보내지 않는다. incremental markdown/코드펜스는 Slack native renderer가 완성한다. 기존 final blocks fallback도 feedback을 유지하고 빈 debug context block을 만들지 않는다. 실제 Slack UI 렌더링은 미검증이다.

Fallback은 start의 명시적 `unknown_method`/`method_not_supported`/`not_allowed_token_type`/`missing_scope` 거절에만 허용한다. SDK 예외는 구조화된 platform error code만 검사한다. transport timeout/끊김/internal_error/append/stop 실패는 재게시하지 않는다. 알려진 session은 본문 없이 best-effort stop만 한다. exactly-once 보장이 아니며 부분 전달/미전달 또는 정리되지 않은 stream이 남을 수 있다. 특히 start 성공 뒤 append/stop 실패는 첫 청크나 본문 전체가 이미 보였을 수 있지만 최종 완료/feedback은 확인되지 않은 상태다. 이때 두 번째 final post를 만들거나 성공 control을 삭제하지 않는다.

기존 인증 RequestContext, 실행 180초 취소/timeout, committing 중 취소 거절, 독립 전체 15초 delivery scope, retry 0을 유지한다. 생성 중 요청자 취소와 실패/저장/전달 상태는 기존 execution/runtime 경계를 따른다.

## 검증과 한계

`final-delivery.test.ts`는 mock transport로 청크 수/Unicode/markdown 연결/feedback 비중복, 명시적 거절 fallback, 불확실 전송 no-replay, append/stop 실패, 청크 사이 취소를 검사한다. `handlers.test.ts`, `slack-lifecycle.test.ts`, `slack-thread-source.test.ts`는 저장 후 전달, control 삭제 시점, 오류/취소/timeout, control 이력 필터를 검사한다. 실제 Slack/DeepSeek 인증 E2E와 native markdown/feedback UI는 미실행이다. 서버/DB/배포 작업은 하지 않았다.

축소 후 새 검증:
- database/shookie TypeScript build 통과.
- `yarn workspace shookie test src/slack/handlers.test.ts src/slack/final-delivery.test.ts src/slack/markdown-to-blocks.test.ts src/slack/slack-thread-source.test.ts src/slack/github-context.integration.test.ts src/slack/conversation-runtime.test.ts src/slack/thread-summarizer.test.ts src/cancellation src/agent --maxWorkers=2 --minWorkers=1 --reporter=dot`: 25 files / 346 tests 통과. start 성공 후 append 실패/stop 실패 각각 handler 통합에서 final post 재생성 없음, 성공 control 삭제 없음, 전달 미확인 안내를 확인한다.
- `yarn workspace shookie test src/tools/code-explorer/registry.test.ts src/tools/code-explorer/github-read.test.ts src/tools/posthog/registry.test.ts src/tools/posthog/client.test.ts --maxWorkers=2 --minWorkers=1 --reporter=dot`: 4 files / 173 tests 통과. Radar guidance 소비/인가가 base 계약으로 복원되었음을 원래 테스트로 확인했다.
- base `6a12031093af970582deefa1970fb6c449db3ec9`와 비교해 agent production 코드/main prompt/등록, tools 전체, execution-context.ts, AGENTS/README/manifest/lock diff 없음을 확인했다. agent의 유일한 잔여 변경은 이미지 tool progress 미전송 테스트다.
- 배포/snapshot은 아래 결과를 추가 검증 당시(`f826218`에 포함된 기록)의 증거로 보존한다. 이후 runtime 수정은 metadata 읽기와 control cleanup에 한정되며 배포/snapshot 소스는 바뀌지 않았다. 이번 재리뷰 수정 후 해당 두 묶음은 재실행하지 않았다.
- 이전 deploy-script command 60초 timeout은 regression 증거로 단정하지 않았다. 배포 scripts/tests에 base 대비 diff 없음을 확인하고 `yarn workspace shookie test src/deployment/deploy-script.test.ts -t 'image retention' --maxWorkers=1 --minWorkers=1 --reporter=dot` (10/36 통과, 15.31초), `-t '^(?!.*image retention).*'` (나머지 26/36 통과, 34.37초)로 분할하여 전체 36개를 완료했다. 선택 제외 skip은 두 분할의 합집합으로 모두 커버된다. 실제 배포는 아니다.
- snapshot fixture 추가 단독 반복: 첫 실행 14 pass/1 fail (`awaits refreshed async credentials...` 첫 clone의 `controlled clone failed`), 다음 실행 15/15 pass로 간헐 재현했다. code-explorer 소스·fixture/테스트 전체, execution-context/config/logger, manifest/lock/tsconfig가 base와 동일함을 diff 검사로 확인했다. 즉 base와 동일한 snapshot 코드/의존성에서도 발생하는 증거이나 별도 base checkout 실행과 동일하다고 주장하지 않는다. sanitized clone 경계가 원인을 숨기므로 subprocess/monitor/timeout 중 근본 원인은 미확정이다. 무관한 broad fix나 보안 assertion 완화는 하지 않았다. 실제 Slack start/append/stop 및 feedback UI 렌더링은 여전히 미실행이다.

## 분리 이력 / 후속 main 인계

원래 구현의 네 커밋은 삭제/reset/stash/force push 없이 이력에 보존하고 inverse commit으로 이 PR 최종 diff를 P0만 남겼다. 이전 전체 범위 리뷰/테스트를 새 P0 HEAD의 merge 근거로 사용하지 않는다.

- `4db55002b0f36852d47dfc18b625b34dd68bc033`: 2단계 Radar instruction 소비 중단 adapter/테스트. 현 PR에서는 역변경했다.
- `38ddcc171baa9a9e73b9ab8abc63121d92178ef7`: 2·3단계 혼재. `agent/index.ts`, `agents/main-shookie/{index,tools,instructions}.ts`, code-explorer/posthog의 index/instructions/description, 등록/위임/DeepSeek 테스트에 직접 도구·선택적 조사와 stable prompt가 함께 있다. `agent/domain-guidance.ts`/test, `cancellation/execution-context.ts`의 중복 wrapping 방지, 관련 등록 테스트는 loader/공유 인스턴스 의존성이 있다. 현 PR에서는 역변경했다.
- `cbeee5a9c3e005160ce62289b5b01a0c52b70e17`: P0 UI/전달과 함께 `slack/handlers.ts`의 trailing 시각, `handlers.test.ts`의 후속 대상/기간/ref 테스트가 혼재했다. 그 P1 부분만 추가 역변경했다. control metadata/이력 필터는 P0 안전 경계로 남겼고 텍스트 일치 fallback은 제거했다. `agent/image-registration.test.ts`의 progress 미전송 기대값은 P0 회귀로 유지한다.
- `46043944515aabe00585f8ed8b5067a2fd4d025b`: 전체 범위 문서였으며 역변경하고 이 P0 문서로 대체했다.

후속 task는 main이 1단계 merge+cleanup 뒤 별도 순차 실행한다. squash 이후 원본 커밋을 blanket cherry-pick하지 말고 단계별 필요한 diff와 공유 파일 의존성만 검토·재적용해야 한다. 현재 task는 새 branch/worktree/task를 만들지 않는다.
