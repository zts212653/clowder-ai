import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  readProcessResourceLeaseMetadata,
  removeOwnedLease,
  transferOwnedLease,
} from './process-resource-lease-lock.mjs';
import { elapsedMilliseconds, writeProcessResourceReceipt } from './process-resource-lease-queue.mjs';

export function createProcessResourceLeaseHandle(state) {
  let released = false;
  const acquiredAtMonotonic = state.adopted ? null : process.hrtime.bigint();
  const acquiredAt = Date.parse(state.receipt.acquiredAt);
  return {
    lockPath: state.resolvedLockPath,
    receiptPath: state.waiter.receiptPath,
    async transfer({ cwd, holderPid }) {
      if (released) return false;
      const transferred = await transferOwnedLease(state.resolvedLockPath, {
        holderPid: state.holderPid,
        leaseId: state.leaseId,
        nextCwd: cwd,
        nextHolderPid: holderPid,
      });
      if (transferred) released = true;
      return transferred;
    },
    async release() {
      if (released) return;
      released = true;
      if (!(await removeOwnedLease(state.resolvedLockPath, state.leaseId, state.holderPid))) return;
      try {
        state.receipt = {
          ...state.receipt,
          status: 'released',
          releasedAt: new Date().toISOString(),
          holdDurationMs:
            acquiredAtMonotonic !== null
              ? elapsedMilliseconds(acquiredAtMonotonic)
              : Number.isFinite(acquiredAt)
                ? Date.now() - acquiredAt
                : null,
        };
        await writeProcessResourceReceipt(state.waiter, state.receipt);
      } catch (error) {
        console.error(`[${state.label}] failed to persist release receipt: ${error}`);
      }
      console.error(
        `[${state.label}] released pid=${state.holderPid} receipt=${JSON.stringify(state.waiter.receiptPath)}`,
      );
    },
  };
}

export async function adoptProcessResourceLease({ holderPid, label, leaseMetadata = {}, lockPath }) {
  const resolvedLockPath = resolve(lockPath);
  const metadata = await readProcessResourceLeaseMetadata(resolvedLockPath);
  if (
    metadata?.holderPid !== holderPid ||
    Object.entries(leaseMetadata).some(([key, value]) => metadata[key] !== value)
  ) {
    throw new Error(`${label} transferred lease identity does not match the current holder`);
  }
  const receipt = JSON.parse(await readFile(metadata.receiptPath, 'utf8'));
  return createProcessResourceLeaseHandle({
    adopted: true,
    holderPid,
    label,
    leaseId: metadata.leaseId,
    receipt,
    resolvedLockPath,
    waiter: {
      metadata: receipt,
      receiptDir: dirname(metadata.receiptPath),
      receiptPath: metadata.receiptPath,
    },
  });
}
