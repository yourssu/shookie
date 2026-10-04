# 합성 PDF fixture

`encrypted.pdf`는 `pdfFixture(['Encrypted fixture text'])`로 만든 합성 원문을 qpdf로 AES-256 암호화한 실제 암호화 PDF이다. 테스트용 비민감 암호는 `synthetic-password`, owner 암호는 `synthetic-owner`이다. 개인정보·Slack 첨부·credential이 아니다.

생성: `qpdf --encrypt synthetic-password synthetic-owner 256 -- plain.pdf encrypted.pdf`

다른 PDF fixture는 `fixtures.test-helper.ts`에서 직접 생성한다. `scanned:true`는 Flate로 압축한 1x1 이미지 XObject만 그리는 이미지-only PDF이다. 실제 문서 OCR이나 Slack 파일 E2E를 수행하지 않는다.
