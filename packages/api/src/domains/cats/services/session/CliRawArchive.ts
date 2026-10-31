import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { constants, createGunzip, gzip } from 'node:zlib';

const DEFAULT_CLI_RAW_ARCHIVE_DIR = './data/cli-raw-archive';
const INVOCATION_ID_PATTERN = /^[\w-]+$/;
const gzipAsync = promisify(gzip);

export interface RawArchiveEntry {
  readonly timestamp: number;
  readonly payload: unknown;
}

export class CliRawArchive {
  private readonly archiveDir: string;
  private readonly readyDirs = new Set<string>();
  private readonly initInFlight = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(options?: { archiveDir?: string }) {
    this.archiveDir = options?.archiveDir ?? process.env.CLI_RAW_ARCHIVE_DIR ?? DEFAULT_CLI_RAW_ARCHIVE_DIR;
  }

  /** F118: Get the archive file path for a given invocationId (today's date) */
  getPath(invocationId: string, date = new Date()): string {
    if (!INVOCATION_ID_PATTERN.test(invocationId)) throw new Error(`Invalid invocationId for archive: ${invocationId}`);
    const day = this.formatDate(date);
    return join(this.archiveDir, day, `${invocationId}.ndjson.gz`);
  }

  /** Legacy files stay untouched; a rollout can leave both parts of an invocation. */
  async *readLines(invocationId: string, date = new Date()): AsyncGenerator<string> {
    const compressed = this.getPath(invocationId, date);
    for (const file of [compressed.slice(0, -3), compressed]) {
      try {
        yield* readArchiveLines(file);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }

  async append(invocationId: string, payload: unknown): Promise<void> {
    if (!INVOCATION_ID_PATTERN.test(invocationId)) {
      throw new Error(`Invalid invocationId for archive: ${invocationId}`);
    }

    const timestamp = Date.now();
    const day = this.formatDate(new Date(timestamp));
    const dir = join(this.archiveDir, day);
    const file = this.getPath(invocationId, new Date(timestamp));
    const entry: RawArchiveEntry = { timestamp, payload };
    // Freeze the event at observation time; each append is a complete, standard gzip member.
    const json = `${JSON.stringify(entry)}\n`;
    const previous = this.writes.get(file) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const bytes = await gzipAsync(json, { level: constants.Z_BEST_SPEED });
        await this.ensureDir(this.archiveDir);
        await this.ensureDir(dir);
        await appendFile(file, bytes);
      });
    this.writes.set(file, write);
    try {
      await write;
    } finally {
      if (this.writes.get(file) === write) this.writes.delete(file);
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.readyDirs.has(dir)) return;

    const inFlight = this.initInFlight.get(dir);
    if (inFlight) {
      await inFlight;
      return;
    }

    const initializing = mkdir(dir, { recursive: true })
      .then(() => {
        this.readyDirs.add(dir);
      })
      .finally(() => {
        this.initInFlight.delete(dir);
      });

    this.initInFlight.set(dir, initializing);
    await initializing;
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

/** Stream decompression so provenance readers never need a whole expanded archive in memory. */
async function* readArchiveLines(file: string): AsyncGenerator<string> {
  const input = createReadStream(file);
  const output = new PassThrough();
  const completion = (file.endsWith('.gz') ? pipeline(input, createGunzip(), output) : pipeline(input, output)).then(
    () => undefined,
    (error: unknown) => error,
  );
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
    const error = await completion;
    if (error !== undefined) throw error;
  } finally {
    lines.close();
    input.destroy();
    output.destroy();
  }
}
