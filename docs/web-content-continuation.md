# 긴 웹 본문 이어 읽기와 literal 검색

`createWebTools()`가 `web_fetch`, `web_search`와 함께 root 도구 `web_read_more`, `web_find_in_content`를 등록한다. 메인 도구의 기존 spread 등록으로 사용 가능하며 서브 에이전트 위임이나 새 의존성은 필요하지 않다.

## 스냅샷과 기존 계약

- `web_fetch({ url, maxChars? })`의 입력, `evidence: fetched_text`, `text`, 출처, `lines`, `complete`/`truncated`, 기존 `limits`는 유지한다. 기본 20,000 / 최대 30,000 UTF-16 코드 단위를 반환한다.
- 최초 다운로드에서 **정제한 전체 본문**을 메모리에 보관한다. HTML은 inert parser/Readability 처리 및 위험 요소 제거, plain은 줄바꿈/공백 정리, JSON은 기존 pretty-print 후 정리한다. DOM, 다운로드 Buffer, 대화 memory는 저장하지 않는다.
- 추가 메타데이터: `offset`(처음은 0), `endOffset`, `nextOffset`(끝이면 null), `totalChars`, `totalBytes`(정제 본문 UTF-8), `offsetUnit: utf16_code_units`, `storage`.
- 저장 성공 시에만 임의 UUIDv4 `contentId`, `expiresAt`를 반환한다. `storage: available` / `quota_exceeded` / `context_unavailable`로 이어 읽기 가능 여부를 구분한다. 캐시 한도 초과여도 최초의 제한된 `text`는 반환한다.
- URL별 공유/중복제거 캐시가 아니다. 같은 URL의 새 fetch는 새 다운로드·새 ID·새 시각이다. read/find는 네트워크를 전혀 호출하지 않으며 최초 `originalUrl`, `finalUrl`, `fetchedAt`, `contentType`, `title`을 그대로 반환한다. 페이지 변경/삭제 이후에도 TTL 내에서 같은 본문을 읽는다.
- `web_search`는 변경하지 않는다. `search_snippets`는 공급자 발췌이며 직접 본문 근거가 아니다. find 결과는 저장된 본문에 근거한 `fetched_text`, `resultKind: literal_matches`이다.
- 제목·URL·본문·검색 일치문은 모두 **신뢰할 수 없는 사용자 데이터**다. 도구 설명에서 이 데이터를 시스템 지시/승인/요청자 정보로 취급하지 않도록 명시한다.

## 사용 예

```text
web_fetch({ url: "https://public-source.org/article", maxChars: 30000 })
  → contentId, nextOffset: 30000, totalChars: 65000, truncated: true
web_read_more({ contentId, offset: 30000, maxChars: 30000 })
  → 동일 출처/시각, text, lines, nextOffset: 60000
web_find_in_content({ contentId, literal: "한글😀", offset: 0, count: 10 })
  → matches: [{ offset, endOffset, lines, snippet }], nextOffset
```

`web_read_more`의 offset은 필수이며 최초 응답의 `nextOffset`을 사용한다. `web_find_in_content`의 offset 기본은 0, count 기본은 10이다. find의 `nextOffset`이 있으면 같은 literal로 다음 검색을 요청한다. ID만으로는 권한이 생기지 않는다.

## Unicode와 줄 인용

- 네트워크 입력은 기존처럼 UTF-8만 허용한다. **offset/endOffset/nextOffset/totalChars/maxChars/literal 길이는 JavaScript UTF-16 코드 단위**다. byte offset이나 사용자 인지 글자(grapheme) 개수가 아니다. 0부터 세며 `[offset, endOffset)` 범위다. `한`은 1, `😀`는 2 단위다. Unicode 정규화/대소문자 변환은 하지 않는다.
- 반환 끝에서 surrogate 쌍을 자르지 않는다. 예: 99단위 한글 뒤 emoji가 있을 때 maxChars 100이면 99까지만 반환하고 nextOffset 99를 준다. 입력 offset이 쌍 중간이면 `INVALID_OFFSET`. 결합문자/grapheme 경계까지 보장하지는 않는다.
- `lines`는 **정제 전체 본문**의 1부터 시작하는 줄 번호다. 원본 HTML 줄 번호가 아니다. 끝에 포함된 newline은 앞줄에 속한다. 빈 text/EOF는 `{ start: 0, end: 0 }`.
- read의 complete는 해당 offset부터 본문 끝까지 도달했음을 의미하며 이전 범위를 이미 읽었다는 뜻은 아니다. truncated는 뒤에 본문이 더 있다는 뜻이다.
- 검색은 대소문자를 구분하는 **literal, non-overlapping** 검색이다. `.*`, `[x]`는 정규식이 아니다. trim하지 않으므로 공백을 포함한 정확한 검색이 가능하지만 빈 문자열/공백만/불완전 surrogate/control 문자는 거부한다(의미 있는 검색어의 newline/tab 허용).
- 각 match의 offset/endOffset/lines는 정확한 일치 범위다. snippet은 match 시작부터 최대 1,000단위이며 별도의 offset/endOffset/lines/잘림 메타데이터를 갖는다. snippet.nextOffset은 본문 계속 읽기용이다. 검색 pagination은 최상위 nextOffset을 사용한다.
- 검색 complete/truncated는 해당 offset 이후 일치 결과를 모두 반환했는지 나타낸다. 일치가 없으면 `ok: true, matches: [], complete: true`. 미지원 형식/실패와 다르다.

## 권한·메모리 한도

- 모든 저장·조회는 **runtime trusted RequestContext**의 `teamId`, `userId`(요청자), `channel`, `threadTs`를 확인한다. 네 필드가 모두 유효한 문자열이어야 하며 binding은 네 값 전체다. tool arguments나 본문에 있는 userId/teamId는 권한에 영향이 없다. 요청 ID는 스냅샷 scope가 아니므로 같은 요청자·스레드의 후속 turn에서 조회할 수 있다.
- 컨텍스트가 없거나 팀 등 일부가 없는 legacy fetch는 기존처럼 text를 반환하되 저장하거나 contentId를 공개하지 않는다. read/find는 `CONTENT_CONTEXT_REQUIRED`로 차단한다.
- 다른 actor/team/channel/thread, unknown/expired/evicted ID는 모두 `CONTENT_UNAVAILABLE`을 반환한다. 존재 여부/다른 범위의 출처를 노출하지 않는다. 실패 시 자동 refetch하지 않는다.
- production 캐시는 프로세스 전역이다. 여러 `createWebTools` 인스턴스로 한도를 우회할 수 없다. 재시작/다른 프로세스에서 ID는 유효하지 않다.
- TTL **10분**(저장 시 고정, read/find로 연장하지 않음). entry별 bounded unref timer로 idle 만료 본문도 제거하고, 모든 캐시 작업에서도 만료를 검사/정리한다. eviction/expiry 시 timer·본문·metadata를 제거한다. tombstone/별도 actor map은 없다.
- 전역 최대 **64 entries / 16 MiB charged memory**, actor(`teamId + userId`)별 **8 entries / 4 MiB**. actor quota는 채널·스레드를 바꿔도 공유된다. actor quota 초과 시 새 snapshot을 거절하고 기존 snapshot을 유지한다. 전역 부족 시 FIFO로 오래된 snapshot을 제거한다(읽기는 순서를 갱신하지 않음).
- charged memory는 `2 × (본문 + 출처 문자열 + scope 문자열)의 UTF-16 길이 + entry당 1,024 bytes`다. 문자열은 복사해 잘라낸 문자열이 큰 원본 backing store를 잡고 있지 않도록 한다. JS 엔진/Map/timer overhead 때문에 V8 heap 크기와 동일한 수치는 아니며, entries 한도로 구조적 overhead도 제한한다. 원본 byte 길이만 계산하는 방식이 아니다.

## 출력·다운로드 안전 한도

| 항목 | 한도 |
|---|---|
| read/fetch 본문 | 30,000 UTF-16 단위 / 90,000 UTF-8 bytes |
| literal | 1–400 UTF-16 단위, 공백만 불가 |
| find 결과 수 | 최대 20, 기본 10 |
| snippet | 각각 최대 1,000 UTF-16 단위 |
| find snippet 합계 | 최대 20,000 UTF-16 단위 / 60,000 UTF-8 bytes |
| fetch/read/find 전체 JSON 출력 | 최대 256 KiB (UTF-8 encoded), 초과 시 OUTPUT_LIMIT |

새 read/find 성공 출력의 `limits`는 위 retrieval/cache 한도를 포함한다. 기존 fetch/search/error의 limits 형태는 유지한다. Mastra input schema validation 실패는 framework validation 오류이며, 실행 중 범위/권한/다운로드 오류는 기존 `ok: false` 안전 오류 봉투다. 원본 예외/응답/비밀은 노출하지 않는다.

기존 네트워크의 public URL/DNS pinning, redirect 재검증, SSRF 차단, UTF-8/MIME 제한, 다운로드 12초 deadline, redirect 최대 3, **wire/decoded body 각각 최대 1,000,000 bytes**는 변경하지 않는다. 실제 다운로드가 1MB를 초과하면 계속 BODY_LIMIT 실패하며 cache/read_more가 이 제한을 우회하지 않는다. 정제된 JSON이 확대되어 캐시 quota를 초과하는 경우 최초 제한 text만 제공할 수 있다. 요청 전체 timeout/취소/검색 비용 정책은 이 변경 범위에 포함하지 않는다.

## 검증

```bash
yarn workspace database build
yarn workspace shookie test src/tools/web
yarn workspace shookie build
```

`content.test.ts`는 30k 뒤 marker 읽기/검색, no-refetch, scope 격리, legacy 비노출, TTL/idle expiry/FIFO/actor·byte quota, 지원 형식, Unicode 경계/정확한 줄 번호, literal/빈 결과/출력 한도를 검사한다. 기존 `web.test.ts`, `mcp.test.ts`의 네트워크 안전/Exa 계약 회귀 테스트도 함께 실행한다.
