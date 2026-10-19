import { closeSync, fsyncSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Flush a published file's parent on platforms supporting directory handles.
 * Windows retains file fsync + same-directory rename, with weaker power-loss
 * durability for the directory entry. Other platforms must surface IO failures.
 * Keep this synchronous: the root writers run under a SQLite transaction mutex.
 */
export function flushParentDirectorySync(path: string): void {
  if (process.platform === 'win32') return;
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
