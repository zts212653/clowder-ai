import { persistCliExecutionStopEvidence } from './cli-execution-stop-evidence.js';
import {
  type CliExecutionOwnerRef,
  type CliProcessOwnerRecord,
  findOwnedUnixProcesses,
  readCliProcessOwnerRecords,
  readUnixProcessSnapshotSync,
  sameUnixProcess,
} from './cli-process-ownership.js';

/** An authentic archived manifest is required. An empty live-owner list is never enough. */
export function recoverCliExecutionStop(input: {
  record: CliProcessOwnerRecord;
  expected: CliExecutionOwnerRef;
  dataDir: string;
  apply?: boolean;
  readSnapshot?: typeof readUnixProcessSnapshotSync;
}): { verified: boolean; applied: boolean; reason: string } {
  const { manifest } = input.record;
  if (
    !manifest.execution ||
    Object.entries(input.expected).some(
      ([key, value]) => manifest.execution?.[key as keyof CliExecutionOwnerRef] !== value,
    )
  )
    return { verified: false, applied: false, reason: 'exact_owner_mismatch' };
  const readSnapshot = input.readSnapshot ?? readUnixProcessSnapshotSync;
  const births = [manifest.supervisor, ...(manifest.root ? [manifest.root] : [])];
  const hostPid = manifest.supervisor.ppid;
  if (hostPid <= 1) return { verified: false, applied: false, reason: 'original_host_identity_unavailable' };
  const original = readSnapshot({ pids: [...births.map((birth) => birth.pid), hostPid] });
  if (!original) return { verified: false, applied: false, reason: 'process_identity_unavailable' };
  if (original.has(hostPid)) return { verified: false, applied: false, reason: 'original_host_still_present' };
  if (births.some((birth) => sameUnixProcess(birth, original.get(birth.pid))))
    return { verified: false, applied: false, reason: 'original_process_still_running' };
  const tree = readSnapshot({
    includeEnvironment: true,
    environmentMarkers: [`CAT_CAFE_PROCESS_OWNER_ID=${manifest.ownerId}`],
  });
  if (!tree) return { verified: false, applied: false, reason: 'owned_tree_scan_unavailable' };
  if (findOwnedUnixProcesses(tree, manifest.ownerId).length)
    return { verified: false, applied: false, reason: 'owned_descendants_still_running' };
  const active = readCliProcessOwnerRecords(input.dataDir);
  if (
    active.invalidPaths.length ||
    active.records.some(
      ({ manifest: current }) =>
        current.execution?.executionId === input.expected.executionId &&
        current.execution.threadId === input.expected.threadId &&
        current.execution.userId === input.expected.userId,
    )
  )
    return { verified: false, applied: false, reason: 'active_owner_or_incomplete_scope' };
  // No await between the final ownership check and publishing the observed proof.
  // Never remove an active manifest, cancel a replacement, or touch the execution ledger here.
  if (input.apply) persistCliExecutionStopEvidence(input.record, 'operator_archived_manifest');
  return { verified: true, applied: input.apply === true, reason: 'exact_owned_tree_stopped' };
}
