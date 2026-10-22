import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

interface Lease {
  pid: number;
  id: string;
}
const held = new Map<string, { lease: Lease; depth: number }>();
export class PluginWriteBusyError extends Error {
  readonly code = 'PLUGIN_WRITE_BUSY';
  constructor() {
    super('PLUGIN_WRITE_BUSY: plugin storage is being changed by another Host; retry after it finishes');
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
function read(path: string): Lease | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value &&
      typeof value === 'object' &&
      'pid' in value &&
      'id' in value &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.id === 'string'
    )
      return value as Lease;
    throw new PluginWriteBusyError();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function removeOwned(path: string, lease: Lease): void {
  const current = read(path);
  if (current?.pid === lease.pid && current.id === lease.id) unlinkSync(path);
}
function recovering(dir: string, except?: string): boolean {
  return readdirSync(dir).some(
    (name) => name.startsWith('.mutation-recovering-') && name !== except && alive(Number(name.split('-')[2])),
  );
}
function recover(dir: string, path: string, lease: Lease): boolean {
  const name = `.mutation-recovering-${lease.pid}-${lease.id}`;
  const marker = join(dir, name);
  const claimed = `${marker}.claimed`;
  writeFileSync(marker, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
  try {
    if (recovering(dir, name)) return false;
    const current = read(path);
    if (!current || alive(current.pid)) return false;
    renameSync(path, claimed);
    // Only a complete, dead holder record claimed under the recovery fence is removed.
    unlinkSync(claimed);
    return true;
  } finally {
    unlinkSync(marker);
  }
}

/** Shared by inventory transactions and every plugin-config writer. A complete
 * candidate is linked atomically; a crashed holder is reclaimed on explicit retry.
 * An async inventory transaction can nest its own synchronous config commit.
 * The final admission read -> write section itself must remain synchronous. */
export function acquirePluginMutationLease(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const dir = realpathSync.native(resolve(directory));
  const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
  const existing = held.get(key);
  if (existing) {
    existing.depth++;
    return () => release(key, dir);
  }
  const lease = { pid: process.pid, id: randomUUID() };
  const path = join(dir, '.mutation.lock');
  const candidate = `${path}.${lease.pid}.${lease.id}`;
  writeFileSync(candidate, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (recovering(dir)) throw new PluginWriteBusyError();
      try {
        linkSync(candidate, path);
        if (recovering(dir)) {
          removeOwned(path, lease);
          throw new PluginWriteBusyError();
        }
        held.set(key, { lease, depth: 1 });
        return () => release(key, dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = read(path);
        if (current && alive(current.pid)) throw new PluginWriteBusyError();
        if (current && !recover(dir, path, lease)) throw new PluginWriteBusyError();
      }
    }
    throw new PluginWriteBusyError();
  } finally {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}
function release(key: string, dir: string): void {
  const value = held.get(key);
  if (!value || --value.depth > 0) return;
  held.delete(key);
  removeOwned(join(dir, '.mutation.lock'), value.lease);
}
