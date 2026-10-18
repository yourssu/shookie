# P1 2단계: 직접 도구와 Radar 지침 소비 중단

기준 main: `644fc2e4d98705c7262e9b8baba8c40bea6d7076` (1단계 merge 및 cleanup 완료).
Mastra 및 기존 모델/provider 설정을 유지한다. 역사 커밋 `4db5500`의 adapter 차단과 `38ddcc1`의 직접 도구/선택적 조사 부분만 diff를 검토해 재사용했다. blanket cherry-pick/reset은 하지 않았다.

## 구현 범위

- 실제 메인 등록에 기존 GitHub/PostHog 서비스 도구를 직접 추가했다. 단순 목록/조회에 필수 위임은 없다. 동일한 설정 gate, live Radar 등록/allowlist, GitHub 인증 RequestContext, snapshot 소유권 검사와 취소 경계를 사용한다.
- 도구 인스턴스는 선택적 specialist와 공유한다. wrapper는 WeakSet으로 한 번만 적용한다. request identity와 실행 상태는 tool 인스턴스에 저장하지 않고 호출별 RequestContext/AsyncLocalStorage로 전달한다. 기존 client/continuation/snapshot 구현과 권한 범위를 재설계하지 않았다.
- specialist는 깊고 맥락이 큰 조사에만 선택적으로 사용한다. 입력은 명시적 `task`, `target`, 관련 `context`, `outputScope`. 출력은 `status`(success/partial/error), `result`, 실제 도구 결과에서 제한적으로 투영한 `evidence`(tool/source/status/excerpt/truncated), `limitations`와 전체 `truncated`다. JSON 보고서가 유효하지 않거나 도구 실패/부분/잘림 또는 step 종료가 있으면 성공으로 승격하지 않는다. 예외는 sanitized error, 요청 취소는 실행 경계에서 계속 거절한다. DB invocation 스키마는 바꾸지 않아 partial은 기존 success 저장 상태와 별개로 도구 결과 status에 표시된다.
- 위임 출력은 전체 serialized UTF-8 JSON 16,384 bytes 이하로 제한한다. 근거 최대 8개/개별 1400 bytes/합계 9000 bytes, excerpt 512 bytes, 보고서 result 4096 bytes, limitations 최대 7개/개별 256 bytes(모델 한계 최대 4개 + 고정 안내 최대 3개)다. 예산은 JSON escaping을 포함하며 Unicode code point를 나누지 않는다. source는 실제 도구 결과의 allowlist 식별 필드만 복사하고, 긴 ref/path/URL은 잘라 새 출처를 만들지 않고 생략한다. 중첩 raw result는 반환하지 않는다. 내용·근거 생략은 partial/truncated와 관련 한계로 알린다. invalid report fallback도 같은 본문 예산을 따른다. catch는 고정 sanitized warning만 남기며 scope 취소는 error 결과로 흡수하지 않고 reject한다.
- 메인이 최종 답변을 소유한다. 단순 목록은 짧게, 깊은 분석은 충분한 근거와 결론에 관련된 한계만 전달한다.
- Radar fetch를 끄지 않는다. 기존 schema/식별자/보안 검증 후 지침을 빈 문자열로 버리고 모델 projection에서 다시 차단한다. PostHog의 자유 텍스트 설명 preview도 비활성화했다. 목록, 개별 조회, clone, 기존 snapshot list/read/search, 메인/전문가 경로에 동일하게 적용된다. 식별 이름/ID/시각 및 policy metadata는 유지한다. 기존 호환 schema의 instructions/preview 필드는 빈 문자열, truncated는 false다.
- Radar 지침 조회/업데이트/저장/다음 조회 반영을 약속하는 workflow는 제거했다. Radar 코드/데이터는 변경하지 않았다.

현재 3단계 로컬 지침·고정 prefix·후속 맥락은 [phase3-stable-context.md](phase3-stable-context.md)를 참고한다. 아래는 2단계 merge 당시 제외 범위다.

## 제외 및 유지

3단계 로컬 지침 loader, stable prefix/시각 이동·캐시, 새 후속 memory/state 시스템은 없다. 기존 KST 시각 생성/상대 날짜 처리, Slack authoritative context, 병합된 P0 저장 후 전달·control·취소 동작을 유지했다. 기존 안전 운영에 필요한 서비스 규칙만 trusted code prompt에 둔다. GitHub 쓰기/쉘 권한은 추가하지 않았다. PostHog HogQL의 읽기 전용은 도구가 강제하지 않는 기존 한계를 명시하며 새 쓰기 기능을 추가하지 않았다. UI/배포/서버/DB 운영 변경은 없다.

## 검증 및 한계

모든 명령은 60초 이내로 분할했다. 최종 tested SHA는 PR 제출 기록을 따른다.

- `yarn workspace database build`, `yarn workspace shookie build`: 통과. 첫 shookie 단독 build는 로컬 database 산출물 부재로 실패했으며 database build 후 해결했다.
- `yarn workspace shookie test src/agent src/cancellation --maxWorkers=2 --minWorkers=1 --reporter=dot`: 실제 factory 등록, scripted DeepSeek generate/stream 직접/선택적 위임 루프 및 provider reasoning 호환성, shared wrapper 비중복·동시 identity/취소 격리, structured success/partial/error, 대형 다단계/Unicode/출처 보존/invalid report의 고정 출력 예산, sanitized warning, 전문 조사 내부 scope 취소 및 직접 transport 취소를 검증한다. prompt 문자열 검사는 정책 계약이지 live 모델 routing 증거가 아니다.
- `yarn workspace shookie test src/tools/code-explorer/registry.test.ts src/tools/code-explorer/github-read.test.ts src/tools/code-explorer/repository-snapshots.test.ts src/tools/posthog/registry.test.ts src/tools/posthog/client.test.ts --maxWorkers=2 --minWorkers=1 --reporter=dot`: 5 files / 188 tests 통과. 지침 sentinel 비전파, schema/security fail-closed, 등록 삭제 후 기존 snapshot/continuation 거부 포함. clone은 로컬 synthetic Git fixture이며 live GitHub가 아니다.
- `yarn workspace shookie test src/slack/handlers.test.ts src/slack/final-delivery.test.ts src/slack/slack-thread-source.test.ts src/slack/github-context.integration.test.ts src/slack/conversation-runtime.test.ts src/slack/thread-summarizer.test.ts --maxWorkers=2 --minWorkers=1 --reporter=dot`: 6 files / 94 tests 통과. 기존 P0 전달/control·Slack context 회귀를 mock transport로 확인한다.

추가 반복에서 agent/cancellation 묶음은 230/230 통과했다. 그 직전 한 번은 combined fixture의 초기 clone이 snapshotId를 만들지 못해 229/230이었다. 같은 SHA에서 해당 파일 단독 10/10 및 전체 230/230 재실행은 통과했다. 1단계 인계에 기록된 controlled clone 간헐 실패와 유사한 증상이지만 원인 동일성을 입증하지 않았다. 보안 assertion 완화나 무관한 clone 수정은 하지 않았다.

실제 DeepSeek routing/답변 품질, 실제 Slack UI/metadata 보존/전달, live Radar/GitHub/PostHog E2E, 배포는 미검증이다. synthetic 모델 스크립트는 도구 가용성과 runtime loop를 검증할 뿐 실제 모델의 선택 빈도나 운영 품질을 입증하지 않는다. main merge 전 독립 리뷰가 필요하다.
