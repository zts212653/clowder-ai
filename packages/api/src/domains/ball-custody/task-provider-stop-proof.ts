import type { TaskExecutionRef } from '@cat-cafe/shared';
import {
  findOwnedUnixProcesses,
  readCliProcessOwnerRecords,
  readUnixProcessSnapshot,
  sameUnixProcess,
} from '../../utils/cli-process-ownership.js';

/** Positive exact owner manifests plus an OS identity snapshot; empty discovery is never death proof. */
export async function taskCliProviderIsStopped(ref: TaskExecutionRef, userId: string): Promise<boolean> {
  const { records, invalidPaths } = readCliProcessOwnerRecords();
  if (invalidPaths.length) return false;
  const exact = records.filter(
    ({ manifest: { execution } }) =>
      execution?.invocationId === ref.invocationId &&
      execution.executionId === ref.parentInvocationId &&
      execution.threadId === ref.threadId &&
      execution.catId === ref.catId &&
      execution.userId === userId,
  );
  if (!exact.length) return false;
  const snapshot = await readUnixProcessSnapshot({
    includeEnvironment: true,
    environmentMarkers: exact.map((record) => record.manifest.ownerId),
  });
  if (!snapshot) return false;
  return exact.every(
    ({ manifest }) =>
      !sameUnixProcess(manifest.supervisor, snapshot.get(manifest.supervisor.pid)) &&
      (!manifest.root || !sameUnixProcess(manifest.root, snapshot.get(manifest.root.pid))) &&
      findOwnedUnixProcesses(snapshot, manifest.ownerId).length === 0,
  );
}
