# Code Explorer: 통제된 clone / 로컬 읽기 전용 탐색

## 제공 범위

기존 `github_read`(GitHub API GET: 저장소, tree, 파일, 이력, PR, 이슈)는 유지한다. Code Explorer에 아래 네 도구를 추가한다. `createCodeExplorerAgent(model, config)` 및 기존 `ensureThreadCapacity` 등 handler용 export는 변경하지 않는다. 중앙 등록/config/deploy는 이 변경의 범위가 아니다.

| 도구 | 입력 | 결과/이어 읽기 |
| --- | --- | --- |
| `repo_clone` | `repo`, 선택적 `ref` | 실제 bare shallow clone, opaque `snapshotId`, owner/repo/ref/**commitSha** |
| `repo_list_files` | snapshotId, offset(기본 0) | 파일 path/mode/type/blob OID, `next` offset |
| `repo_read_file` | snapshotId, 상대 path, startLine(기본 1) | UTF-8 줄 배열, 1-based startLine/endLine, `next` startLine |
| `repo_search` | snapshotId, literal, 선택적 cursor | literal 부분 문자열 일치(path/줄 범위/text), skipped, `next` `{fileIndex,line}` |

`ref`는 브랜치/태그 **이름**이며 기본값은 원격 HEAD다. SHA 및 revision 표현식(`HEAD~1`, `HEAD^{commit}`, `ref:path` 등)을 입력받지 않는다. shallow clone은 해당 ref의 tip 하나만 가져온다. 반환된 commitSha는 snapshot의 모든 조회에 고정된다. 원격 ref가 이동해도 snapshot 내용은 바뀌지 않는다. GitHub API의 file SHA/blob OID는 commit SHA와 구별한다.

입력 스키마는 strict다. owner, URL, command, argv, environment, token, 사용자 identity, limit은 모델 입력이 아니다. 로컬/file/SSH/ext URL, 임의 host/port/조직, checkout, 실행, 파일 수정, push, PR 생성/병합/삭제, submodule/LFS 다운로드, build는 제공하지 않는다. Mastra Workspace도 추가하지 않으므로 자동 편집 도구가 생기지 않는다.

## 요청 identity 및 인증 경계

각 도구의 **모든 호출**에 `requestContext`의 channel/threadTs/userId/requestId와 선택적 teamId를 검증한다. 모델이 주장한 identity는 사용하지 않는다. snapshot 소유권은 `(teamId 또는 없음, userId, channel, threadTs)`에 묶이며 이후 requestId는 달라도 된다. 다른 사용자/팀/채널/스레드, 없는/만료된 snapshot, 요청 context 누락, 동시에 사용 중인 snapshot은 실패한다. snapshot ID는 UUID이며 파일 경로가 아니다.

설정된 `owner`와 선택적 `repositories` allowlist만 허용하며 upstream은 `https://github.com/<owner>/<repo>.git`로 고정한다. 기존 `readOnlyToken` hook을 우선 사용하고 없으면 기존 `gitHubToken`으로 fallback한다. **봇 토큰의 GitHub 권한이 Slack 요청자의 개별 저장소 권한임을 보증하지 않는다.** 운영자는 읽기 전용 최소 권한 token과 allowlist 및 bot 사용 정책으로 범위를 통제해야 한다. 사용자별 GitHub ACL 검증은 이 기능에 포함되지 않는다.

HTTPS Basic authorization의 `x-access-token:<token>`은 Git의 환경 기반 config(`GIT_CONFIG_COUNT`, host-scoped extraHeader)에만 전달한다. URL/argv/remote/on-disk Git config에 token을 넣지 않는다. stdout은 제한하고 stderr는 바이트 수만 세며 저장/로그/오류 응답에 포함하지 않는다. 결과 본문의 설정 token 및 주요 인코딩 표현은 redact한다. 알려지지 않은 별도 repository secret을 탐지/제거하는 DLP 기능은 아니다.

## subprocess / 파일 경계

- 실행 파일은 `/usr/bin/git`, 인자는 코드에서 정한 `clone`, `rev-parse`, `ls-tree`, `cat-file` plumbing만 사용한다. shell을 거치지 않는다.
- `clone --bare --depth=1 --single-branch --no-tags --template=`: checkout/working tree 없음. 서버 tree의 `.gitmodules`, `.gitattributes`, scripts는 **자료**일 뿐 실행하지 않는다.
- child 환경을 새로 구성한다. 부모의 proxy, credential, Git/loader 환경을 상속하지 않는다. HOME/XDG는 private instance root, global config는 `/dev/null`, system config는 비활성화, hooks/attributes/helper는 비활성화, terminal prompt 없음, TLS 검증 유지, HTTPS 외 protocol과 HTTP redirect는 금지한다.
- 원격이 전송하는 파일은 working tree나 `.git/config`가 되지 않는다. Git이 생성하는 bare config에는 credential이 없는 고정 upstream만 들어간다. 서버로부터 config/helpers를 받아 실행하지 않는다.
- UTF-8 Git tree를 NUL-delimited로 파싱한다. traversal, 빈/`.`/`..` component, 절대 경로, backslash, control/NUL, colon, glob/pathspec syntax, option처럼 시작하는 component는 거부한다. 이러한 이름을 포함하는 저장소 전체 clone은 실패할 수 있다(의도적인 보수적 제한).
- 파일 조회는 tree에서 찾아낸 **검증된 blob OID**를 사용한다. 모델 path를 Git revision/pathspec으로 사용하거나 filesystem 경로로 join하지 않는다. regular blob mode 100644/100755만 읽는다. symlink(120000)/gitlink(160000)는 목록에 표시하되 target으로 이동하지 않고 읽기/검색은 unsupported로 표시한다.
- 각 subprocess는 detached process group에서 실행하며 timeout/abort/출력 초과 시 group에 SIGKILL을 보낸다. 정상 종료 때도 남아 있는 group descendant를 정리한다. 도구의 abortSignal을 전달한다. Linux/macOS Node/Git 환경을 전제로 한다.

**전체 OS sandbox가 아니다.** Git 자체/OS 취약점, 신뢰된 봇 프로세스의 compromise, 같은 OS 권한의 타 프로세스에 의한 환경/메모리/저장소 열람·변조, SIGKILL로도 즉시 멈추지 않는 kernel I/O, 신뢰된 constructor test seam의 악용을 격리하지 못한다. Git은 설치된 보안 업데이트 버전을 사용해야 한다. 자식 환경의 authorization은 같은 권한의 process inspector에게 보일 수 있다. 더 강한 경계에는 별도 OS 사용자/container/cgroup/filesystem quota 및 네트워크 egress 제어가 필요하다.

## 제한과 다운로드 quota의 잔여 한계

현재 제한은 `repository-snapshots.ts`의 `SNAPSHOT_LIMITS`에 고정하고 모델이 바꾸지 못한다. 기존 workspaceBasePath/workspaceMaxGb 설정을 그대로 사용한다.

| 대상 | 제한 |
| --- | --- |
| clone subprocess | 30초, stdout+stderr 합 4 MiB |
| clone 디스크 | 64 MiB 관찰 한계, 100ms 주기 비중첩 검사 + 완료 후 검사 |
| 동시 clone 예약 | clone당 96 MiB + 기존 base 경로의 관찰 크기; 최대 live/in-progress snapshot 8개/manager |
| plumbing subprocess | 각 5초, stdout+stderr 합 4 MiB (tree 초과는 clone 실패) |
| blob | 1 MiB 초과는 `large`, 다운로드 대신 로컬 object size 검사 |
| 모델 payload | files/lines/matches+skipped 약 32 KiB + 제한된 provenance/envelope |
| 페이지 | 최대 파일 100개, read 100줄, search 50파일/100일치 |
| search 작업 | 5초 soft deadline(파일 사이 검사); 진행 중 plumbing 각 5초 제한은 별도 |
| 만료 | 생성 후 30분, snapshot별 한 작업만 허용 |
| 저장소/base 크기 측정 | symlink 거부, 최대 100,000 filesystem entries |

**64 MiB는 hard download/network/filesystem quota가 아니다.** shallow single-branch, 30초 timeout, 사전 용량 예약, 실행 중 디스크 크기 감시, 완료 후 검사로 보수적으로 제한한다. 네트워크/pack buffer와 디스크 검사 사이의 전송·쓰기 때문에 64 MiB를 초과할 수 있다. 96 MiB 예약도 overshoot를 절대 보장하는 cgroup quota가 아니며 Git이 압축된 데이터를 메모리에 해제하는 비용도 포함하지 않는다. 종료까지 전송 가능한 바이트 수는 bandwidth에 따라 다르다. 무제한 시간 clone은 없지만 정확한 hard byte download 보증은 없다. 엄격한 수용량 보증이 필요하면 host-level quota/network limiter를 추가해야 한다. 단순 post-clone size 검사를 hard quota라고 주장하지 않는다.

초기 용량 측정/정리 시간, clone 완료 후 commit/tree 확인(각 plumbing deadline), read의 size+blob subprocess, search의 진행 중 subprocess 시간은 clone/soft deadline에 합산된 단일 전역 timeout이 아니다. 일반 read는 최대 두 plumbing 호출을 한다. 작은 bounded blob의 줄 스캔도 soft deadline과 별개다.

## 결과의 완전성

모든 성공 결과에 owner/repo/ref/commitSha/snapshotId 및 complete/truncated/next를 제공한다. 파일·검색은 path와 줄 범위를 포함한다. 빈 파일은 `text`와 빈 lines, missing/binary/large/unsupported는 `complete=false`로 별도로 표현한다. UTF-8이 아닌 blob도 binary다. 한 줄만으로 payload 한계를 넘으면 `large_line`이며 파일 read에는 next가 없다(이를 빈 파일로 해석하지 않는다).

검색은 literal이며 regex/명령이 아니다. 지원하지 않거나 큰 blob, 큰 일치 줄은 skipped에 이유를 표시한다. skipped가 있으면 마지막 페이지에도 complete=false다. `truncated`는 이어서 볼 페이지가 있다는 뜻이고 `complete`는 현재 페이지 작업에서 미확인 항목이 없다는 뜻이다. 전체 검색 완전성은 모든 페이지의 skipped/complete 상태를 함께 판단해야 한다. byte/파일/일치 제한에 도달하면 같은 위치의 cursor부터 재개한다. 오류는 한국어 일반 메시지이며 원본 Git/network 오류는 노출하지 않는다.

## 저장과 정리

설정된 base에 additive `controlled-snapshots-<random>/staged-<random>/repository.git`을 만든다. mkdtemp private parent 내부에만 저장하며 기존 snapshot/legacy workspace 경로를 변경하지 않는다. 용량 초과 시 활성/기존 snapshot이나 local edits를 eviction하지 않는다. 실패한 clone은 **이번 호출이 생성한 staging 경로만** 삭제한다. 정상 snapshot은 이후 clone에서 만료되고 사용 중이 아닌 경우에만 이 instance의 소유권 registry에 근거하여 삭제한다. 만료된 디스크 크기까지 포함하는 용량 preflight가 성공한 뒤에만 정리하므로 용량 실패를 해결하기 위해 만료 snapshot을 지우지도 않는다.

프로세스 재시작 또는 agent 재생성 후 이전 instance root는 자동으로 재사용/삭제하지 않는다. 그 내용은 용량 계산에 포함되며 신규 snapshot 수용이 거부될 수 있다. 정리는 관리자가 기존 자료 보존·활성 프로세스 확인 후 수행해야 한다. 정기 cleanup daemon이나 영속 snapshot registry는 이 변경에 포함되지 않는다.

## 검증

focused tests는 ephemeral 로컬 Git 저장소를 생성하고 constructor-only fake clone transport에서 실제 `git clone --bare --depth=1`을 실행한다. 운영 tool/agent/config/env에는 로컬 transport를 선택할 옵션이 없다. fake token, 임시 디렉터리만 사용하며 조직 저장소/.env/credential/DB/Slack/API를 읽지 않는다.

commit 고정 clone→list/read/search, 페이지 이어 읽기, empty/binary/large/긴 줄, symlink/gitlink, 악성 `.gitmodules`/`.gitattributes`/hook/global config, unsafe/invalid UTF-8 Git tree, token 노출, actor/team/thread/request context 경계, 예약 경쟁/용량/만료/기존 edit 보존, 실제 subprocess timeout/abort/descendant kill/출력 및 디스크 감시/실패 cleanup/retry를 검사한다. 라이브 GitHub private 인증/실제 호스트 네트워크 bandwidth/전체 OS 격리는 검증하지 않는다.
