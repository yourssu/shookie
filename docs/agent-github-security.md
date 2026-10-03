# Code Explorer: Wave1 GitHub 읽기 전용 경계

## 적용된 기능과 미지원 기능

Code Explorer는 고정 `https://api.github.com`의 typed GET 조회만 제공한다:
저장소 목록/정보, Git tree, 파일 내용, 커밋 이력, PR 목록/상세, 이슈 목록/상세.
`github_read`만 등록하며 `run_authenticated`, git/gh subprocess 및 자동 Workspace 파일 도구는 제거했다.
임의 API 경로/URL/HTTP method/CLI 인수는 받지 않는다. CLI/config/alias/hooks/credential helper/프로토콜 실행 경로가 없다.

**클론, 로컬 편집, 명령 실행, push, PR 생성/병합/삭제는 현재 지원하지 않는다.**
도메인 지식 업데이트는 사실에 근거한 변경 **제안**만 제공한다. 저장하거나 PR을 생성했다는 응답은 금지한다.
격리된 coding 및 승인형 원격 쓰기는 후속 작업이며 이번 PR에는 승인 게이트가 없다.
이 설계는 Wave1 감독자 승인으로 clone/subprocess 구현 대신 실행 경계 자체를 제거했다.

## 신뢰 및 저장소 범위

모든 도구 조회는 신뢰된 Slack handler가 주입한 requestContext의
`channel`, `threadTs`, `userId`, `requestId`, 선택적 `teamId`를 검증한다.
사용자가 입력한 identity는 받지 않는다. 누락/이전 context는 네트워크 호출 전에 fail closed 한다.
런타임 PR을 먼저 병합하고 shared context 계약을 통합 리뷰해야 한다.

`owner`는 설정된 조직이고, owner/repo는 제한된 이름 문법으로 검증한다.
기본 범위는 해당 조직이다. `CodeExplorerConfig.repositories`를 명시하면 저장소 조회와 목록 출력이 그 allowlist로 좁혀진다.
현재 startup의 기존 설정은 조직 범위이며 별도 allowlist 환경변수는 추가하지 않았다.
사용자 ID 존재는 비공개 데이터 열람 승인이 아니다. **사용자별 저장소 ACL은 아직 구현되지 않았다.**
사용 가능한 자료는 설정된 credential 권한과 owner/repo 범위의 교집합이다.

`readOnlyToken`이 주입되면 우선 사용하며 secrets를 파일/워크스페이스에 복사하지 않는다.
현재 startup은 기존 `GITHUB` credential을 전달하므로 실제 배포에서는 그 credential을 read-only 최소 권한으로 발급해야 한다.
코드의 GET 제한은 credential 자체의 광범위한 권한을 줄여주지는 않는다. 별도 read-only credential wiring은 후속 운영 작업이다.

## HTTP 및 출력 경계

- 고정 host에 GET만 수행하며 `redirect: error`; redirect 응답도 거부한다.
- 응답의 download_url/raw/avatar/Link next URL을 절대 따라가지 않는다. 토큰은 그 URL에 전달되지 않는다.
- path는 상대 경로이며 traversal/control/backslash 금지, segment별 encoding. ref는 제한 문법 및 encoding.
- page 1–100, perPage 1–30. tree는 ref 필요, 파일은 path 필요.
- 응답 스트림 최대 256 KiB, 모델 데이터 출력 최대 32 KiB; JSON/file base64 디코딩 후 현재 credential 문자열과 encoded 표현을 제거한다.
- HTTP 요청과 body 읽기에 총 10초 deadline 및 abort 적용. 오류 원문/응답 오류 본문/credential은 출력하지 않는다.
- 출처 API URL, owner/repo/ref/path, page, hasNextPage, truncated를 반환한다. 응답 내 sha/permalink도 유지한다.
  파일 sha는 blob SHA다. 일관된 스냅샷을 원하면 commit SHA를 ref로 전달해야 한다.
- oversized 응답은 오류로 거절하며 출력 잘림은 truncated로 표시한다. 잘린 data 문자열은 완전한 JSON이 아닐 수 있다.
- 코드/이슈/PR 내용은 untrusted data다. 일반 데이터 내부의 다른 비밀까지 완벽히 탐지하는 DLP는 제공하지 않는다.

## 기존 워크스페이스 보존

handler가 사용하는 `ensureThreadCapacity(basePath, maxGb)` export/signature는 유지했다.
이 함수는 전역 capacity check이므로 actor를 요구하지 않는다. 크기 제한 도달 시 비파괴 거절하며,
활성 여부가 불명확한 기존 작업/로컬 변경은 삭제하지 않는다. finish/eviction 도구는 agent에 등록하지 않는다.
심볼릭 링크가 발견되면 계산을 거절한다. 용량은 신규 읽기 작업의 디스크 quota/lease가 아니며,
동시 writer를 제어하지 않는다. 이번 agent는 디스크 쓰기를 하지 않는다.
후속 작업용 scoped path 검증 helper는 actor/team/channel/thread와 realpath directory boundary를 검사한다.
이를 안전한 coding sandbox/lease로 주장하지 않으며 현재 agent에는 노출하지 않는다.
관리자는 기존 변경을 보존한 뒤 수동으로 공간을 확보해야 한다.

## 회귀 검증

dummy credential, mocked fetch 및 임시 로컬 디렉터리만 사용한다. 실제 GitHub/Slack/DB에 연결하지 않는다.
조회 9종, allowlist/encoding, 임의 URL/CLI/쓰기 거절, redirect/응답 URL 미추적,
credential redaction/별도 credential, byte/deadline 제한, 누락 context, agent wiring,
경로 sibling prefix/다른 스레드/symlink, 용량 초과 작업 보존을 검사한다.
subprocess가 없어 CLI timeout/process-tree 테스트는 HTTP deadline 테스트로 대체한다.
