# Mastra 하네스 P0/P1

## 단일 대화 소유자 / 직접 도구

Mastra와 기존 DeepSeek 모델·provider·thinking 설정은 유지한다. 메인이 일반 GitHub/PostHog 조회·목록·분석을 직접 수행한다. 서비스 모듈은 별개이며 같은 도구 인스턴스를 메인과 선택적 전문 에이전트에 등록한다. 설정은 인스턴스 생성 시 고정되고 snapshot/continuation은 기존 서버 측 scope와 만료 규칙을 유지한다. `executionTools`는 인스턴스당 한 번만 감싸며 동일한 인증 RequestContext/실행 ALS/signal을 직접 호출과 위임에 전달한다.

깊고 맥락이 큰 조사만 specialist를 선택한다. 입력은 목표(`task`), 필요한 맥락(`context`), 출력 범위(`outputScope`)를 명시한다. 결과는 `status: success|partial|error`, `result`, `evidence`, `limitations`다. evidence는 호출 도구명 목록이며 원문 출처는 result에서 확인해야 한다. 도구 실패/비정상 finish는 partial/error이며 예외도 성공으로 표시하지 않는다. 취소 예외는 기존 실행 경계로 전파한다.

## 프롬프트와 지침 신뢰

공통 프롬프트는 시간에 따라 변하지 않는 간결한 안전·응답·실행 규칙이다. 실제 등록 도구 순서는 결정적이다. 현재 시각은 매 호출 생성한 KST trailing trusted request system message로 전달하며 DB 대화에 저장하지 않는다. 안정 prefix는 캐시 친화성이지 provider 캐시 적중 보장이 아니다.

`load_domain_guidance({domain: github|posthog})`는 소스에 번들된 로컬 지침만 읽는다. 버전은 `GUIDANCE_VERSION`, 각 본문은 최대 12,000 UTF-8 bytes이며 초과 시 잘라 실행하지 않고 거절한다. 경로/URL/프로젝트 선택 인자는 없다. 우선순위는 공통 시스템 보안 > 로컬 도메인 보조 지침 > 비신뢰 외부 데이터다. AGENTS.md처럼 적용 범위가 명시된 보조 지침이지만 임의 저장소 AGENTS/파일을 자동 수집·실행하지 않는다. 전문 에이전트는 선택적으로 호출될 때 동일한 로컬 서비스 지침을 사용한다.

**Radar는 여전히 유일한 live 리소스 등록 권위**다. 매 조회의 등록/삭제/ID/이름 재검증과 기존 인증은 유지한다. Shookie의 registry HTTP 경계에서 repository/project `instructions`를 빈 문자열로 바꾼 뒤 반환하므로 목록 preview, authorized result, clone/snapshot, 메인/전문가 어느 경로에도 내용이 전달되지 않는다. 호환 envelope의 instructions/preview는 빈 값이며 truncated=false다. 선택용 이름·ID·설명·시각 등 metadata는 유지한다(지시로 실행하지 않음). Radar 코드/데이터/등록 설정은 변경하지 않는다.

**프로젝트별 지침 관리는 보류**다. 대체 백엔드·프로젝트 지침 ingestion·repo AGENTS 수집·저장/업데이트 제안 워크플로우를 만들지 않는다. 프로젝트 정의는 명시적 사용자 대화/조회 근거와 한계를 사용하고 영구 기억/다음 조회 반영을 약속하지 않는다.

## Slack 응답과 전달 상태

- 질문에 비례해 짧게 답하고 별도 모델 재작성은 없다. 정적 정책 테스트는 실제 답변 품질 보장이 아니다.
- 생성 중에는 요청별 간단 상태/취소 제어만 표시한다. 도구 인자/결과·추론·도구 전 텍스트·비용/토큰/도구 footer는 전송하지 않는다.
- 최종 답변을 성공 저장한 **뒤** 최대 2개(각 12,000 code points 이하) markdown 청크로 `chat.startStream`/선택적 `appendStream`/`stopStream` 전달한다. 길이 검사는 UTF-16 기준 24,000자로 더 보수적이며, 초과 또는 team 누락은 기존 final blocks renderer로 한 번 전달한다. sleep/타이핑 지연은 없다. 정상 2~3 API 호출, 알려진 stream 실패 정리까지 최대 4회다.
- 이는 **생성 완료 후 buffered 청크 전달**이지 생성 중 실시간 토큰 스트리밍이 아니다. P0 실제 생성 스트리밍은 미완료/후속이다. 중간 텍스트를 안전하게 최종 답변으로 분류할 신호 없이 노출하지 않는다.
- Slack 공식 `chat.stopStream` 계약은 blocks를 streamed markdown **아래에 추가**한다. 따라서 stop에는 feedback `context_actions`만 보내고 본문 blocks를 다시 보내지 않는다. incremental markdown/코드펜스는 Slack native renderer가 완성한다. 긴 답변 fallback은 기존 Markdown→blocks renderer를 사용한다. 실제 Slack UI 렌더링은 미검증이다.
- fallback은 **start의 명시적** unknown_method/method_not_supported/not_allowed_token_type/missing_scope에만 허용한다. SDK는 구조화된 platform error code만 검사한다. transport timeout/끊김/internal_error/append/stop 실패는 재게시하지 않는다. known session은 본문 없이 best-effort stop만 한다. exactly-once 보장은 아니며 부분 전달/미전달이 남을 수 있다.
- 저장 상태와 delivered 상태는 별개다. 최종 전송 성공 확인 후에만 그 요청의 제어 메시지를 삭제한다. 삭제 실패는 답변 재전송 사유가 아니다. 전달 미확인은 제어에 명시하고 버튼은 비활성화한다. 취소/실패 안내는 보존한다. 기존 180초 실행/15초 독립 전달 scope와 committing 시 취소 거절은 유지한다.

계약 근거: https://docs.slack.dev/reference/methods/chat.stopStream/ (`blocks` rendered at bottom, markdown limit 12,000). 실제 Slack/DeepSeek 네트워크나 서버/DB 작업 없이 문서와 mocked transport로만 확인했다.

## 후속 참조와 fresh 권한

Slack 채널 스레드는 원문이 권위이고 기존 root+recent/요약 예산을 유지한다. DM은 기존 성공 pair 이력/15분 캐시/DB 재수화 경로를 유지한다. 별도 selected-target 영구 저장소나 모델 메모리를 만들지 않는다. 대상·기간·ref는 제공된 대화의 명시적 근거로 참조하고 둘 이상/만료·생략/불명확하면 확인한다. 오래된 결과를 최신이라고 주장하지 않으며 매 도구 호출마다 현재 권한과 데이터를 재확인한다. cursor/snapshot의 기존 scope/TTL은 권한을 연장하지 않는다.

요청 제어 post에 `shookie_request_control` metadata를 붙인다. 자동 Slack source reader는 전체 completeness 검증 **후** 봇 자신의 제어 메시지와 알려진 예전 완료/진행 고정 문구를 모델 이력에서 제외한다. 같은 내용을 사람이 쓰면 보존한다. source summary와 request-time context는 새 durable memory 권위가 아니다.

## 검증 범위

합성 provider/Slack transport 및 로컬 git fixture 테스트는 직접 등록/RequestContext/취소·등록 철회, Radar 지침 비전파, 도메인 loader 크기/버전/임의 경로 거절, 최종 전송 chunk/failure/cancel/no-replay, feedback 본문 중복 방지, DM 후속 참조 입력과 시간/제어 이력 분리를 검증한다. 실제 모델의 참조 해석·간결성·Slack UI는 보장하지 않는다. 실제 Slack/DeepSeek/PostHog/GitHub 인증 end-to-end 및 배포/서버/DB 작업은 실행하지 않았다.
