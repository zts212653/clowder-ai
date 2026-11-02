import { closeSync, lstatSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, toNamespacedPath } from 'node:path';
import type { PiSessionSlot } from './pi-session-store.js';

interface WriterLease {
  exec(sql: string): void;
  close(): void;
}

/** Share the writer's real OS lease with cold-resume diagnostics. */
export function acquirePiWriterLease(slot: PiSessionSlot) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Persistent Pi requires Node 24 or newer');
  const path = join(slot.directory, 'writer-lock.sqlite');
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Pi writer lock must be a regular file');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string, options: { timeout: number }) => WriterLease;
  };
  const database = new DatabaseSync(process.platform === 'win32' ? toNamespacedPath(path) : path, { timeout: 0 });
  try {
    database.exec('BEGIN EXCLUSIVE');
  } catch {
    database.close();
    throw new Error('Pi 原生会话已有活跃写者占用；原历史已保留，请等待原进程退出。');
  }
  return database;
}
