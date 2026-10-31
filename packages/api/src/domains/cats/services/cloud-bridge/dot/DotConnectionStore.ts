import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type DotConnectionState, dotConnectionStateSchema } from './dot-connection-state.js';

/** One Host owns the connection record. Plugin lifecycle remains in Host inventory. */
export class DotConnectionStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  async read(): Promise<DotConnectionState | null> {
    await this.pending;
    return this.readFile();
  }

  update<T>(
    change: (state: DotConnectionState | null) => Promise<{ state: DotConnectionState; result: T }>,
  ): Promise<T> {
    const work = this.pending.then(async () => {
      const { state, result } = await change(await this.readFile());
      const validated = dotConnectionStateSchema.parse(state);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(validated)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
      }
      return result;
    });
    this.pending = work.catch(() => undefined);
    return work;
  }

  private async readFile(): Promise<DotConnectionState | null> {
    try {
      return dotConnectionStateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
}
