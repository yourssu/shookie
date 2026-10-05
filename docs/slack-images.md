# Slack PNG·JPEG 이미지 분석

## 범위와 상태

초기 범위는 현재 요청자가 접근 가능한 현재 채널의 **정확한 메시지 첨부 PNG·JPEG** 한 개를 설명하거나, 스크린샷 글자·도표를 읽는 것입니다. 외부 이미지 URL, GIF/APNG 애니메이션, WebP, 영상, 스캔 PDF, 별도 OCR 엔진은 지원하지 않습니다. 이미지 분석 결과는 `derived_image_interpretation`이며 원문 텍스트 또는 정확한 OCR의 증거가 아닙니다. 작은 글자·차트 축·수치가 불확실하면 반드시 명시하고 원본과 대조해야 합니다.

현재 독립 모듈은 `shookie/src/tools/images/`에 구현되어 있습니다. 취소 작업과 충돌을 피하려고 공유 main 등록·프롬프트·handlers·첨부 권한 브리지 변경은 main 승인/기준 SHA 확인 전까지 보류합니다. 이 단계에서 실제 bot에 등록되었다거나 실제 Slack/DeepSeek E2E가 성공했다고 주장하지 않습니다.

## 권한과 데이터 경계

- 도구 인자는 `fileId`, `messageTs`, 선택적 루트 `threadTs`, 최대 1000자의 `question`뿐입니다. channel/user/token/URL/base64/model/config/signal을 모델 인자로 받지 않습니다.
- 기존 `AuthorizeAttachment` capability를 주입하여 요청자의 live WeakMap 신원, 현재 채널 접근, 정확한 message→file 관계, `files.info`, 재검증을 재사용합니다. bot이 파일을 읽을 수 있다는 사실만으로 권한을 부여하지 않습니다.
- 기존 `downloadAttachment`의 Slack-only URL·DNS public-address pinning·크기·시간·redirect 제한과 기존 bot token을 그대로 사용합니다. 새 다운로드 구현을 복사하지 않습니다.
- 현 첨부 권한 브리지는 텍스트 MIME만 허용하므로 이미지용 trusted MIME 검증 policy를 선택할 수 있는 최소 확장이 필요합니다. 기존 텍스트 policy의 기본값/허용 범위는 바꾸지 않습니다.
- Slack private URL, token, 파일명 등 메타데이터는 이미지 분석 모델에 전달하지 않습니다. inline 이미지 bytes만 이미지 user block으로 보냅니다. 반환값은 bounded 해석, file/channel/message 출처, 이미지 크기, 한계뿐이며 URL/base64/credentials는 포함하지 않습니다.
- 이미지 내용·사용자 question은 비신뢰 데이터입니다. 고정 system 프롬프트와 분리되며 이미지 분석 호출에는 tools가 없습니다. 파생 해석도 main의 지시/권한/승인으로 승격시키지 않습니다.
- 통합 단계에서 `slack_analyze_image`를 기존 첨부 도구와 동일하게 **도구 인자·결과 로그/DB 기록 및 progress 미리보기에서 redaction**해야 합니다. 해석을 사용자에게 답변하는 것과 민감 도구 body를 운영 로그에 남기는 것은 별개입니다.

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

`header.ts`는 inflate·decode·render·실행을 하지 않습니다. PNG signature, chunk bounds/CRC/order/IHDR/color/depth, IDAT zlib prefix, IEND와 JPEG SOI/segment bounds, 8-bit baseline/progressive frame dimensions/components, quantization/Huffman tables, SOS, bounded entropy marker walk, EOI를 검사합니다. APNG, unsupported critical chunks/JPEG variants, MIME mismatch, 크기 초과, 구조 손상은 차단합니다. **헤더 구조 검사이지 전체 압축 pixel stream의 유효성 보증이 아닙니다.** 헤더가 유효해도 실제 디코딩이 실패할 수 있으며 remote 오류는 fail-closed합니다. 압축 해제 폭탄은 로컬에서 해제하지 않는 방식으로 회피하고 raster 크기는 사전 제한합니다.

## 현재 SDK가 아닌 독립 전송을 쓰는 이유

공식 [DeepSeek Vision 가이드](https://api-docs.deepseek.com/guides/vision/)는 `deepseek-flash`에서 OpenAI-compatible `/chat/completions`의 user content 배열에 text와 inline base64 `image_url` block을 지원한다고 설명합니다. 하지만 설치된 `@ai-sdk/deepseek@2.0.35`의 `dist/index.js`의 `convertToDeepSeekChatMessages`는 user parts에서 `part.type === "text"`만 연결하고 나머지는 unsupported warning만 추가한 뒤 버립니다.

`transport.test.ts`는 설치된 SDK를 실제 호출하되 fetch를 synthetic으로 대체합니다. 표준 image `file` part(`mediaType: image/png`, bytes)를 넣었을 때 **실제 outgoing JSON이 text-only**이고 `user message part type: file` unsupported warning이 생김을 검증합니다. 문서 지원만 보고 SDK 전달 성공으로 오인하지 않습니다.

별도 `transport.ts`는 기존 `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` 값만 사용하는 최소 tool-free OpenAI-compatible HTTPS POST 경로입니다. main/provider/global model 설정이나 package deps를 바꾸지 않습니다. server의 trusted HTTPS config endpoint(`/` 또는 `/v1`)만 사용하며 URL userinfo/query/fragment/alternate port와 private DNS를 차단하고 DNS를 socket에 pinning합니다. redirect는 전부 거절하고 압축 response, API unsupported/error, malformed/refused/tool-return 응답은 정직하게 실패합니다. 텍스트-only 재시도나 다른 모델로의 fallback은 없습니다.

각 전송은 자체 deadline과 호출자의 AbortSignal을 결합하여 실제 request/socket을 abort합니다. synthetic HTTP endpoint 테스트는 header stall/body stall/deadline에 실제 열린 socket이 종료되는 것을 검증합니다. 현재 독립 단계의 `readImage`는 signal을 수신하여 전후 abort 체크 및 이미지 API에 전달합니다. **기존 Slack downloader에는 아직 parent signal 입력이 없어 진행 중 다운로드 자체 취소는 공유 통합 단계에서 추가해야 합니다.** main의 3분 request signal과 trusted accessor를 사용하고 handler 취소 후 결과/후속 호출이 생기지 않도록 통합 테스트가 필요합니다.

## 검증 구분과 실제 E2E 계획

실행한 독립 테스트는 synthetic PNG/JPEG 컨테이너·API 응답, exact outgoing JSON, installed SDK drop regression, 크기/헤더/오류/권한 capability 재사용 경계, redirect/response/output budget, DNS/header/body stall, 실제 local socket abort를 검증합니다. 이는 실제 DeepSeek의 이미지 인식 품질이나 Slack scope를 증명하지 않습니다.

공유 연결 승인 이후 실제 bot 등록/현재 채널 권한 브리지/요청자 context/signal/log redaction을 synthetic integration으로 추가 검증합니다. 실제 Slack/DeepSeek E2E는 **미실시**이며 main과 사용자가 승인한 범위에서만 다음과 같이 별도 진행합니다.

1. main이 지정한 기존 접근 가능 테스트 채널/스레드에 민감 정보 없는 작은 PNG(큰 고유 글자·색 도형·간단한 막대 도표)를 사용자가 첨부합니다.
2. 기존 bot token 및 LLM config로 그 정확한 메시지의 첨부에 대해 설명/글자/도표를 요청합니다. 새 token 발급·scope·모델·환경설정 변경은 하지 않습니다.
3. 원본과 해석을 대조하고 file/message 출처·불확실성·오독을 기록합니다. 운영 로그/DB에 inline bytes/token/private URL이 없고 tool input/output은 redacted인지 확인합니다. 비밀 원문·이미지 bytes·API bodies는 검사 기록에 복사하지 않습니다.
4. API image-unsupported/error라면 그대로 실패로 기록하며 SDK success 또는 시각 인식 success로 포장하지 않습니다. 권한 없는 다른 file relation이 차단되는지도 승인된 테스트 범위에서 확인합니다.
