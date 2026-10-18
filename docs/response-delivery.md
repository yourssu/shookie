# P0 응답 UX / 최종 전달

## 현재 범위

Mastra, 모델/provider 설정, main prompt, 서비스 도구 등록/위임, Radar guidance 소비는 base 동작을 유지한다. 이 PR은 응답 UI와 안전한 전달·오류/취소 회귀만 변경한다. 직접 도구/선택적 전문 조사·간결성 지침/Radar 지침 소비 중단(2단계), 로컬 지침 loader/캐시/후속 맥락(3단계)은 이 PR에서 달성하지 않는다.

- 생성 중에는 요청별 짧은 상태/취소 제어만 표시한다. plan/raw 도구 인자·결과, 추론, 도구 전 텍스트는 보내지 않는다.
- 정상 최종 답변에서 도구/토큰/비용 debug footer를 제거한다. 별도 모델 재작성은 없다.
- 최종 답변을 성공 저장한 뒤에만 전달한다. 저장 성공과 delivered 성공은 별개이며 전달 실패가 저장된 성공을 실패로 뒤집지 않는다.
- 최종 전송 성공을 확인한 뒤 해당 요청의 control을 삭제한다. 삭제 실패는 답변 재전송 사유가 아니다. 전달 미확인은 control에 명시하고 버튼은 registry에서 비활성화한다. 취소/실패 안내는 보존한다.
- control post에 `shookie_request_control` metadata를 부여한다. 자동 Slack source reader는 전체 원문 completeness 검증 후, 검증된 슈키 작성자(user ID 또는 user 없는 메시지의 bot ID)와 정확한 metadata가 모두 일치하는 control만 모델 이력에서 제외한다. 사람/다른 봇의 동일 문구·metadata와 슈키의 metadata 없는 일반 발화는 보존한다. 텍스트 문구만으로 제거하지 않는다.

## Buffered final-only 전달 계약

이 구현은 **생성 완료 후 청크 전달**이며 **생성 중 실시간 토큰 스트리밍이 아니다**. 실제 생성 스트리밍은 미완료/후속이다. 도구 전 텍스트를 최종 답변으로 안전하게 구분할 수 없는 상태에서 노출하지 않는다. sleep/타이핑 지연이나 별도 모델 출력 재작성은 없다.

최종 markdown은 최대 2개, 각 12,000 code points 이하로 `chat.startStream`/선택적 `chat.appendStream`/`chat.stopStream`에 전달한다. 진입 길이 검사는 UTF-16 기준 24,000자로 더 보수적이다. 정상 2~3 API 호출, 알려진 stream 실패 정리까지 최대 4회다. team 누락/긴 답변은 기존 Markdown→blocks renderer로 한 번 전송한다.

공식 https://docs.slack.dev/reference/methods/chat.stopStream/ 계약은 stop의 `blocks`를 streamed markdown **아래에 추가**한다. 따라서 stop에는 feedback `context_actions`만 붙이고 본문 blocks는 다시 보내지 않는다. incremental markdown/코드펜스는 Slack native renderer가 완성한다. 기존 final blocks fallback도 feedback을 유지하고 빈 debug context block을 만들지 않는다. 실제 Slack UI 렌더링은 미검증이다.

Fallback은 start의 명시적 `unknown_method`/`method_not_supported`/`not_allowed_token_type`/`missing_scope` 거절에만 허용한다. SDK 예외는 구조화된 platform error code만 검사한다. transport timeout/끊김/internal_error/append/stop 실패는 재게시하지 않는다. 알려진 session은 본문 없이 best-effort stop만 한다. exactly-once 보장이 아니며 부분 전달/미전달 또는 정리되지 않은 stream이 남을 수 있다.

기존 인증 RequestContext, 실행 180초 취소/timeout, committing 중 취소 거절, 독립 전체 15초 delivery scope, retry 0을 유지한다. 생성 중 요청자 취소와 실패/저장/전달 상태는 기존 execution/runtime 경계를 따른다.

## 검증과 한계

`final-delivery.test.ts`는 mock transport로 청크 수/Unicode/markdown 연결/feedback 비중복, 명시적 거절 fallback, 불확실 전송 no-replay, append/stop 실패, 청크 사이 취소를 검사한다. `handlers.test.ts`, `slack-lifecycle.test.ts`, `slack-thread-source.test.ts`는 저장 후 전달, control 삭제 시점, 오류/취소/timeout, control 이력 필터를 검사한다. 실제 Slack/DeepSeek 인증 E2E와 native markdown/feedback UI는 미실행이다. 서버/DB/배포 작업은 하지 않았다.

축소 후 새 검증:
- database/shookie TypeScript build 통과.
- `yarn workspace shookie test src/slack/handlers.test.ts src/slack/final-delivery.test.ts src/slack/markdown-to-blocks.test.ts src/slack/slack-thread-source.test.ts src/slack/github-context.integration.test.ts src/slack/conversation-runtime.test.ts src/slack/thread-summarizer.test.ts src/cancellation src/agent --maxWorkers=2 --minWorkers=1 --reporter=dot`: 25 files / 339 tests 통과.
- `yarn workspace shookie test src/tools/code-explorer/registry.test.ts src/tools/code-explorer/github-read.test.ts src/tools/posthog/registry.test.ts src/tools/posthog/client.test.ts --maxWorkers=2 --minWorkers=1 --reporter=dot`: 4 files / 173 tests 통과. Radar guidance 소비/인가가 base 계약으로 복원되었음을 원래 테스트로 확인했다.
- base `6a12031093af970582deefa1970fb6c449db3ec9`와 비교해 agent production 코드/main prompt/등록, tools 전체, execution-context.ts, AGENTS/README/manifest/lock diff 없음을 확인했다. agent의 유일한 잔여 변경은 이미지 tool progress 미전송 테스트다.
- 이전 전체 범위 검증의 git snapshot 간헐 clone 실패와 deploy-script command 60초 timeout은 새 P0 검증 통과로 간주하지 않는다. 해당 운영 코드 변경은 없으며 이번 축소 후 전체 deploy-script/live 환경은 재실행하지 않았다.

## 분리 이력 / 후속 main 인계

원래 구현의 네 커밋은 삭제/reset/stash/force push 없이 이력에 보존하고 inverse commit으로 이 PR 최종 diff를 P0만 남겼다. 이전 전체 범위 리뷰/테스트를 새 P0 HEAD의 merge 근거로 사용하지 않는다.

- `4db55002b0f36852d47dfc18b625b34dd68bc033`: 2단계 Radar instruction 소비 중단 adapter/테스트. 현 PR에서는 역변경했다.
- `38ddcc171baa9a9e73b9ab8abc63121d92178ef7`: 2·3단계 혼재. `agent/index.ts`, `agents/main-shookie/{index,tools,instructions}.ts`, code-explorer/posthog의 index/instructions/description, 등록/위임/DeepSeek 테스트에 직접 도구·선택적 조사와 stable prompt가 함께 있다. `agent/domain-guidance.ts`/test, `cancellation/execution-context.ts`의 중복 wrapping 방지, 관련 등록 테스트는 loader/공유 인스턴스 의존성이 있다. 현 PR에서는 역변경했다.
- `cbeee5a9c3e005160ce62289b5b01a0c52b70e17`: P0 UI/전달과 함께 `slack/handlers.ts`의 trailing 시각, `handlers.test.ts`의 후속 대상/기간/ref 테스트가 혼재했다. 그 P1 부분만 추가 역변경했다. control metadata/이력 필터는 P0 안전 경계로 남겼고 텍스트 일치 fallback은 제거했다. `agent/image-registration.test.ts`의 progress 미전송 기대값은 P0 회귀로 유지한다.
- `46043944515aabe00585f8ed8b5067a2fd4d025b`: 전체 범위 문서였으며 역변경하고 이 P0 문서로 대체했다.

후속 task는 main이 1단계 merge+cleanup 뒤 별도 순차 실행한다. squash 이후 원본 커밋을 blanket cherry-pick하지 말고 단계별 필요한 diff와 공유 파일 의존성만 검토·재적용해야 한다. 현재 task는 새 branch/worktree/task를 만들지 않는다.
