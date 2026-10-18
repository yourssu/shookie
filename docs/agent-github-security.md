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
startup은 전용 조직 소유 GitHub App provider를 API와 clone에 공유한다. `SHOOKIE_GITHUB_APP_ID`, `SHOOKIE_GITHUB_APP_INSTALLATION_ID`는 양의 정수 문자열(Actions Variables), `SHOOKIE_GITHUB_APP_PRIVATE_KEY_BASE64`는 RSA private PEM의 base64(Actions Secret)다. Radar의 기존 `GITHUB_APP_*`와 다른 App/키이며 재사용하지 않는다. 세 값이 모두 비어 있을 때만 이전 `GITHUB` PAT를 이행기 fallback으로 유지한다. 일부 설정만 있거나 형식/인증/권한 검증이 실패하면 PAT로 우회하지 않는다. App만 설정하고 `GITHUB`를 비워도 동작하며 Radar registry 설정은 항상 필요하다.

App 권한은 repository metadata/read, contents/read, pull_requests/read, issues/read만 허용한다. 쓰기·조직 권한·웹훅은 설정하지 않는다. 최초 설치는 기존 shookie/radar-backend/radar-frontend 세 저장소만 선택한다. 실제 권한은 **App 설치 최대 범위 ∩ 매 동작의 Radar 등록 목록**이다. 등록이 App 설치를 넓히거나 설치가 Radar 등록을 추가하지 않는다. 범위 확대는 별도 승인 사항이다.

서버는 RS256 JWT(iat 60초 skew, exp-iat 600초)로 고정 api.github.com의 App/installation ID·조직 계정·read-only 권한을 검증한 뒤 명시적 read-only permissions로 installation token을 발급한다. 토큰만 메모리에 단일 캐시하며 만료 60초 전 갱신, 동시 요청은 single-flight다. 캐시는 등록을 캐시하지 않는다. 키/JWT/토큰은 모델·로그·디스크에 전달하지 않으며 최근 64개 임시 자격증명을 응답 마스킹에 보관한다. clone 인증은 기존 격리 git 환경의 extraHeader에만 전달한다(URL/argv/config 파일 금지).

키 회전은 main 운영자가 전용 App의 새 키를 외부에서 발급해 Secret 교체 후 재배포하고 검증한 다음 이전 키를 폐기한다. 캐시는 프로세스 재시작으로 제거된다. installation token은 고정 길이를 가정하지 않으며 GitHub의 약 520자 토큰도 지원한다(방어적 최대 4096자). 기존 PAT Secret은 변경/삭제하지 않고 승인된 merge 이후 App 설정으로 전환한다. 실제 설치·배포 및 세 등록 저장소(비공개 두 개 포함)의 metadata/tree/clone 읽기 검증은 운영자가 별도로 수행해야 완료된다. 404는 인증/설치 범위 제한일 수도 있어 저장소가 존재하지 않는다는 증거가 아니다. 임의 브랜치 재시도로 권한 문제를 우회하지 않는다.
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
- 작업별 응답 구조를 검사한다: 저장소 identity/scope, 목록 배열, PR/이슈 번호·제목·상태, 커밋 sha/message, tree 엔트리 등. 잘못된 HTTP 200 응답도 성공으로 취급하지 않는다.
- file은 type=file, encoding=base64, content/size/sha/path가 유효한 inline UTF-8 파일만 지원한다. base64 canonical encoding과 decoded byte size를 검증한다. 실제 size=0/content="" 빈 파일은 지원하지만 encoding=none, 누락 내용, 비어 있으면서 size>0, 디렉터리·symlink/submodule·바이너리 등은 친화적 오류로 거절한다. download_url fallback은 없다.
- oversized 응답은 오류로 거절하며 출력 잘림은 truncated/complete=false로 표시한다. 모델 예산 초과 시 data는 유효한 JSON preview envelope(incomplete/reason/preview)다. tree의 서버 측 truncated도 complete=false로 표시한다.
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
