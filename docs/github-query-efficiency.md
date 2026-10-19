# GitHub 조회 범위와 모델 출력 경량화

## 쿼리 계약

`github_read`의 `pull_requests`는 기본 `state=all&sort=created&direction=desc`다.
최근 PR 3개는 `{ operation: "pull_requests", repo: "…", perPage: 3 }`로 조회한다.
커밋 이력으로 PR을 추정하거나 우회할 필요가 없다. 결과의 `source`와 `query`에 실제 범위를 명시한다.
`perPage`는 기존 1–30 제한을 유지하고 별도 count alias는 없다.
GitHub 조회의 기존 page 최대 100과 Radar 목록의 기존 최대 1000을 유지한다.
GitHub page>100 거절은 새 제한이 아니라 buildReadUrl의 기존 검사를 schema preflight에도 옮긴 것이다.

PR 목록만 다음 옵션을 허용한다. 다른 작업(특히 Radar 목록 early return)에 사용하면 네트워크 전에 거절한다.

- state: open / closed / all
- sort: created / updated / popularity / long-running
- direction: asc / desc. 생략하면 created는 desc, 나머지는 asc (GitHub 기본값).
- long-running은 단순 전체 기간 정렬이 아니다. 생성 후 1개월 이상 열려 있고 최근 1개월 내 활동이 있는 PR로 제한한다.

GitHub 자체 기본 state는 open이지만 이 도구는 최근 생성 PR의 상태 누락을 피하려고 all을 명시한다.
closed는 미병합 종료와 병합을 모두 포함한다. merged-only 서버 파라미터는 없으며 merged_at 부재를 병합/미병합으로 추정하지 않는다.
상세의 실제 merged/merged_at 필드만 보존한다. GitHub issues 응답의 PR discriminator도 보존한다.

공식 API 확인: https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
(구현 시 공식 문서에서 state, sort, direction, per_page 및 특수 정렬 의미 확인.)
GitHub per_page 최대는 100이나 도구는 기존 안전 제한 30을 유지한다.

## 출력 계약

원본 응답 크기 제한(256 KiB), scope/번호/path/sha/배열/base64/UTF-8 검증 후 작업별 allowlist로 투영한다.
응답의 임의 중첩 객체, author 이메일, avatar/URL 그래프는 전달하지 않는다.
검증된 응답에서 선택한 문자열은 credential/registry/tokenProvider 마스킹을 먼저 적용한 뒤
byte truncation 및 history 첫 줄 추출을 수행한다. 최종 직렬화 마스킹도 별도로 유지한다.
이 순서는 경계에서 잘린 credential 조각이 exact-match 마스킹을 빠져나가지 않도록 한다.
raw history의 commit.message는 계속 필수 string이며 누락/숫자 응답은 마스킹 전에 거절한다.

- 저장소: 이름/full_name, 설명(2 KiB), 기본 브랜치, 언어, 공개/보관 여부, 날짜, html_url.
- PR/이슈 목록: 번호, 제목(1 KiB), 상태, html_url, 생성/수정/종료 날짜. PR의 실제 merged_at은 null/부재를 구별한다. 본문은 목록에서 제외한다.
- 이력: 전체 SHA, 첫 줄 subject(1 KiB), committer 날짜(없으면 author 날짜), html_url. 전체 메시지와 저자 객체는 제외한다.
- 상세: 위 식별 정보, 본문(8 KiB), 댓글/상태, PR의 병합 정보와 diff 통계 및 base/head ref/SHA/repo identity. 자른 텍스트에 `bodyTruncated`/`titleTruncated` 등을 표시한다. history의 byte 제한으로 자른 subject도 `subjectTruncated`를 표시한다.
- tree/file: 경로/모드/type/SHA/size 및 실제 검증된 파일 내용/인코딩을 유지한다. 파일 크기/내용 무결성 검증은 투영 전에 수행한다.

`source`, owner/repo/ref/path, page, hasNextPage, complete/truncated, repositoryGuidance는 기존 위치를 유지한다.
`complete`는 해당 응답 페이지의 완전성이지 전체 페이지를 모두 가져왔다는 뜻이 아니다.
Link는 next 존재만 확인하고 URL을 따라가지 않는다. 반환 목록은 요청 개수를 초과하지 않으며 upstream 초과 항목은 원본 전체 검증 후 제외하고 omittedItems/complete=false로 표시한다.

마스킹 이후 직렬화 JSON의 UTF-8 바이트를 32 KiB로 제한한다. 예산 초과 시 JSON 문자열을 자른 preview 대신
`{ incomplete: true, reason: "model_output_byte_limit", data, omittedItems 또는 omittedFields }` 구조로 실제 생략을 명시한다.
목록/tree는 온전한 항목만 유지하고 큰 파일은 내용 대신 SHA/path/size 등 메타데이터를 남긴다.
부분 출력/텍스트 잘림/서버 tree truncated는 complete=false다. 일반 목록의 의도된 요약은 partial로 취급하지 않는다.
원본 응답 자체가 256 KiB를 넘으면 여전히 거절한다. 이 변경으로 모든 대형 응답이 성공한다고 주장하지 않는다.

## 합성 측정 (실서비스 절감량 아님)

`github-query-projection.test.ts`의 결정론적 fixture에서 동일한 목록 증거(번호/제목/상태/URL/날짜 또는 SHA/subject/날짜/URL)를 유지한 JSON 직렬화 바이트:

| fixture | 개수 | 원본 JSON | 투영 JSON |
|---|---:|---:|---:|
| PR (요청하지 않은 body/user 포함) | 3 | 9,703 | 415 |
| PR | 30 | 97,042 | 4,162 |
| history (긴 메시지/이메일 포함) | 3 | 4,189 | 592 |
| history | 30 | 41,881 | 5,911 |

HTTP 전체/모델 토큰/실제 사용량 측정이 아니며 합성 데이터의 직렬화 비교다. 3과 30은 각각 해당 개수 fixture이며 같은 fixture를 몰래 자른 비교가 아니다.

## 검증/권한 경계

- `yarn workspace database build && yarn workspace shookie build` (각 작업 60초 제한 내)
- `yarn workspace shookie test src/tools/code-explorer/github-read.test.ts src/tools/code-explorer/github-query-projection.test.ts src/tools/code-explorer/registry.test.ts`
- 위 read/query/registry partition: 109 tests pass (수정 후 약 3.7초). title/body/description/subject byte 경계, multibyte 및 first-line 경계 credential 마스킹과 실제 합성 바이트 감소를 assertion으로 검증한다.
- `yarn workspace shookie test src/tools/code-explorer/github-auth.test.ts src/tools/code-explorer/repository-snapshots.test.ts`: 37 tests pass (약 13.9초, 별도 60초 partition).
- 최종 shookie build 및 `git diff --check`: pass.

최초 shookie 단독 build는 로컬 database 산출물 부재 및 새 테스트의 union 접근 타입 오류로 실패했다. 테스트 타입을 수정하고 database 선행 build 후 전체 build가 통과했다.
Radar 등록 live 인가/취소, guidance OFF, snapshot 인가 및 토큰 공급자/마스킹 정책은 변경하지 않는다.
서버/환경변수/모델/로그/메트릭 훅/공유 handler 변경이나 실서비스 네트워크 검증은 없다.
