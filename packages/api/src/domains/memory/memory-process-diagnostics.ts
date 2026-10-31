import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const MAX_TAIL_BYTES = 8192;
export function memoryProcessStderrBoundary(token: string, id: number, phase: 'begin' | 'end'): string {
  return `\u001e${token}:${id}:${phase}\u001f`;
}

/** IPC and stderr are separate streams. Explicit frames prevent delayed stderr
 * bytes from the previous request leaking into a later request's crash report. */
export class MemoryProcessDiagnostics {
  readonly token = randomBytes(12).toString('hex');
  private expected?: number;
  private active?: number;
  private seenFrame = false;
  private pending = '';
  private bytes = Buffer.alloc(0);
  private readonly decoder = new StringDecoder('utf8');
  private readonly boundary = new RegExp(`\u001e${this.token}:(\\d+):(begin|end)\u001f`);

  constructor(stream: Readable) {
    stream.on('data', (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
    stream.on('end', () => {
      this.consume(this.decoder.end());
      this.capture(this.pending);
      this.pending = '';
    });
  }

  begin(id: number): void {
    this.expected = id;
    this.bytes = Buffer.alloc(0);
  }

  finish(id: number): void {
    if (this.expected !== id) return;
    this.expected = undefined;
    this.bytes = Buffer.alloc(0);
  }

  tail(id: number): string {
    if (this.expected !== id) return '';
    let start = 0;
    while (start < this.bytes.length && (this.bytes[start]! & 0xc0) === 0x80) start++;
    return this.bytes.subarray(start).toString('utf8');
  }

  private consume(text: string): void {
    this.pending += text;
    for (;;) {
      const match = this.boundary.exec(this.pending);
      if (!match) break;
      this.capture(this.pending.slice(0, match.index));
      this.seenFrame = true;
      this.active = match[2] === 'begin' ? Number(match[1]) : undefined;
      this.pending = this.pending.slice(match.index + match[0].length);
    }
    // Retain enough bytes to recognize a boundary split across stream chunks.
    const keep = this.token.length + 40;
    if (this.pending.length > keep) {
      this.capture(this.pending.slice(0, -keep));
      this.pending = this.pending.slice(-keep);
    }
  }

  private capture(text: string): void {
    if (this.expected === undefined || (this.seenFrame && this.active !== this.expected)) return;
    const combined = Buffer.concat([this.bytes, Buffer.from(text)]);
    this.bytes = combined.subarray(Math.max(0, combined.length - MAX_TAIL_BYTES));
  }
}
