import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  readProcessResourceLeaseMetadata,
  recoverStaleLease,
  removeOwnedLease,
  tryAcquireLeaseFile,
} from './process-resource-lease-lock.mjs';
import { isProcessRunning } from './process-tree.mjs';

export async function withPreviewMutationLock(config, operation) {
  mkdirSync(dirname(config.recordPath), { recursive: true, mode: 0o700 });
  // One physical lock also covers ordinary aliases such as macOS /var -> /private/var.
  // Recovery separately requires exact, unlinked evidence paths.
  const path = join(realpathSync(dirname(config.recordPath)), `${basename(config.recordPath)}.mutation.lock`);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('preview mutation lock is linked');
  const metadata = {
    leaseId: randomUUID(),
    holderPid: process.pid,
    cwd: config.cwd ?? dirname(config.recordPath),
    startedAt: new Date().toISOString(),
  };
  if (!(await tryAcquireLeaseFile(path, metadata))) {
    const holder = await readProcessResourceLeaseMetadata(path);
    // The generic resource lock is reusable only after an explicit absent result.
    // A failed process observation must not reclaim an active/unknown mutation.
    if (
      !holder ||
      isProcessRunning(holder.holderPid) !== false ||
      !(await recoverStaleLease(path)).recovered ||
      !(await tryAcquireLeaseFile(path, metadata))
    )
      throw Object.assign(new Error('preview lifecycle mutation already active or unproven'), {
        code: 'PREVIEW_MUTATION_BUSY',
      });
  }
  try {
    return await operation();
  } finally {
    await removeOwnedLease(path, metadata.leaseId, metadata.holderPid);
  }
}
