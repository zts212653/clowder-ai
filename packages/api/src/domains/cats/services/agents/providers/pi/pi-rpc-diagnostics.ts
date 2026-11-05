import { StringDecoder } from 'node:string_decoder';
import { SANITIZER_PATTERNS } from '../../../../../../utils/cli-error-patterns.js';
import { sanitizeCliStderr } from '../../../../../../utils/sanitize-cli-stderr.js';

/** Sanitize complete lines, discard oversized lines, and suppress whole PEM blocks before truncation. */
export class PiRpcDiagnostics {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private dropping = false;
  private tail = '';
  private marker = '';
  private pem = false;
  private pemEnding = false;
  constructor(private readonly maxLength = 1000) {}
  write(chunk: Buffer): void {
    this.accept(this.decoder.write(chunk));
  }
  private scanMarkers(part: string): void {
    // Scan even discarded oversized lines. A bounded carry catches markers split across chunks.
    const raw = this.marker + part;
    const scan = raw.normalize('NFKC').replace(SANITIZER_PATTERNS.ansiCsi, '').replace(SANITIZER_PATTERNS.osc, '');
    const begin = scan.lastIndexOf('-----BEGIN ');
    const end = scan.lastIndexOf('-----END ');
    if (begin >= 0) {
      if (!this.pem) this.tail = `${this.tail}[PEM_REDACTED]\n`.slice(-this.maxLength);
      this.pem = true;
      this.pemEnding = end > begin;
    } else if (this.pem && end >= 0) this.pemEnding = true;
    this.marker = raw.slice(-256);
  }
  private accept(text: string): void {
    for (const part of text.split(/(?<=\n)/)) {
      this.scanMarkers(part);
      if (this.pem) {
        this.pending = '';
        this.dropping = true;
      } else if (!this.dropping) {
        if (this.pending.length + part.length > 16384) {
          this.pending = '';
          this.dropping = true;
        } else this.pending += part;
      }
      if (part.endsWith('\n')) {
        if (!this.dropping) this.commit();
        this.dropping = false;
        this.marker = '';
        if (this.pemEnding) this.pem = false;
        this.pemEnding = false;
      }
    }
  }
  end(): void {
    this.accept(this.decoder.end());
    if (!this.dropping) this.commit();
    this.pending = '';
  }
  private commit(): void {
    this.tail = (this.tail + sanitizeCliStderr(this.pending)).slice(-this.maxLength);
    this.pending = '';
  }
  context(): string {
    return this.tail.trim() ? `: ${this.tail.trim()}` : '';
  }
}

/** Apply the same incomplete-PEM and oversize protection to every visible Pi error channel. */
export function piErrorExcerpt(input: string, maxLength = 1000): string {
  const diagnostics = new PiRpcDiagnostics(maxLength);
  diagnostics.write(Buffer.from(input, 'utf8'));
  diagnostics.end();
  return diagnostics.context().slice(2) || 'Pi returned an empty or oversized error';
}
