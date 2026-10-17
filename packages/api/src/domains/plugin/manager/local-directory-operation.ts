import type { Dirent } from 'node:fs';
import { open, opendir } from 'node:fs/promises';

// Directory admission packs a complete dependency graph, rather than inspecting one
// archive. Allow bounded preparation time for those sequential npm operations.
const DIRECTORY_PREPARATION_DEADLINE_MS = 5 * 60_000;

export class LocalDirectorySourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LocalDirectorySourceError';
  }
}

/** One lifetime and work budget, beginning before the first source read. */
export class LocalDirectoryOperation {
  readonly signal: AbortSignal;
  private edges = 0;
  private work = 0;

  constructor(signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(DIRECTORY_PREPARATION_DEADLINE_MS);
    this.signal = signal ? AbortSignal.any([deadline, signal]) : deadline;
    this.check();
  }

  check(): void {
    this.signal.throwIfAborted();
  }

  addEdges(count: number): void {
    this.check();
    this.edges += count;
    if (this.edges > 4_096) this.limit('source dependency edge budget exceeded');
  }

  step(): void {
    this.check();
    if (++this.work > 262_144) this.limit('directory preparation work budget exceeded');
  }

  private limit(message: string): never {
    throw new LocalDirectorySourceError('DEPENDENCY_PREPARATION_LIMIT', message);
  }

  async io<T>(action: () => Promise<T>): Promise<T> {
    this.step();
    // Do not race and abandon filesystem work: finish the in-flight syscall,
    // then observe cancellation before scheduling more work or publishing bytes.
    try {
      const value = await action();
      this.check();
      return value;
    } catch (error) {
      this.check();
      throw error;
    }
  }

  async entries(path: string): Promise<Dirent[]> {
    this.step();
    const directory = await opendir(path);
    try {
      const entries: Dirent[] = [];
      // A single unbounded readdir would allocate the whole directory before
      // the work budget could reject it. Enumerate and account incrementally.
      for (;;) {
        const entry = await this.io(() => directory.read());
        if (!entry) return entries;
        entries.push(entry);
      }
    } finally {
      await directory.close();
    }
  }

  async open(path: string, flags: number): ReturnType<typeof open> {
    this.step();
    const handle = await open(path, flags);
    try {
      this.check();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}
