import { expect, it } from 'vitest';
import { projectEventAttachments } from './event-metadata.js';
const source = { channelId: 'C1', messageTs: '1700000000.000001', threadTs: '1700000000.000001' };
it('projects only safe candidate metadata, never URLs/images/credentials, with UTF8 bounds and explicit omissions', () => {
  const result = projectEventAttachments(Array.from({ length: 30 }, (_, i) => ({ id: `F${i}`, name: '😀'.repeat(200),
    mimetype: 'text/plain', size: 10, url_private: 'PRIVATE', thumb_360: 'PRIVATE', token: 'SECRET' })), source);
  expect(result.files.length).toBeLessThanOrEqual(20); expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8000);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|\ufffd/u);
  expect(result.files[0]).toEqual({ fileId: 'F0', name: '😀'.repeat(64), mimetype: 'text/plain', size: 10 });
});
it('rejects malformed IDs, duplicate metadata and invalid sizes without converting them into authority', () => {
  const result = projectEventAttachments([null, { id: 'not-a-file' }, { id: 'F123', size: -1 }, { id: 'F123' }], source);
  expect(result.files).toEqual([{ fileId: 'F123', name: null, mimetype: null, size: null }]);
  expect(result.truncated).toBe(true); expect(result.notice).toContain('권한');
});
