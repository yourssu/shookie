import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parserProgram } from './worker-source.js';
import { parseAttachment } from './parser.js';
import { ATTACHMENT_LIMITS as L } from './policy.js';
import { pdfFixture } from './fixtures.test-helper.js';

function run(program: string, body: Buffer, args: string[] = []): Promise<{ error?: string; text?: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--input-type=module', '-e', program, ...args],
      { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' }, timeout: 3000, maxBuffer: 8192 },
      (error, stdout) => {
        // A timeout/heap/crash is a TEST FAILURE, never evidence that preflight refused the input.
        if (error) return reject(error);
        try { resolve(JSON.parse(stdout.trim().split('\n').at(-1)!)); } catch (parseError) { reject(parseError); }
      });
    child.stdin!.on('error', () => {}); child.stdin!.end(body);
  });
}
const pdfImport = "const { getDocument, PasswordResponses, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs');";
async function preflight(body: Buffer) {
  expect(parserProgram.split(pdfImport)).toHaveLength(2);
  // Test-only sentinel replaces the first PDF.js import. Reaching it is observable without
  // allowing any parser/predictor/native allocation to run on a malicious fixture.
  return run(parserProgram.replace(pdfImport, "fail('PDFJS_REACHED');"), body, [JSON.stringify(L), 'pdf']);
}
function streamFixture(entries: string, body = deflateSync(Buffer.from('x')), extraObjects = '') {
  return Buffer.concat([Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${body.length} ${entries} >>\nstream\n`),
    body, Buffer.from(`\nendstream\nendobj\n${extraObjects}\n%%EOF\n`)]);
}
async function rejectBeforePdfJs(body: Buffer) {
  await expect(parseAttachment(body, 'pdf')).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
  expect(await preflight(body)).toEqual({ error: 'UNSUPPORTED_TYPE' });
}
describe('PDF.js filter aliases and predictor parameters fail closed before parser entry', () => {
  it('diagnoses the actual installed worker precedence and predictor buffer arithmetic', async () => {
    const worker = await readFile(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'), 'utf8');
    expect(worker).toContain('let filter = dict.get("F", "Filter")');
    expect(worker).toContain('let params = dict.get("DP", "DecodeParms")');
    expect(worker).toContain('new PredictorStream(new FlateStream(stream, maybeLength), maybeLength, params)');
    expect(worker).toContain('params.get("Columns") || 1');
    expect(worker).toContain('columns * colors * bits + 7 >> 3');
    expect(worker).toContain('this.ensureBuffer(bufferLength + rowBytes)');
  });
  it.each([
    ['/F /FlateDecode', 'alias-only'],
    ['/F /Fl', 'alias-only Fl shorthand'],
    ['/F /DCTDecode', 'unsupported alias filter'],
    ['/F /FlateDecode /Filter /DCTDecode', 'F wins over conflicting Filter'],
    ['/F /DCTDecode /Filter /FlateDecode', 'Filter must not conceal unsupported F'],
    ['/Filter /FlateDecode /F null', 'null F presence'],
    ['/F 20 0 R /Filter /FlateDecode', 'indirect F'],
    ['/Filter /Fl', 'canonical Fl shorthand remains unsupported'],
  ])('rejects %s (%s)', async (entries) => {
    // Oversized Flate output cannot be mistaken for a heap/decompression refusal: the expected
    // code is the deterministic subset UNSUPPORTED_TYPE, at the before-import sentinel.
    const bomb = deflateSync(Buffer.alloc(L.inflatedStreamBytes + 1, 32));
    await rejectBeforePdfJs(streamFixture(entries, bomb, '20 0 obj\n/FlateDecode\nendobj'));
  });
  it.each([
    '/DP << /Predictor 12 /Columns 100000000 /Colors 4 /BitsPerComponent 8 >>',
    '/DecodeParms << /Predictor 2 /Columns 100000000 /Colors 4 /BitsPerComponent 16 >>',
    '/DP [<< /Predictor 15 /Columns 100000000 >>]',
    '/DecodeParms [<< /Predictor 12 /Columns 100000000 >>]',
    '/DP 20 0 R',
    '/DecodeParms 20 0 R',
    '/DP << /Predictor 21 0 R /Columns 22 0 R >>',
    '/DP null',
    '/DecodeParms null',
  ])('rejects predictor/parameter key regardless of value: %s', async (parameters) => {
    const extra = '20 0 obj\n<< /Predictor 12 /Columns 100000000 >>\nendobj\n21 0 obj\n12\nendobj\n22 0 obj\n100000000\nendobj';
    // Tiny zlib output with huge predictor dimensions: never enter PDF.js and never use
    // a CPU/heap guard as the success criterion. Canonical filter-array forms are covered too.
    for (const filter of ['/FlateDecode', '[/FlateDecode]'])
      await rejectBeforePdfJs(streamFixture(`/Filter ${filter} ${parameters}`, undefined, extra));
  });
  it('keeps indirect length/filter/filter-array refs and escaped names rejected before PDF.js', async () => {
    const indirectLength = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Length 20 0 R /Filter /FlateDecode >>\nstream\nx\nendstream\nendobj\n20 0 obj\n1\nendobj\n%%EOF');
    await expect(parseAttachment(indirectLength, 'pdf')).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
    expect(await preflight(indirectLength)).toEqual({ error: 'PARSER_LIMIT' });
    for (const filter of ['20 0 R', '[20 0 R]', '[/FlateDecode /FlateDecode]'])
      await rejectBeforePdfJs(streamFixture(`/Filter ${filter}`, undefined, '20 0 obj\n/FlateDecode\nendobj'));
    const escaped = streamFixture('/#46 /FlateDecode');
    await expect(parseAttachment(escaped, 'pdf')).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
    expect(await preflight(escaped)).toEqual({ error: 'PARSER_LIMIT' });
  });
  it('keeps literal/comment/hex occurrences opaque and normal compressed text extraction supported', async () => {
    const normal = pdfFixture(['Safe compressed text'], { compressed: true,
      streamExtras: '/Trap (obj /F /FlateDecode /DP /DecodeParms >> stream) /Hex <2f46202f4450202f4465636f64655061726d73>\n% /F /DP /DecodeParms\n' });
    expect(await preflight(normal)).toEqual({ error: 'PDFJS_REACHED' });
    expect((await parseAttachment(normal, 'pdf')).units[0].text).toBe('Safe compressed text');
  });
  it('confirms installed PDF.js actually prefers F and DP on harmless tiny diagnostic PDFs', async () => {
    // Diagnostic only, not a production allowance: tiny data, no large predictor dimensions.
    const diagnostic = String.raw`
      import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
      const chunks = []; for await (const c of process.stdin) chunks.push(c);
      const doc = await getDocument({ data: new Uint8Array(Buffer.concat(chunks)), isEvalSupported: false,
        useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, enableXfa: false,
        stopAtErrors: true, verbosity: VerbosityLevel.ERRORS }).promise;
      const page = await doc.getPage(1); const content = await page.getTextContent();
      console.log(JSON.stringify({ text: content.items.filter(i => typeof i.str === 'string').map(i => i.str).join(' ') }));
      await doc.destroy();`;
    const fWins = pdfFixture(['F preferred'], { compressed: true, streamFilter: '/DCTDecode', streamExtras: '/F /FlateDecode' });
    expect(await run(diagnostic, fWins)).toEqual({ text: 'F preferred' });
    const dpWins = pdfFixture(['DP preferred'], { compressed: true,
      streamExtras: '/DP << /Predictor 1 >> /DecodeParms << /Predictor 9 >>' });
    expect(await run(diagnostic, dpWins)).toEqual({ text: 'DP preferred' });
    await rejectBeforePdfJs(fWins); await rejectBeforePdfJs(dpWins);
  });
});
