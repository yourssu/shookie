# DeepSeek Flash 추론 이력 호환성

## 최종 선택 (오프라인 검증)

- **`@ai-sdk/deepseek: 2.0.76`**, **`@mastra/core: 1.49.0`** 정확 버전 고정.
- DeepSeek 같은 2.x/provider v3 계약 유지. Mastra는 처음 계획한 1.32.x 유지가 추가 회귀에서 실패하여, main 승인 후 공식 수정이 포함된 최소 확인 버전 1.49.0으로 확대했다. 최신 1.78로 올리지 않는다.
- `deepseek-flash`, API 엔드포인트, thinking 기본값, 위임 `generate()` 사용은 불변. 수동 빈 추론 주입, 이력 재작성, 400 재시도, thinking 비활성화, dependency monkeypatch는 없다.
- Mastra 1.32.1도 이미 Node >=22.13.0을 요구했는데 Docker는 Node 20이었다. **기존 runtime 불일치**를 `node:22-slim` + build 시 최소 버전 검사 및 package engines >=22.13.0으로 정렬했다. 이미지 빌드/ARM64/기존 bot 교체 파이프라인은 유지한다. 호스트·서버 Node를 변경하지 않는다.

## 명시적 high 요청 정책

기존에 문서화된 서버 기본 high에 암묵적으로 의존하는 대신 `src/llm/policy.ts`의 공통 상수로 high를 명시한다. 모델·엔드포인트·서버 thinking 기본값·토큰/시간 예산은 바꾸지 않는다. 품질 향상이나 지연 개선을 입증한 변경은 아니다.

- Mastra 1.49.0의 `Agent.defaultOptions.providerOptions.deepseek.reasoningEffort`를 사용한다(`modelSettings`가 아님). 실제 generate/stream은 실행 옵션과 defaults를 병합하며 모든 loop turn으로 전달한다. 선택적 Code Explorer/PostHog도 같은 defaults를 사용한다.
- AI SDK 요약은 `providerOptions.deepseek.reasoningEffort`, 기존 직접 이미지 HTTP 요청은 `reasoning_effort`로 같은 high 상수를 전달한다. 이미지 지원 범위나 payload/예산 정책은 그대로다.
- 고정 SDK 2.0.76의 docs/types/serializer와 mock HTTP wire를 검증했다. `deepseek-direct-tools.test.ts`는 실제 팩토리 main 첫 요청·GitHub/PostHog 직접 도구 후속 요청에서 `reasoning_effort: high`와 기존 추론 이력을 검사한다. specialist 런타임은 제거되었다. `thread-summarizer-wire.test.ts`, 이미지 transport 테스트도 실제 직렬화 body를 검사한다. live 서버 적용/답변 품질/지연은 미검증이다.
- 공통 답변 규칙은 불필요한 내부 입력 형식/선택 제약 안내만 줄인다. 필요한 확인·정정·해석과 접근 거부/부분·잘림/불확실성/실패 고지는 유지하고, 등록 프로젝트 이름 선택·권한·Radar 비활성화 규칙은 바꾸지 않는다. prompt 계약 테스트는 실제 답변의 간결함을 입증하지 않는다.

## 장애 증거와 주장 범위

2026-10-18 09:17Z 저장소 목록 질문에서 Code Explorer 위임 두 번이 upstream 400 `reasoning_content in thinking mode must be passed back`으로 실패했다. 당시 SDK 2.0.35/Mastra 1.32.1, registry 200/등록 저장소 3개가 별도 확인됐다. 실패 upstream 응답/다음 요청 원문은 보존하지 않았으므로 정확히 어떤 응답 형태가 해당 장애를 일으켰는지는 입증하지 않았다.

이번 수정은 같은 오류를 유발할 수 있는 **확인된 두 계층의 호환성 결함**을 다룬다. fake transport 통과는 live 성공 증거가 아니다. 일반적인 nonempty 2-step generate/stream은 구버전에서도 통과하므로 Mastra가 모든 추론을 버린다고 주장하지 않는다.

## 1. DeepSeek SDK

2.0.35의 `modelId.includes('deepseek-v4')` 조건은 `deepseek-flash` 별칭에서 이전 user 턴 앞 assistant 추론 보존 및 필수 빈 추론 필드 처리를 놓친다. 빈 `tool_calls: []`도 추론 구간을 끊는다.

공식 v6 backport (두 수정 모두 2.0.64):

- [1b70db6](https://github.com/vercel/ai/commit/1b70db6fa8b7b1dc130aa305514ef0aa8a02407b): 별칭 호환성.
- [4bd2599](https://github.com/vercel/ai/commit/4bd2599b8c8111a546e923cddb6ab99bab550692): 빈 tool_calls 배열의 추론 lifecycle.

2.0.72 forward-compatible 기본값까지 포함하는 2.0.76을 선택했다. 직접 provider JSON/SSE 회귀는 이전 턴 추론, 필수 빈 필드, A/B deltas의 단일 연속 구간을 검사한다. 빈 필드는 provider 자체 동작을 검사할 뿐 앱에서 주입하지 않는다.

## 2. Mastra 동일 길이 추론의 merge 충돌

SDK만 올린 실제 팩토리 7요청 테스트에서 발견했다:

1. main → Code Explorer → `github_read(repositories)` → sub 답변.
2. main → PostHog → `listProjects` → sub 답변 → main 최종 답변.
3. 두 번째 main tool-call 응답의 고유 합성 `synthetic-reasoning-3`는 provider 반환에 존재하지만, 다음 main provider 입력에는 첫 `synthetic-reasoning-0`만 남는다. SDK는 누락된 tool-call 추론을 `''`로 직렬화한다. 이것만으로 원문 보존 해결이라고 수용할 수 없다.

정확한 1.32.1 경로:

- `buildMessagesFromChunks()`가 nonredacted reasoning을 `reasoning: ''`, `details[0].text: 실제텍스트`로 구성.
- `CacheKeyGenerator.fromAIV4Part()`가 top-level reasoning과 details **길이 합**으로 키를 구성. 다른 텍스트라도 길이가 같으면 충돌.
- `MessageMerger.pushNewPart()`의 `latestPartCount < newPartCount` 조건이 거짓이 되어 두 번째 reasoning part 탈락.

고유 response IDs/서로 다른 tool-call IDs/고유 marker를 사용해도 재현한다. marker 길이만 다르게 하면 통과한다. nested/shared model 상태는 필요조건이 아니다: 단일 Agent + lookup 두 번의 3-step에서도 재현했다. reasoning span ID 재사용 자체가 원인이라는 근거는 없다.

공식 [Mastra PR #18534](https://github.com/mastra-ai/mastra/pull/18534), [b8375c1](https://github.com/mastra-ai/mastra/commit/b8375c1f8fe905df8ae2ae9a893bb365f17aec4e)는 AIV4Adapter와 stream assembler의 top-level reasoning에 실제 텍스트를 유지한다. 이로써 위 merge 키에 내용이 반영된다.

격리 `/tmp` 패키지 비교 (프로젝트 의존성/운영 데이터와 분리, synthetic JSON/SSE):

| Mastra | 단일 Agent 3-step generate/stream 두 번째 추론 |
| --- | --- |
| 1.32.1, 1.33.0, 1.40.0, 1.45.0, 1.48.0 | 누락, 다음 wire는 빈 필드 |
| 1.49.0, 1.50.0, 1.78.0 | 원문 marker 보존 |

1.48→1.49 공식 compare에 #18534가 포함된다. 1.49.0이 최소 확인 수정 릴리스다. Yarn patch/backport 대신 공식 릴리스를 선택했다.

## lock/API/runtime 영향

DeepSeek 필수 provider 3.0.19/provider-utils 4.0.61/undici 추가 외에 승인된 Mastra 변경으로 내부 AI SDK v5/v6 provider 유틸 갱신, v7 adapter/provider-utils 5.0.0/provider 4.0.0/serde, schema-compat 1.3.3, chat/catalog, posthog-node/core/types, jpeg-js/fastq/reusify 및 ws가 변경된다. 기존 고정 해상도는 가능한 유지하며 전체 dedupe/다른 direct dependency 갱신은 하지 않았다. 내부 v7 지원 추가는 앱의 DeepSeek provider v3 모델 선택 변경이 아니다. 사용하지 않게 된 hono-openapi/js-tiktoken/radash/base64-js는 제거된다.

운영 코드 호환 조정은 memory `Message` 선언을 같은 role/content shape의 user|assistant discriminated union으로 바꾸는 **타입만의 변경**이다. 이력 내용/순서/직렬화를 변경하지 않는다. 직접 도구를 호출하는 테스트 3파일은 공식 `noopObserve` context와 void/error narrowing을 사용한다. auth/loop/abort 정책은 수정하지 않는다.

SDK 2.0.76은 image file→image_url 직렬화도 지원하므로 기존 '설치 SDK가 이미지를 버린다' 증거 테스트와 문서만 갱신했다. **이미지 production transport 전환은 아니다.**

## 저장소의 결정론적 회귀

- `deepseek-compatibility.test.ts`: 실제 provider doGenerate JSON, doStream SSE, 실제 Mastra generate/stream 2-step loop. 구버전 provider 2.0.35에서는 직접 호환성 2테스트 실패/일반 2-step 2테스트 통과.
- 현재 `deepseek-direct-tools.test.ts`: 실제 `createAgent()` main/direct-tools wiring. GitHub/PostHog 각각 및 연속 직접 조회를 generate/stream 양쪽에서 검증하고 doGenerate/doStream 경계 및 outbound wire의 reasoning marker/high/clock을 검사한다.
- 역사적 `deepseek-delegation.test.ts`(현재 대체됨): 당시 main/subagent 연속 위임의 동일 길이/다른 길이 marker를 검증했다. 1.32.1의 동일 길이 연속 위임은 실패, 1.49.0은 통과했다. 이는 당시 SDK 호환성 증거이며 현재 specialist 실행 계약은 아니다.
- fake LLM/registry fetch와 DB seam만 사용한다. 저장소 목록은 운영 정책대로 등록 카탈로그에서 반환하며 GitHub org 전체 API를 호출하지 않는다. PostHog 최소 동작도 카탈로그 읽기이지 분석 API 호출 증거가 아니다.
- trusted RequestContext를 실제 하위 도구까지 전달한다. Slack 쓰기/live API/DB mutation은 없고 로거는 차단한다. 실제 추론/프롬프트/키를 수집하지 않는다.

## 로컬 검증 결과

Node 22.23.3의 일회성 실행 환경(호스트 Node 변경 없음)에서 `yarn install --immutable`, database/shookie build 통과. `yarn workspace shookie test --maxWorkers=1 --minWorkers=1`: **92 files / 1647 tests 통과**, PostgreSQL outbox 통합 1 file / 22 tests는 DB URL 미설정으로 기존 skip. 배포 mock Docker/ARM64 계약 테스트는 실행했고 실제 이미지 빌드는 PR CI에서 별도 확인한다. timeout을 변경하지 않았다.

최종 테스트를 그대로 두고 임시 의존성 교체로 negative control 재실행: DeepSeek 2.0.35는 4개 중 2개 실패(이전 턴/빈 필드 및 빈 tool_calls), Mastra 1.32.1은 팩토리 8개 중 동일 길이 연속 위임 양 모드 2개 실패/나머지 6개 통과. 최종 manifest/lock 복원 후 immutable install/build 및 SDK·위임·배포 계약 26개 재통과.

## 운영 인수 (merge 후 main 담당)

CI ARM64 이미지 build와 배포 SHA 확인 후, Slack 메시지를 쓰지 않는 읽기 전용 경로로 main → Code Explorer → 등록 GitHub 최소 읽기 및 main → PostHog → 등록 프로젝트 최소 읽기를 확인한다. 연속 위임도 확인하며 400 재발 여부/최종 답변을 검증하되 실제 추론/프롬프트/키를 보존하지 않는다. 운영 접근/자격증명 작업은 이 PR에서 수행하지 않는다.
