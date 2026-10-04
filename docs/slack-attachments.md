# Slack 첨부 읽기

## 범위와 운영 권한

`slack_read_attachment`는 **현재 요청 채널에서 요청자가 접근 가능한 메시지에 실제 첨부된 파일**만 읽는다. 입력은 `fileId`, `messageTs` 및 스레드 댓글의 경우 루트 `threadTs`이며 채널·사용자·토큰·URL을 모델이 지정할 수 없다. 신뢰된 Slack actor/client bridge가 요청자의 현재 채널 접근과 최신 메시지→파일 관계를 검증한 뒤 `files.info` 메타데이터를 얻는다. 봇의 파일 접근 권한만으로 임의 fileId를 읽어서는 안 된다. 다른 채널 검색/파일 읽기를 허용하지 않는다.

기존 `SLACK_BOT_TOKEN`만 사용한다. 별도 user token이나 파일용 토큰이 없다. 운영자가 Slack 앱에 최소 `files:read`와 선행 Slack 읽기 도구가 요구하는 채널/history 읽기 권한이 있는지 확인해야 한다. 첨부 전용 bridge는 선행 `verifyCurrentSlackChannelAccess`를 주입받아 live current-channel scope를 얻고, 해당 채널에서 정확한 `messageTs`의 파일 관계를 검증한 후 메타데이터 조회 직전과 다운로드 직전에 scope를 재검증한다. `threadTs`는 같은 현재 채널의 정확한 댓글 조회에만 사용하며 별도 채널 권한을 부여하지 않는다. 새 scope가 필요하면 **사용자가 직접** Slack 앱의 권한 설정과 재설치를 수행해야 한다. 이 PR은 토큰 추가·운영 권한 변경·자동 재설치를 수행하지 않는다. 파일 보관/캐시 API 및 공개 web 도구와 결합하지 않는다.

## 지원 형식

- UTF-8 `text/plain`, `text/markdown`, `text/x-markdown` (BOM 허용). CRLF/CR은 줄 번호를 위해 LF로 정규화하지만 공백·Markdown은 그대로 보존한다.
- `text/csv`, `application/csv`: RFC 스타일 쉼표/이중 인용부호/인용된 여러 줄/이스케이프된 인용부호. CSV는 순수 문자열 배열이며 `=`, `+`, `-`, `@` 수식을 실행하거나 URL을 방문하지 않는다. 출처 `start/end`는 CSV 논리 행의 **원문 물리 줄 범위**이다.
- `application/pdf`: PDF 1.0–1.7 텍스트 레이어만 추출한다. 페이지별 출처와 텍스트 없는 페이지 목록을 반환한다. PDF.js 4.10.38 ESM을 고정하며 Node 20+ / Yarn 4에서 실행한다. 공개된 과거 PDF.js eval 취약 버전(<4.2.67)을 사용하지 않으며 `isEvalSupported:false`도 적용한다.
- 보안상 PDF stream은 직접 `/Length`와 무필터 또는 단일 `FlateDecode`만 허용한다. 간접 length/filter, name escape, 다른 압축 필터, 손상된 구조는 거부한다. 따라서 일부 정상 텍스트 PDF도 unsupported/limit로 거부될 수 있다. 이미지-only PDF는 텍스트 없음/지원하지 않는 필터로 거부된다.
- 이미지·스캔 OCR·영상·Office·암호화/password PDF는 지원하지 않는다. 모든 페이지가 비어 있으면 `NO_TEXT_PDF` (빈 문서 또는 스캔, OCR 미지원), 일부 빈 페이지만 있으면 `emptyPages`를 명시한다. 파일명/확장자는 형식 판정·권한 판정에 쓰지 않는다. Slack MIME, HTTP MIME, 파일 signature/유효 UTF-8를 검증한다.

## 구간·검색·출처

`unitStart` (1부터), `unitCount` (최대 200)는 텍스트 줄·CSV 논리 행·PDF 페이지 구간이다. `query`는 정규식이 아닌 대소문자 무시 리터럴 검색이며 매칭된 원문 단위 번호를 유지한다. 매 요청은 접근을 다시 확인하고 다운로드/파싱한다. 큰 파일은 최대 4 MiB 범위에서 구간·검색으로 읽으며 전체 결과 캐시는 없다.

결과는 `source.fileId/name/channelId/messageTs`, 단위별 `start/end` 및 PDF `page`를 가진다. 답변은 이 출처를 함께 인용해야 한다. `complete`는 전체 원문 반환에만 true이다. `truncated`는 요청 구간이 출력 byte 한도로 잘렸다는 뜻이며 범위 선택만으로는 true가 아니다. `nextUnit`으로 다음 구간을 요청한다. 단일 너무 큰 단위가 잘리면 같은 unit을 표시하며, 원본을 나누도록 안내한다. CSV 출력 셀도 잘릴 수 있으므로 단위 `truncated`/`omittedCells`를 반드시 확인한다. 원문이나 파일명의 지시를 실행하거나 승인으로 간주하지 않는다.

## 보안·자원 제한 검토

공개 `web_fetch`에 credential을 섞지 않는다. 별도 HTTPS downloader는 정확히 `https://files.slack.com/files-pri/…`만 허용한다. redirect도 동일 origin/경로만 최대 2회; Slack CDN/다른 Slack subdomain도 실패로 처리한다. 다른 origin에는 요청 자체를 보내지 않아 Authorization이 전달되지 않는다. 매 hop DNS의 **모든** 주소가 public unicast인지 확인한 뒤 검사된 주소 하나를 HTTPS lookup에 고정하고 TLS hostname 검증을 유지한다. 사설/loopback/link-local/IPv4-mapped 사설 주소, userinfo, 비HTTPS/alternate port를 차단한다. 프록시/env URL을 사용하지 않는다. HTTP 압축은 identity만 허용한다.

| 제한 | 값 |
|---|---:|
| 파일/HTTP streamed body | 4 MiB |
| DNS·download 전체 wall | 10초 |
| 파싱 wall (CPU 소비도 이 wall 이하) | 5초, 초과 SIGKILL |
| 파서 병렬 실행 | 최대 2개, 초과 fail-closed |
| 파서 V8 old heap | 128 MiB |
| PDF stream 해제/전체 해제 | 2 MiB / 8 MiB |
| PDF 페이지 | 50 |
| CSV 행/열/셀 UTF-8 | 10,000 / 100 / 16,384 bytes |
| 파싱 결과 JSON/단위 수 | 1 MiB / 100,000 |
| 사용자 도구 결과 JSON UTF-8 | 32,768 bytes |

모든 파싱은 메인 이벤트 루프가 아닌 별도 Node 프로세스에서 수행한다. stdin/stdout 크기를 제한하고 stderr는 반환하지 않는다. 자식 env에는 PATH/LANG만 전달해 bot/API 토큰 및 NODE_OPTIONS 등을 제거한다. PDF.js에는 바이너리 data만 제공하고 font/network/eval/XFA/render 사용을 비활성화한다. PDF stream 사전 검사는 literal string/comment/hex를 무시하는 bounded lexer로 수행하고 bounded zlib inflate를 통해 parser에 넘기기 전 압축폭탄을 거부한다. PDF.js의 object stream에서 stream object를 허용하지 않는 구조와 동일한 direct-stream 정책을 사용한다.

**격리는 OS sandbox를 뜻하지 않는다.** V8 heap 제한은 RSS/전체 native memory의 hard rlimit가 아니며, 이 구현은 bounded 입력·해제·출력·페이지·이미지렌더 금지와 kill deadline을 함께 적용한다. 미래 parser 교체/새 filter 허용 시 별도 보안 검토가 필요하다. 에러는 한국어 안내와 안전한 code만 반환하며 토큰, URL, Slack 원본 오류, 파일 본문을 로그/에러로 노출하지 않는다. 요청 전체 timeout/cancel/budget 작업은 포함하지 않는다.

## 검증 구분

`src/tools/attachments/*.test.ts`는 합성 Slack capability/HTTP/DNS 응답과 직접 생성한 여러 페이지 텍스트 PDF로 검증한다. credential redirect 차단, 사설 DNS, body/deadline, Unicode/잘못된 encoding, CSV multiline/formula/한도, PDF 암호화 marker/빈 페이지/압축폭탄/페이지 한도, parser wall kill/concurrency/token-free env, 도구 호출과 출처/출력 한도를 포함한다. **실제 Slack credential·실제 Slack 첨부 E2E는 실행하지 않았다.** 암호화 테스트는 qpdf로 AES-256 암호화한 합성 PDF fixture와 Encrypt marker를 함께 검증한다. 이미지-only 합성 PDF 및 빈 PDF의 텍스트 없음도 검증하지만 실제 스캔 문서 OCR을 실행한 것은 아니다. Node 20.20.2와 로컬 Node 24에서 같은 첨부 테스트를 실행한다.
