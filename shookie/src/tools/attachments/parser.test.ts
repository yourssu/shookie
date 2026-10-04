import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { parseAttachment } from './parser.js';
import { ATTACHMENT_LIMITS as L } from './policy.js';
import { pdfFixture } from './fixtures.test-helper.js';
describe('isolated attachment parser (synthetic)', () => {
  it('preserves Unicode, Markdown whitespace and line citations', async () => {
    expect((await parseAttachment(Buffer.from('# 한글 😀\r\n a  b\n'), 'text')).units).toEqual([
      { start: 1, end: 1, text: '# 한글 😀' }, { start: 2, end: 2, text: ' a  b' }, { start: 3, end: 3, text: '' }]);
  });
  it('parses quoted multiline CSV and escaped quotes as data, not formulas', async () => {
    const result = await parseAttachment(Buffer.from('name,value\r\n"a,b","first\nsecond"\n"a""b",=HYPERLINK(""x"")'), 'csv').catch(e => e);
    expect(result.code).toBe('INVALID_CSV');
    const valid = await parseAttachment(Buffer.from('name,value\r\n"a,b","first\nsecond"\n"a""b","=1+1"'), 'csv');
    expect(valid.units[1]).toEqual({ start: 2, end: 3, cells: ['a,b', 'first\nsecond'] });
    expect(valid.units[2]).toEqual({ start: 4, end: 4, cells: ['a"b', '=1+1'] });
  });
  it('rejects invalid UTF8, binary signatures and CSV malformed quotes', async () => {
    await expect(parseAttachment(Buffer.from([0xc3, 0x28]), 'text')).rejects.toMatchObject({ code: 'INVALID_UTF8' });
    for (const body of [Buffer.from('%PDF-1.7'), Buffer.from('PK\x03\x04'), Buffer.from('\x00hello')])
      await expect(parseAttachment(body, 'text')).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    await expect(parseAttachment(Buffer.from('a,"unclosed'), 'csv')).rejects.toMatchObject({ code: 'INVALID_CSV' });
  });
  it('enforces input/output, rows, columns and UTF8 cell limits', async () => {
    await expect(parseAttachment(Buffer.alloc(L.fileBytes + 1), 'text')).rejects.toMatchObject({ code: 'FILE_LIMIT' });
    for (const csv of ['a\n'.repeat(L.csvRows + 1), 'a,'.repeat(L.csvCols) + 'a', '가'.repeat(6000)])
      await expect(parseAttachment(Buffer.from(csv), 'csv')).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
    await expect(parseAttachment(Buffer.from('x'.repeat(L.parsedBytes + 1)), 'text')).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  });
  it('extracts multiple compressed PDF pages with page citations and reports empty pages', async () => {
    const result = await parseAttachment(pdfFixture(['Page one', '', 'Page three'], { compressed: true }), 'pdf');
    expect(result.units.map(p => [p.page, p.text])).toEqual([[1, 'Page one'], [2, ''], [3, 'Page three']]);
    expect(result.emptyPages).toEqual([2]);
  });
  it('rejects real encrypted fixture, blank/image-only, invalid signatures and excess PDF pages', async () => {
    const encrypted = await readFile(new URL('./fixtures/encrypted.pdf', import.meta.url));
    await expect(parseAttachment(encrypted, 'pdf')).rejects.toMatchObject({ code: 'ENCRYPTED_PDF' });
    await expect(parseAttachment(pdfFixture([''], { scanned: true, compressed: true }), 'pdf')).rejects.toMatchObject({ code: 'NO_TEXT_PDF' });
    await expect(parseAttachment(pdfFixture(['secret'], { encrypted: true }), 'pdf')).rejects.toMatchObject({ code: 'ENCRYPTED_PDF' });
    await expect(parseAttachment(pdfFixture(['', '']), 'pdf')).rejects.toMatchObject({ code: 'NO_TEXT_PDF' });
    await expect(parseAttachment(Buffer.from('not a pdf'), 'pdf')).rejects.toMatchObject({ code: 'INVALID_PDF' });
    await expect(parseAttachment(pdfFixture(Array(51).fill('text')), 'pdf')).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  });
  it('bounds Flate decompression and rejects indirect/escaped filters', async () => {
    const compressed = deflateSync(Buffer.alloc(L.inflatedStreamBytes + 1, 32));
    const bomb = Buffer.concat([Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`), compressed, Buffer.from('\nendstream\nendobj\n%%EOF')]);
    await expect(parseAttachment(bomb, 'pdf')).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
    for (const [filter, code] of [['/Filter 2 0 R', 'UNSUPPORTED_TYPE'], ['/F#69lter /FlateDecode', 'PARSER_LIMIT']]) {
      const bad = Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length 1 ${filter} >>\nstream\nx\nendstream\n%%EOF`);
      await expect(parseAttachment(bad, 'pdf')).rejects.toMatchObject({ code });
    }
    // Literal strings cannot forge dictionary boundaries, filter names or lengths.
    const forged = Buffer.concat([Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode /Trap (obj /Length ${compressed.length} >> stream) >>\nstream\n`), compressed, Buffer.from('\nendstream\nendobj\n%%EOF')]);
    await expect(parseAttachment(forged, 'pdf')).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  });
});
