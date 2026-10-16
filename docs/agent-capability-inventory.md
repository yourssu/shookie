# Shookie 도구 인벤토리 (설계 기준 스냅샷)

이 문서는 현재 코드의 실제 도구 등록(`shookie/src/agent/index.ts`, `agents/main-shookie/tools.ts`, `agents/posthog/tools.ts`, `agents/code-explorer/tools.ts`)을 기준으로 작성한 **설계 인벤토리**다. 운영 중 활성/정상 여부(runtime health)를 나타내지 않는다. Radar 프론트엔드의 기능 카탈로그도 이 문서를 근거로 작성한 authored snapshot이며 live status가 아니다. 도구 등록이 바뀌면 이 문서를 함께 갱신한다.

## 메인 에이전트 (슈키) 직접 도구

| 도구 키 | 활성 조건 | 범위 / 제한 |
|---|---|---|
| `web_fetch` | 항상 (키 불필요) | 공개 HTTP(S) URL의 HTML/텍스트/JSON 읽기. 내부 주소·로그인·쿠키·브라우저/JS·PDF·이미지 미지원 |
| `web_search` | 항상. `EXA_API_KEY` 없으면 Exa 무료 MCP(속도 제한), 있으면 Exa REST(계정 크레딧) | 검색 공급자 스니펫(본문 미검증). 결과 URL 자동 읽기 없음 |
| `web_read_more`, `web_find_in_content` | 항상 | `web_fetch`로 고정한 정제 본문의 이어 읽기/literal 검색. 같은 팀·요청자·채널·스레드만 |
| `slack_read_thread`, `slack_read_channel`, `slack_search` | `SLACK_BOT_TOKEN` (bot read client) | thread: 현재 채널 및 같은 workspace 비공유 공개 채널의 명시적 스레드(타 채널은 요청자 live membership + bot 읽기 권한). channel: 현재 요청 채널만. search: `assistant.search.context` + 인증된 event `action_token` + `search:read.public`, 공개 채널만. private/DM·공유/외부 workspace 불가 |
| `slack_read_attachment` | `SLACK_BOT_TOKEN` + `files:read` | 현재 채널의 정확한 메시지 첨부만. UTF-8 텍스트/Markdown, CSV, 텍스트 PDF. 최대 4 MiB/50페이지. OCR·Office·암호화 PDF 미지원 |
| `slack_analyze_image` | `SLACK_BOT_TOKEN` + `files:read` | 현재 채널 정확한 메시지의 PNG·JPEG만, 기존 LLM에 전달한 파생 해석(정확성 보장 없음) |
| `posthog_agent` | `POSTHOG_API_KEY` **및** `RADAR_POSTHOG_REGISTRY_API_URL` + `SHOOKIE_POSTHOG_REGISTRY_INTERNAL_API_KEY` | PostHog Analyst 서브 에이전트 위임 (아래) |
| `code_explorer_agent` | `GITHUB` (PAT) **및** `RADAR_GITHUB_REGISTRY_API_URL` + `SHOOKIE_GITHUB_REGISTRY_INTERNAL_API_KEY` | Code Explorer 서브 에이전트 위임 (아래) |

메인은 파일 수정·명령 실행·push·PR 쓰기·Radar 설정 쓰기 도구가 없다. PostHog 도메인 지침 "기억/저장" 요청에는 Radar 지침 변경 **제안**만 작성하며 실제 반영은 Radar에서 권한 있는 담당자가 한다.

## PostHog Analyst 서브 에이전트 (`posthog_agent`)

모든 도구는 서브 에이전트 내부에만 노출된다. Radar PostHog 프로젝트 등록 API가 유일한 권한 원본이며 **각 도구 호출마다** 최신 catalog를 다시 조회해(양성 캐시 없음) 프로젝트를 서버 측에서 승인한 뒤에만 PostHog 요청을 보낸다. 등록·삭제·이름/ID·지침 변경은 재시작 없이 다음 호출부터 반영된다. 빈 catalog/조회 실패/시간 초과는 거부이며 코드 화이트리스트 fallback은 없다.

| 도구 키 | 용도 | 제한 |
|---|---|---|
| `listProjects` | Radar 등록 프로젝트 목록 (`page` 1–1000, `perPage` 1–30) | 이름·projectId·설명(300자)·지침 미리보기(200자, 항목당 1200 byte)·updatedAt. PostHog API는 호출하지 않음 |
| `queryEvents` | 이벤트 목록 | 이벤트 id/event/timestamp만 선택, 임의 속성 제외 |
| `queryInsights` | 인사이트 목록/숫자 ID 상세 | 선택 필드, 크기 예산 |
| `listFeatureFlags` | 기능 플래그 목록 | 타게팅 조건 제외 |
| `listDashboards`, `getDashboard` | 대시보드 목록/상세(타일·인사이트 요약) | 선택 필드 |
| `queryHogQL` | HogQL 쿼리 실행 | 8,000 byte 쿼리. **읽기 전용/안전성은 도구가 강제하지 않음**, 부분 마스킹만 적용 |
| `listPersons` | 사용자 조회 | 내부 ID·생성 시각·식별 여부만 (속성/distinct ID/email 제외) |
| `listCohorts`, `listExperiments` | 코호트/실험 목록 | 선택 필드 |

- 프로젝트 선택: `project`는 등록 이름(대소문자 무시). 등록 1개면 생략 가능, 여러 개면 생략 시 `project_selection_required`(임의 기본값 없음), 없으면 `no_registered_projects`, 미등록/삭제/ID·URL 입력은 `unknown_project`, 레지스트리 실패는 `registry_unavailable`. 권한 바인딩은 등록된 숫자 projectId로 한다.
- 고정 PostHog 인스턴스(`https://app.posthog.com/api`)와 Shookie의 `POSTHOG_API_KEY`만 사용한다. LLM이 인스턴스/토큰을 지정할 수 없다.
- 각 대상 동작 결과의 `guidance`에 최신 전체 프로젝트 지침이 포함된다. 비신뢰·하위 우선순위 메타데이터이며 접근 확대나 안전장치 변경을 허용하지 않는다.
- 결과 계약·예산·마스킹은 `docs/agent-posthog-contract.md` 참고.

## Code Explorer 서브 에이전트 (`code_explorer_agent`)

| 도구 키 | 용도 | 제한 |
|---|---|---|
| `github_read` | Radar 등록 저장소 목록·저장소·tree·파일·커밋 이력·PR·이슈 읽기 | 읽기 전용 GitHub API, 매 동작 Radar 등록 재검증 |
| `repo_clone` | 등록 저장소 bare shallow clone → snapshotId | 브랜치/태그만, 스크립트 실행·checkout·수정 없음 |
| `repo_list_files`, `repo_read_file`, `repo_search` | 소유 snapshot의 파일 목록/읽기/literal 검색 | 같은 Slack actor/스레드만, symlink/gitlink/바이너리/대용량 제외 |

파일 수정·임의 명령·push·PR 생성/병합/삭제는 지원하지 않는다. 자세한 내용은 `docs/agent-repository-exploration.md`, `docs/deployment.md` 참고.
