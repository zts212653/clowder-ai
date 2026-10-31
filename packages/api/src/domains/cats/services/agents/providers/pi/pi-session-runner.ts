import { closeSync, lstatSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piErrorExcerpt } from './pi-rpc-diagnostics.js';
import { assertPiHistoryIntegrity } from './pi-session-integrity.js';
import type { PiSessionSlot } from './pi-session-store.js';

interface WriterLease {
  exec(sql: string): void;
  close(): void;
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Persistent Pi requires Node 24 or newer');
  const [input, entry, ...args] = process.argv.slice(2);
  if (!input || !entry) throw new Error('Pi writer launch is incomplete');
  const slot = JSON.parse(input) as PiSessionSlot;
  const path = join(slot.directory, 'writer-lock.sqlite');
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Pi writer lock must be a regular file');
  // Same OS transaction pattern as inventory writer leases; no native-addon ABI dependency.
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
  // Keep a strong reference throughout the real Pi lifetime (including after the bridge dies).
  process.once('exit', () => database.close());
  await assertPiHistoryIntegrity(slot);
  process.argv = [process.execPath, entry, ...args];
  await import(pathToFileURL(entry).href);
} catch (error) {
  // Never emit module paths, argv, raw loader/SQLite errors or credentials.
  const message =
    error instanceof Error && /^(?:Pi |Persistent Pi requires)/.test(error.message)
      ? error.message
      : 'Pi persistent writer could not start; check Node 24, storage permissions and the installed Pi CLI';
  process.stderr.write(`${piErrorExcerpt(message)}\n`);
  process.exitCode = 1;
}
