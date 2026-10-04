import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ATTACHMENT_LIMITS as L, AttachmentError, type AttachmentKind, type ParsedAttachment } from './policy.js';
import { parserProgram } from './worker-source.js';
const parsedSchema = z.object({ kind: z.enum(['text', 'csv', 'pdf']),
  units: z.array(z.object({ start: z.number().int().positive(), end: z.number().int().positive(),
    text: z.string().optional(), cells: z.array(z.string()).optional(), page: z.number().int().positive().optional() })).max(L.units),
  totalUnits: z.number().int().min(0).max(L.units), emptyPages: z.array(z.number().int().positive()).max(L.pdfPages).optional() });
const codes = z.enum(['FILE_LIMIT', 'UNSUPPORTED_TYPE', 'INVALID_UTF8', 'INVALID_CSV', 'ENCRYPTED_PDF', 'NO_TEXT_PDF', 'PARSER_LIMIT', 'INVALID_PDF']);
let activeParsers = 0;
/** All formats run off-loop. Bounded stdin/stdout, V8 heap, no inherited environment credentials, hard wall kill. */
export async function parseAttachment(body: Buffer, kind: AttachmentKind): Promise<ParsedAttachment> {
  if (body.length > L.fileBytes) throw new AttachmentError('FILE_LIMIT');
  if (activeParsers >= 2) throw new AttachmentError('PARSER_LIMIT');
  activeParsers++;
  return new Promise<ParsedAttachment>((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${L.parserHeapMb}`, '--input-type=module',
      '-e', parserProgram, JSON.stringify(L), kind], { cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new AttachmentError('PARSER_LIMIT')); }, L.parserMs);
    const output: Buffer[] = []; let outputBytes = 0, done = false;
    function finish(error?: AttachmentError, value?: ParsedAttachment) {
      if (done) return; done = true; clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(value!);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > L.parsedBytes + 4096) return finish(new AttachmentError('PARSER_LIMIT'));
      output.push(Buffer.from(chunk));
    });
    child.on('error', () => finish(new AttachmentError('PARSER_LIMIT')));
    child.stdin.on('error', () => { /* Child close determines sanitized failure. */ });
    child.on('close', code => {
      if (done) return;
      if (code !== 0) return finish(new AttachmentError('PARSER_LIMIT'));
      try {
        // PDF.js diagnostic lines are not returned to the caller.
        const raw = JSON.parse(Buffer.concat(output).toString('utf8').trim().split('\n').at(-1)!);
        if (raw.error) return finish(new AttachmentError(codes.parse(raw.error)));
        const value = parsedSchema.parse(raw);
        if (value.kind !== kind || value.totalUnits !== value.units.length) throw new Error();
        finish(undefined, value);
      } catch { finish(new AttachmentError('PARSER_LIMIT')); }
    });
    child.stdin.end(body);
  }).finally(() => { activeParsers--; });
}
