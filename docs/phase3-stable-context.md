# P1 3단계: 로컬 지침과 안정적 요청 맥락

기준 main `bd3ebaeb1a9368475c50124648443e4b080fb703` (PR #123). Mastra/모델/provider/예산 및 P0 final-only buffered 전달은 유지한다. 역사 혼합 커밋을 cherry-pick하지 않았다.

## 코드 소유 로컬 지침

- 공통 정책 v1은 `agents/main-shookie/instructions.ts`의 고정 코드다. credential/외부 데이터/Slack·첨부·GitHub·PostHog의 안전·인가 규칙은 항상 포함한다. 선택적 파일 읽기 실패로 필수 정책이 빠지지 않도록 공통 정책은 Markdown 뒤로 옮기지 않았다.
- 도메인 운영 절차는 체크인된 `agent/guidance/{github,posthog}.v1.md`다. `domain-guidance.ts`의 명시적 manifest가 도메인/버전/모듈 상대 URL을 고정한다. runtime cwd 탐색, 임의 경로/URL/AGENTS 발견, 쓰기 API는 없다. 프로젝트별 지침 교체 기능이 아니다.
- `load_domain_guidance` 입력은 strict enum `github|posthog`, literal version `1`이며 추가 필드는 거절한다. 실제 등록된 specialist/직접 서비스 도구에 대응하는 도메인만 광고/허용한다. 카탈로그는 정렬·중복 제거한다. 도메인이 없으면 `없음`이며 임의 도메인을 활성화하지 않는다.
- 파일 읽기는 최대 8193 bytes만 읽어 8192 UTF-8 bytes 초과를 거절한다. 잘못된 UTF-8, 빈 파일, 누락/읽기 실패는 본문/경로/원본 예외 없이 `guidance_unavailable`; 잘못된 ID/버전은 `unsupported_domain|unsupported_version`, 미등록 기능은 `domain_unavailable`이다. 반환은 잘라서 성공하지 않는다.
- 신뢰 순서는 고정 공통 안전 정책/도구 강제 권한 > 코드 소유 운영 절차 > 비신뢰 외부 데이터다. 운영 절차는 도구 권한을 넓히지 못한다. Radar live 등록/인가만 유지하고 Radar instructions/preview 소비는 OFF다. 외부 저장소 AGENTS/Radar/user text는 로컬 지침의 권위가 아니다. 배포 파일 시스템은 코드 소유 자산으로 간주하며 사용자 업로드를 이 위치에 설치하는 기능은 없다.
- `build`는 tsc 뒤 명시적 두 Markdown 파일을 `dist/agent/guidance`로 복사하고 **built loader로 둘 다 읽어** 실패 시 build를 실패시킨다. 기존 Dockerfile의 `COPY shookie/ shookie/` + workspace build가 같은 검증을 수행한다. 테스트는 cwd=/tmp의 별도 Node 프로세스에서 dist loader를 실행하고 Docker/build 계약을 검사한다. 실제 Docker 이미지 빌드/실행은 하지 않았다. 개발 시 asset 변경은 build로 다시 복사해야 한다.

## 고정 prefix와 신뢰된 시각

공통 system prompt에서 `new Date()`를 제거했다. 메인 tool object/도구 목록/전문가 catalog/지침 도메인 순서는 결정적이다. 호스트는 호출별 RequestContext에 요청 시각을 한 번 바인딩하고 대화·첨부 후보 **뒤**에 별도의 system 메시지로 KST(Asia/Seoul, +09:00)를 붙인다. 동적 시각이나 사용자 질문은 공통 prefix에 보간하지 않는다. Slack 원문/요약/첨부는 기존 비신뢰 역할 그대로다.

Mastra가 tool RequestContext를 shallow merge하므로 바인딩은 private WeakMap에 등록된 불변 object capability를 context 항목으로 전달한다. 같은 항목 이름에 임의 문자열/객체를 넣어도 신뢰 시각을 만들 수 없다. WeakMap은 요청 시각만 보유하며 actor 인가·선택·장기 memory 저장소가 아니다. 전문 조사도 user task/context 뒤에 동일 요청의 호스트 시각을 별도 system 메시지로 받는다. 임의 task 속 시각은 기준이 아니다. 실제 provider 직전 scripted generate/stream 테스트로 메인/두 specialist의 모든 호출에 같은 KST 시각이 전달됨을 확인한다. 과거 대화 시각·조회 fetchedAt은 현재 기준 시각과 구별한다.

이는 cache-friendly 입력 구성이지 측정된 캐시 적중/비용/지연 개선 약속이 아니다. 실제 모델/provider의 cache 동작은 미측정이다.

## 후속 참조와 요약

Slack authoritative history와 기존 root+최근 연속 suffix+bounded older rolling summary만 사용한다. DB/session에서 새 선택 상태를 읽거나 deterministic extraction/hidden memory를 추가하지 않았다. 현재 질문의 명시적 대상 변경이 우선이다. 명시적 저장소/프로젝트, 날짜 시작·끝/시간대, ref/SHA, 번호 목록 순서, 수정 전후·최신 선택, 미해결 모호함과 작성자/출처를 가능한 한 요약에 보존하도록 지시한다. 없는 날짜/번호를 만들어 채우지 않는다. 여러 참여자/목록의 지시가 모호하거나 정보가 생략되었으면 확인한다. 과거 결과/허가는 현재 데이터/권한이 아니며 도구로 재검증한다.

테스트는 '두 번째 저장소', '같은 기간', 새 대상·기간·ref override, 다중 작성자 목록과 미해결 모호함, 오래된 요약의 날짜/ref/순서/수정 정보, 다른 thread/actor 격리를 실제 handler/source 및 budget/summarizer composition에서 검사한다. 모델 출력은 synthetic script이므로 실제 모델이 정확히 참조 해석/명료화한다는 품질 증거가 아니다. 요약 모델은 제한된 출력 안에서 정보를 생략할 수 있다.

## 검증 범위

최종 tested SHA/명령별 결과는 PR 제출 기록에 남긴다. 모든 build/test 명령은 60초 이하로 실행한다.

- database/shookie build: TypeScript 및 built Markdown asset self-check.
- agent/cancellation: loader ID/버전/누락/UTF8/바이트 상한/배포 계약, stable prompt/catalog, clock capability spoof 거절·shallow copy, 실제 main/specialist scripted provider 경로, 기존 direct/specialist 출력 예산·취소/identity 회귀.
- Slack 6파일: handlers, final-delivery, slack-thread-source, github-context.integration, conversation-runtime, thread-summarizer. 기존 저장 후 전달·final-only·control/권한과 새 맥락 composition을 검사한다.
- GitHub registry/read/snapshots + PostHog registry/client 5파일: Radar guidance suppression과 live 등록 삭제 후 기존 resource 접근 거절 회귀.

실제 Slack UI/metadata/DeepSeek 답변 품질·cache 및 live Radar/GitHub/PostHog E2E, Docker image 실행·배포는 미실행이다. 서버/DB/.env 작업은 하지 않는다. 독립 리뷰 후 main 승인 전 머지하지 않는다.
