import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_CLI_RAW_ARCHIVE_DIR = './data/cli-raw-archive';
const INVOCATION_ID_PATTERN = /^[\w-]+$/;

export interface RawArchiveEntry {
  readonly timestamp: number;
  readonly payload: unknown;
}

export class CliRawArchive {
  private readonly archiveDir: string;
  private readonly readyDirs = new Set<string>();
  private readonly initInFlight = new Map<string, Promise<void>>();

  constructor(options?: { archiveDir?: string }) {
    this.archiveDir = options?.archiveDir ?? process.env.CLI_RAW_ARCHIVE_DIR ?? DEFAULT_CLI_RAW_ARCHIVE_DIR;
  }

  /** F118: Get the archive file path for a given invocationId (today's date) */
  getPath(invocationId: string): string {
    const day = this.formatDate(new Date());
    return join(this.archiveDir, day, `${invocationId}.ndjson`);
  }

  async append(invocationId: string, payload: unknown): Promise<void> {
    if (!INVOCATION_ID_PATTERN.test(invocationId)) {
      throw new Error(`Invalid invocationId for archive: ${invocationId}`);
    }

    const timestamp = Date.now();
    const day = this.formatDate(new Date(timestamp));
    const dir = join(this.archiveDir, day);
    const file = join(dir, `${invocationId}.ndjson`);
    const entry: RawArchiveEntry = { timestamp, payload };

    await this.ensureDir(this.archiveDir);
    await this.ensureDir(dir);
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf-8');
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
