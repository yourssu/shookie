# Slack PNG·JPEG 이미지 분석

## 범위와 상태

초기 범위는 현재 요청자가 접근 가능한 현재 채널의 **정확한 메시지 첨부 PNG·JPEG** 한 개를 설명하거나, 스크린샷 글자·도표를 읽는 것입니다. 외부 이미지 URL, GIF/APNG 애니메이션, WebP, 영상, 스캔 PDF, 별도 OCR 엔진은 지원하지 않습니다. 이미지 분석 결과는 `derived_image_interpretation`이며 원문 텍스트 또는 정확한 OCR의 증거가 아닙니다. 작은 글자·차트 축·수치가 불확실하면 반드시 명시하고 원본과 대조해야 합니다.

`shookie/src/tools/images/`와 실제 main의 `slack_analyze_image` 등록·프롬프트·handlers redaction·첨부 권한 브리지 연결을 구현했습니다. 기준은 취소 PR93 squash SHA `96b0741d34d00248a7cca1d124148f533fb1b967`입니다. 기존 도구 합집합과 `executionTools` wrapper는 보존합니다. 코드 등록 및 synthetic integration 성공은 운영 배포나 실제 Slack/DeepSeek 이미지 인식 성공을 의미하지 않습니다. 실제 E2E는 아직 미실시입니다.

## 권한과 데이터 경계

- 도구 인자는 `fileId`, `messageTs`, 선택적 루트 `threadTs`, 최대 1000자의 `question`뿐입니다. channel/user/token/URL/base64/model/config/signal을 모델 인자로 받지 않습니다.
- 기존 `AuthorizeAttachment` capability를 주입하여 요청자의 live WeakMap 신원, 현재 채널 접근, 정확한 message→file 관계, `files.info`, 재검증을 재사용합니다. bot이 파일을 읽을 수 있다는 사실만으로 권한을 부여하지 않습니다.
- 기존 `downloadAttachment`의 Slack-only URL·DNS public-address pinning·크기·시간·redirect 제한과 기존 bot token을 그대로 사용합니다. 새 다운로드 구현을 복사하지 않습니다.
- 기존 첨부 권한 브리지에 server-supplied MIME validator를 선택하는 최소 확장만 추가합니다. 기존 텍스트 validator 기본값 `attachmentKind`는 그대로이고 `createSlackImageOptions`만 PNG·JPEG validator를 고정 주입합니다. 모델 인자로 policy를 교체할 수 없으며 각 호출의 live 권한·메시지 관계·metadata를 새로 검사합니다.
- Slack private URL, token, 파일명 등 메타데이터는 이미지 분석 모델에 전달하지 않습니다. inline 이미지 bytes만 이미지 user block으로 보냅니다. 반환값은 bounded 해석, file/channel/message 출처, 이미지 크기, 한계뿐이며 URL/base64/credentials는 포함하지 않습니다.
- 이미지 내용·사용자 question은 비신뢰 데이터입니다. 고정 system 프롬프트와 분리되며 이미지 분석 호출에는 tools가 없습니다. 파생 해석도 main의 지시/권한/승인으로 승격시키지 않습니다.
- `slack_analyze_image`를 기존 첨부 도구와 동일하게 **도구 인자·결과 로그/DB 기록 및 progress 미리보기에서 redaction**합니다. 이미지 도구가 등장한 최종 답변의 운영 로그 미리보기도 길이만 남깁니다. 해석을 사용자에게 답변하는 것과 민감 도구 body를 운영 로그에 남기는 것은 별개입니다.

## 구조 검사와 예산

| 항목 | 제한 |
| --- | --- |
| 다운로드/이미지 bytes | 4 MiB |
| 한 변 | 8192 px |
| 총 픽셀 | 16,000,000 |
| PNG chunks/JPEG markers | 4096 |
| API JSON request | 6 MiB |
| API JSON response | 64 KiB |
| 해석 text | 16 KiB UTF-8 prefix, 잘림 표시 |
| 이미지 API deadline | DNS부터 response 완료까지 30초 |
| 이미지 API max_tokens | 2048 |

`header.ts`는 inflate·decode·render·실행을 하지 않습니다. PNG signature, chunk bounds/CRC/order/IHDR/color/depth, IDAT zlib prefix, IEND와 JPEG SOI/segment bounds, 8-bit baseline/progressive frame dimensions/components, quantization/Huffman tables, SOS, bounded entropy marker walk(FFD0–FFD7 restart marker도 공유 4096-step 예산에 포함), EOI를 검사합니다. APNG, unsupported critical chunks/JPEG variants, MIME mismatch, 크기 초과, 구조 손상은 차단합니다. **헤더 구조 검사이지 전체 압축 pixel stream의 유효성 보증이 아닙니다.** 헤더가 유효해도 실제 디코딩이 실패할 수 있으며 remote 오류는 fail-closed합니다. 압축 해제 폭탄은 로컬에서 해제하지 않는 방식으로 회피하고 raster 크기는 사전 제한합니다.

## 현재 SDK가 아닌 독립 전송을 쓰는 이유

공식 [DeepSeek Vision 가이드](https://api-docs.deepseek.com/guides/vision/)는 `deepseek-flash`에서 OpenAI-compatible `/chat/completions`의 user content 배열에 text와 inline base64 `image_url` block을 지원한다고 설명합니다. 하지만 설치된 `@ai-sdk/deepseek@2.0.35`의 `dist/index.js`의 `convertToDeepSeekChatMessages`는 user parts에서 `part.type === "text"`만 연결하고 나머지는 unsupported warning만 추가한 뒤 버립니다.

`transport.test.ts`는 설치된 SDK를 실제 호출하되 fetch를 synthetic으로 대체합니다. 표준 image `file` part(`mediaType: image/png`, bytes)를 넣었을 때 **실제 outgoing JSON이 text-only**이고 `user message part type: file` unsupported warning이 생김을 검증합니다. 문서 지원만 보고 SDK 전달 성공으로 오인하지 않습니다.

별도 `transport.ts`는 기존 `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` 값만 사용하는 최소 tool-free OpenAI-compatible HTTPS POST 경로입니다. main/provider/global model 설정이나 package deps를 바꾸지 않습니다. server의 trusted HTTPS config endpoint(`/` 또는 `/v1`)만 사용하며 URL userinfo/query/fragment/alternate port와 private DNS를 차단하고 DNS를 socket에 pinning합니다. redirect는 전부 거절하고 압축 response, API unsupported/error, malformed/refused/tool-return 응답은 정직하게 실패합니다. 텍스트-only 재시도나 다른 모델로의 fallback은 없습니다. 응답의 private URL/token/data URL과 긴 원시 base64 run을 차단하며, 공백·개행·탭을 제거한 응답이 원본 encoded image payload를 포함해도 실패로 처리합니다. 정규화된 일반 문장·수치가 길다는 이유만으로 base64로 판정하지 않고 원본 payload와 정확히 비교합니다. 차단된 raw response text는 반환하거나 로그/DB에 저장하지 않습니다.

각 전송은 자체 deadline과 호출자의 AbortSignal을 결합하여 실제 request/socket을 abort합니다. synthetic HTTP endpoint 테스트는 header stall/body stall/deadline에 실제 열린 socket이 종료되는 것을 검증합니다. `readImage` 및 이미지 API는 `executionSignal(context?.abortSignal)`을 통해 public tool signal과 AsyncLocalStorage의 main 3분 request signal을 결합하고 전후 abort/checkpoint를 검사합니다. 기존 Slack downloader의 `DownloadDependencies.signal` 및 실제 HTTP abort를 그대로 재사용합니다. DNS 잔여 작업 및 request `close`를 `trackExecution`에 등록하여 취소 후 runtime 소유권이 실제 잔여 완료까지 유지됩니다. 등록된 도구의 Slack 다운로드/이미지 API socket을 실제 local HTTP로 열고 registry scope를 취소한 뒤 `scope.drain()`과 socket 종료를 확인하는 synthetic integration 테스트를 추가했습니다.

## 검증 구분과 실제 E2E 계획

실행한 독립 테스트는 synthetic PNG/JPEG 컨테이너·API 응답, exact outgoing JSON, installed SDK drop regression, 크기/헤더/오류/권한 capability 재사용 경계, redirect/response/output budget, DNS/header/body stall, 실제 local socket abort를 검증합니다. 이는 실제 DeepSeek의 이미지 인식 품질이나 Slack scope를 증명하지 않습니다.

`src/agent/image-registration.test.ts`는 실제 main 등록/현재 채널 live 권한 브리지/요청자 context/public signal/registry 취소/socket drain/DB·로그·progress redaction을 synthetic integration으로 검증합니다. 기본 텍스트 MIME 정책 보존, PNG·JPEG 실제 outgoing inline JSON, 임의 파일·위조 context·삭제 메시지·부모 첨부 차단, 매 호출 live membership 재검증, image-unsupported 실패/no fallback도 포함합니다. 실제 Slack/DeepSeek E2E는 **미실시**이며 main과 사용자가 승인한 범위에서만 다음과 같이 별도 진행합니다.

1. 공유 연결·PR 검토 후 배포 성공 확인 시 main에 테스트 준비를 알립니다. 승인된 기존 테스트 채널 `C0AKBED3QDQ`에 합성 테스트임을 명시한 비밀 없는 작은 PNG 한 개(큰 고유 글자·색 도형·간단한 막대 도표)를 업로드/멘션하여 분석합니다. 샘플 외 다른 사용자 첨부는 읽지 않습니다.
2. 기존 bot token 및 LLM config로 그 정확한 메시지의 첨부에 대해 설명/글자/도표를 요청합니다. 새 token 발급·scope·모델·환경설정 변경은 하지 않습니다.
3. 원본과 해석을 대조하고 file/message 출처·불확실성·오독을 기록합니다. 운영 로그/DB에 inline bytes/token/private URL이 없고 tool input/output은 redacted인지 확인합니다. 비밀 원문·이미지 bytes·API bodies는 검사 기록에 복사하지 않습니다.
4. API image-unsupported/error라면 그대로 실패로 기록하며 SDK success 또는 시각 인식 success로 포장하지 않습니다. 권한 없는 다른 file relation이 차단되는지도 승인된 테스트 범위에서 확인합니다.
