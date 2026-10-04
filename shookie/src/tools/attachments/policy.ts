export const ATTACHMENT_LIMITS = Object.freeze({ fileBytes: 4 * 1024 * 1024, downloadMs: 10_000,
  redirects: 2, parserMs: 5_000, parserHeapMb: 128, inflatedStreamBytes: 2 * 1024 * 1024,
  inflatedTotalBytes: 8 * 1024 * 1024, pdfPages: 50, csvRows: 10_000, csvCols: 100,
  cellBytes: 16_384, units: 100_000, parsedBytes: 1024 * 1024, outputBytes: 32_768 });
export type AttachmentCode = 'ACCESS_DENIED' | 'MISSING_SCOPE' | 'DOWNLOAD_FAILED' | 'UNSAFE_URL' |
  'FILE_LIMIT' | 'UNSUPPORTED_TYPE' | 'INVALID_UTF8' | 'INVALID_CSV' | 'ENCRYPTED_PDF' |
  'NO_TEXT_PDF' | 'PARSER_LIMIT' | 'INVALID_PDF';
export class AttachmentError extends Error {
  constructor(public readonly code: AttachmentCode) { super(code); }
}
export type AttachmentKind = 'text' | 'csv' | 'pdf';
export function attachmentKind(mime: string): AttachmentKind {
  const charset = /;\s*charset\s*=\s*"?([^;"\s]+)/iu.exec(mime)?.[1];
  if (charset && !/^utf-?8$/iu.test(charset)) throw new AttachmentError('INVALID_UTF8');
  const type = mime.split(';')[0].trim().toLowerCase();
  if (['text/plain', 'text/markdown', 'text/x-markdown'].includes(type)) return 'text';
  if (['text/csv', 'application/csv'].includes(type)) return 'csv';
  if (type === 'application/pdf') return 'pdf';
  throw new AttachmentError('UNSUPPORTED_TYPE');
}
export type ParsedUnit = { start: number; end: number; text?: string; cells?: string[]; page?: number };
export type ParsedAttachment = { kind: AttachmentKind; units: ParsedUnit[]; totalUnits: number; emptyPages?: number[] };
export type AttachmentMetadata = { id: string; name: string; mimetype: string; size: number; url_private_download: string };
export type AttachmentSource = { fileId: string; name: string; channelId: string; messageTs: string };
// This capability must be supplied by the trusted Slack actor/client bridge, never model arguments.
export type AuthorizedAttachment = { file: AttachmentMetadata; channelId: string; messageTs: string };
export type AuthorizeAttachment = (fileId: string, messageTs: string) => Promise<AuthorizedAttachment>;
export function failure(error: unknown) {
  const code = error instanceof AttachmentError ? error.code : 'DOWNLOAD_FAILED';
  const messages: Record<AttachmentCode, string> = {
    ACCESS_DENIED: '현재 요청 채널의 메시지 첨부와 요청자 접근 권한을 확인하지 못했습니다.',
    MISSING_SCOPE: 'Slack 앱의 files:read 등 읽기 권한이 필요합니다. 운영자에게 권한 확인을 요청해 주세요.',
    DOWNLOAD_FAILED: 'Slack 첨부를 읽지 못했습니다. 잠시 후 다시 시도해 주세요.',
    UNSAFE_URL: '허용된 Slack 다운로드 주소가 아니므로 파일을 읽지 않았습니다.',
    FILE_LIMIT: '파일이 최대 4 MiB 한도를 초과합니다. 작은 파일로 나눠 주세요.',
    UNSUPPORTED_TYPE: 'UTF-8 텍스트·Markdown·CSV·텍스트 PDF만 지원합니다. 이미지/OCR·영상·Office는 지원하지 않습니다.',
    INVALID_UTF8: '유효한 UTF-8 텍스트가 아닙니다. UTF-8로 저장해 다시 첨부해 주세요.',
    INVALID_CSV: 'CSV 인용부호 또는 행·열 형식이 올바르지 않습니다.',
    ENCRYPTED_PDF: '암호화된 PDF는 지원하지 않습니다.',
    NO_TEXT_PDF: 'PDF에서 텍스트를 찾지 못했습니다. 빈 문서 또는 스캔 PDF이며 OCR은 지원하지 않습니다.',
    PARSER_LIMIT: '안전한 파싱 시간·압축 해제·페이지·행·열·셀·텍스트 한도를 초과했습니다. 파일을 나눠 주세요.',
    INVALID_PDF: '지원하는 텍스트 PDF로 해석하지 못했습니다.',
  };
  return { ok: false as const, error: { code, message: messages[code] }, limits: ATTACHMENT_LIMITS };
}
