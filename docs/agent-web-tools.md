# 공개 웹 도구

메인 슈키가 `web_fetch`와 (설정 시) `web_search`를 직접 사용합니다. 도메인 데이터/코드 분석은 기존 PostHog/Code Explorer 위임을 유지합니다. 파일 수정·명령 실행·push·PR 쓰기 권한은 추가하지 않습니다. 실제 등록된 도구와 Code Explorer 설명으로 기능 목록을 생성하므로 미등록 기능은 사용 가능하다고 광고하지 않습니다.

## 선택적 Exa 검색 설정 및 마이그레이션

- 로컬: 운영자가 Exa dashboard에서 키를 발급하고 저장소 루트의 **커밋하지 않는** `.env`에 `EXA_API_KEY=<본인의 Exa API 키>` 설정. `.env.example`에는 빈 예시만 있습니다.
- 배포: GitHub 저장소 **Settings → Secrets and variables → Actions → New repository secret**에 이름을 정확히 `EXA_API_KEY`로 지정하고 **새 Exa 키**를 저장합니다. 이 작업/테스트는 실제 키를 조회하거나 생성하지 않습니다.
- 이미지 배포 워크플로우는 Secret → `DEPLOY_EXA_API_KEY` → SSH envs → 서버 export → `docker-compose.yml`의 bot 환경변수 순서로 전달합니다. 기존 이미지 배포/롤백 동작은 변경하지 않습니다.
- 기존 `BRAVE_SEARCH_API_KEY`/Brave 키를 재사용하지 마세요. 이전 설정은 제거하고 새 secret을 등록해야 검색이 활성화됩니다. Brave fallback은 없습니다.
- 키가 비어 있거나 공백뿐이면 `web_search`는 등록하지 않고 검색 불가라고 설명합니다. `web_fetch`는 키 없이 항상 등록됩니다. 다른 검색 제공자나 스크래핑으로 대체하지 않습니다.
- [공식 가격표](https://exa.ai/pricing)는 월 무료 크레딧을 안내하지만, 계정별 자격·금액·가격·정책은 변경될 수 있습니다. **키 없이 무료/무제한 검색을 보장하지 않습니다.** 운영자가 dashboard에서 현재 계정의 잔액, 사용량, 결제/자동 충전 및 사용 예산 설정을 확인하고 서비스가 제공하는 한도/알림을 설정하세요. 코드는 호출 횟수나 월 지출 상한을 강제하지 않습니다. 402는 재시도 불가 크레딧 소진 오류로 안내합니다.

검색은 `POST https://api.exa.ai/search`만 호출하며, 키는 `x-api-key` 헤더로만 전송합니다. JSON 요청은 `query`, `numResults`, 명시적 `type: auto`, `contents: {highlights: {maxCharacters: 2000}}`만 포함합니다. 품질을 낮추는 instant 전환, full text, AI summary, deep/synthesis, 별도 유료 Exa contents/fetch 호출은 없습니다. 리다이렉트를 따르지 않습니다. query 1–400자(제어문자 제외), count 1–10(기본 5), 직렬화된 요청 본문 최대 4,096 bytes, 전체 네트워크 deadline 12초, 전송/압축 해제 응답 각각 최대 1,000,000 bytes입니다.

결과는 `provider: Exa`, title/url/snippet 및 공급자가 제공한 경우에만 publishedAt을 포함합니다. highlights 배열을 줄바꿈으로 합쳐 최대 2,000자로 반환하며, 없는 highlights는 빈 snippet입니다. nullable/누락 메타데이터를 받아들이되 발췌/날짜를 만들어내지 않습니다. Exa publishedDate는 공급자의 추정 날짜이며 검증된 게시일이 아닙니다. `results: []`는 성공, 누락된 results/잘못된 응답은 오류입니다. unsafe URL 제거, 결과 수/제목/발췌/날짜의 로컬 잘림은 complete=false/truncated=true로 표시합니다. complete는 **수신 응답의 로컬 잘림 여부**이지 웹 전체 검색이나 공급자 발췌의 완전성을 보장하지 않습니다.

URL을 자동으로 읽지 않습니다. `evidence: search_snippets`는 **공급자 발췌**이고 본문 직접 검증을 뜻하지 않습니다. 본문 확인은 메인이 별도로 `web_fetch`를 호출합니다. 이 직접 GET 읽기는 Exa API·키·결제와 무관하며 검색 전후에도 자격증명/요청 본문을 보내지 않습니다.

### 공식 계약 및 fixture 출처

[Exa Search 공식 OpenAPI](https://exa.ai/docs/reference/search.md)의 SearchRequest, ContentsOptions.highlights.maxCharacters, SearchResultsResponse.results, SearchResultOutput 및 apiKey 보안 스키마를 근거로 합성 fixture를 구성했습니다. `maxCharacters`는 문서의 정수 범위 내인 2,000을 사용합니다. 사용한 메타데이터는 누락/null을 허용하고 author 등의 미사용 필드는 무시합니다. fixture는 실제 검색 데이터/키가 아닙니다. 가격표와 문서는 구현 시 확인했지만 실제 API/요금/운영 계정은 검증하지 않았습니다.

## 공개 URL 읽기

예: “https://공개사이트/문서 를 읽고 요약해줘”. HTTP 80 / HTTPS 443의 공개 HTML, UTF-8/ASCII 일반 텍스트 및 JSON만 읽습니다. HTML은 linkedom + Mozilla Readability로 파싱하며 스크립트/스타일/임베드 콘텐츠를 제거합니다. 브라우저, JS 실행, 외부 리소스 로딩, PDF, 이미지, 바이너리 다운로드, 사용자 인증/쿠키는 지원하지 않습니다. 로그인/ACL 보호 페이지의 접근 권한을 우회하지 않습니다. HTML 본문 추출은 모든 레이아웃을 완벽하게 재현하지 않으며 동적 페이지는 비거나 불완전할 수 있습니다.

성공 결과: `originalUrl`, `finalUrl`, `fetchedAt`, `contentType`, `title`, `text`, `lines: {start,end}`, `complete`, `truncated`, `limits`, `evidence: fetched_text`. 줄 번호는 **추출된 text** 기준이며 원본 HTML 줄 번호가 아닙니다. 비어 있는 본문은 0–0입니다. 본문 인용 시 최종 URL·조회 시각·줄 범위를 함께 제시합니다. complete는 수신/추출 텍스트가 반환 한도에서 잘리지 않았다는 뜻이지 사실의 정확성이나 동적 페이지 전체 수집을 보장하지 않습니다.

- 전체 DNS/연결/리다이렉트/본문 네트워크 예산: 호출당 12초
- 압축된 전송량과 압축 해제된 본문: 각각 최대 1,000,000 bytes; 초과 시 부분 성공이 아니라 `BODY_LIMIT` 오류
- 리다이렉트: 최대 3회; 매 단계 URL/DNS 정책 재검증
- 반환 text: 기본 20,000자, maxChars 100–30,000자; 초과 시 complete=false/truncated=true
- HTML 요소: 최대 30,000개; 헤더 최대 16,384 bytes
- UTF-8 이외 인코딩/바이너리 징후/MIME 불일치/지원하지 않는 압축 형식은 실패

실패는 `ok:false` 및 공개용 한국어 메시지·안전한 오류 코드·retryable·limits로 반환합니다. 원본 네트워크 오류/스택/키는 반환하거나 로깅하지 않습니다. Exa 401은 키 확인, 402는 크레딧/예산 확인을 안내하며 재시도 불가입니다. 429/5xx 및 네트워크/시간 초과만 재시도 가능으로 표시하며 내부 자동 재시도는 없습니다. 정책 차단/형식 오류는 우회하지 않습니다.

## SSRF 및 데이터 신뢰 경계

WHATWG URL 정규화 후 사용자정보/비표준 포트/비HTTP(S)를 거부합니다. 숫자/16진수/축약 IPv4와 IPv4-mapped IPv6를 포함한 주소를 ipaddr.js로 분류하고 사설·루프백·링크로컬·메타데이터·멀티캐스트·예약/특수 범위를 차단합니다. IPv6는 특수 범위를 제외한 global unicast만 허용합니다. DNS의 **모든** 후보가 공개 주소여야 합니다. 검증된 한 주소를 native Node HTTP(S)의 실제 socket lookup에 고정합니다. 다시 DNS를 조회하거나 일반 fetch로 전환하지 않습니다. 원래 호스트는 HTTP Host/TLS SNI/인증서 검증용으로 유지하며 TLS 검증을 끄지 않습니다. 공유 agent/연결 재사용/환경 프록시를 사용하지 않습니다. 외부 URL에는 쿠키/Authorization/사내 자격 증명을 보내지 않습니다.

검색 스니펫과 페이지 내용은 신뢰할 수 없는 데이터입니다. 그 안의 지시·시스템 프롬프트·승인·토큰 요구를 실행하거나 다른 도구의 권한으로 해석하지 않습니다. 공개 읽기는 모델이 명시적으로 도구를 호출할 때만 수행합니다.

## 오프라인 검증

`yarn workspace shookie test src/tools/web/web.test.ts src/agent/agents/main-shookie src/agent/web-registration.test.ts src/agent/combined-web-clone.integration.test.ts src/config.test.ts src/deployment/deploy-contract.test.ts --maxWorkers=1`

합성 DNS/HTTP/키 및 루프백 socket fixture만 사용합니다. 주소/매핑 corpus, 혼합 DNS, 실제 native connector의 pinned lookup(변경된 DNS로 재조회되지 않음), TLS 옵션, 리다이렉트 재검증, 연결/DNS/본문 hang, 압축 폭탄, MIME/바이너리, 파싱/잘림, 검색 공식 endpoint/header/비자동 fetch, 키 없는 등록 및 실제 production factory 등록을 검사합니다. 실제 Slack/DB/GitHub/Exa 요청은 수행하지 않습니다. native HTTPS request의 POST JSON/key/host/TLS/pinned lookup, 검색 리다이렉트 차단, 후속 fetch의 GET/무자격증명/무본문을 검사합니다. 기존 clone/Slack actor 격리 검증도 유지합니다.

HTML 파서는 작은 합성 fixture와 요소 수 제한으로 검증했으며 동기 파싱의 CPU 시간을 강제 제한하지 않습니다. 네트워크 deadline은 파싱의 하드 CPU 예산이 아닙니다. 검색 결과 URL 중복 제거를 보장하지 않습니다.
