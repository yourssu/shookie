# 단일 대화 에이전트 구조

`agent/index.ts`는 설정된 GitHub/PostHog 직접 도구를 모으고 `agents/main-shookie/index.ts`에서 Mastra `Agent` 하나만 만든다. 일반 조회와 깊은 조사 모두 메인이 수행한다. specialist 생성, posthog_agent/code_explorer_agent, delegateToSubAgent 및 조사 보고서 투영/예산 런타임은 제거했다. 메인 factory/tools API에 subAgents 인자는 없다.

## 유지하는 계약

- 서비스 client/tool 모듈은 `tools/`에 유지한다. GitHub 도구 factory도 `tools/code-explorer/tools.ts`로 이동했다. 설정 gate와 실제 도구별 결과 예산은 바꾸지 않는다.
- Radar live 등록 재검증·삭제 즉시 차단·GitHub 인증/요청 actor·snapshot 소유권은 그대로다. Radar instructions/preview 소비는 계속 OFF다.
- `load_domain_guidance`는 실제 등록된 `github_read`/`listProjects` 키로 GitHub/PostHog 도메인을 허용한다. 둘/하나/없음 모두 지원하며 미등록 서비스는 기능으로 광고하지 않는다. 개별 서비스 운영 지식은 코드 소유 버전 고정 Markdown에 보존했다. 안전·권한·간결성·내부 제약 비노출 정책은 항상-on main prompt에 남는다.
- 정렬된 고정 도구 정의, 명시적 reasoning_effort high, reasoning history 및 신뢰된 요청 시각 system 메시지는 유지한다. provider/model/의존성 설정은 변경하지 않는다.
- Slack authoritative thread 원문/오래된 요약, 작성자·요청 격리, 실시간 공개 답변 스트리밍·저장 확정·취소·cooldown 흐름은 바꾸지 않는다. 현재 전달 계약은 [response-delivery.md](response-delivery.md), 취소는 [conversation-cancellation.md](conversation-cancellation.md)를 따른다.
- 스레드 summarizer 및 이미지 해석은 보조 모델 호출로 유지한다. “대화 Agent 하나”는 “모든 요청에 모델 HTTP 호출 한 번”을 뜻하지 않는다. 도구 continuation도 여러 모델 호출이 가능하다.
- 역사적 database AgentName/호출 기록/마이그레이션은 호환성을 위해 유지한다. DB 작업/데이터 변경은 하지 않는다.

## 검증과 한계

등록 테스트는 production factory의 Agent 생성 횟수 1, delegate 키 부재, both/one/none 직접 도구/지침 허용을 검사한다. scripted HTTP generate/stream은 실제 main factory→직접 GitHub/PostHog→continuation에서 high, reasoning_content, 호스트 시각과 Radar 지침 비전파를 검사한다. 실제 모델의 routing/답변 품질 증거는 아니다.

기존 live registry 삭제·snapshot·actor isolation, Slack streaming/cancellation 보안 assertion을 유지한다. 삭제된 위임 전용 테스트는 직접 도구/메인 취소 및 Slack→직접 GitHub 인증 경로로 대체한다. 실행 명령/최종 tested SHA 및 실패 이력은 PR 제출 기록에 남긴다. 테스트는 명령별 60초 이하로 분할한다.

실제 Slack UI/DeepSeek 품질·live Radar/GitHub/PostHog E2E, Docker 실행·배포는 미검증이다. 서버/DB/.env 변경은 없으며 독립 리뷰와 main 승인 전 머지하지 않는다. 과거 phase2/phase3 문서는 당시 증거로 보존하며 현재 specialist 실행 계약이 아니다.
