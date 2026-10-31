import type { Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { migrateStoredProjectPath } from '../utils/persistent-project-path.js';

/** Share filesystem canonicalization for identical project roots within one
 * request only. A fresh request still observes changed paths and symlinks. */
export function createThreadProjectPathResolver(
  resolvePath: typeof migrateStoredProjectPath = migrateStoredProjectPath,
): (path: string) => Promise<string | null> {
  const paths = new Map<string, Promise<string | null>>();
  return (path) => {
    let pending = paths.get(path);
    if (!pending) {
      pending = resolvePath(path);
      paths.set(path, pending);
    }
    return pending;
  };
}

/** Bound route fan-out even when the full sidebar contract includes history. */
export async function mapThreadList<T>(threads: readonly Thread[], map: (thread: Thread) => Promise<T>): Promise<T[]> {
  const output: T[] = [];
  for (let offset = 0; offset < threads.length; offset += 64) {
    output.push(...(await Promise.all(threads.slice(offset, offset + 64).map(map))));
  }
  return output;
}
