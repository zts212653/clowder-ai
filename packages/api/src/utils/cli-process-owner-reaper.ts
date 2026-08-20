import {
  type CliProcessOwnerRecord,
  completeCliProcessOwnerCleanup,
  findOwnedUnixProcesses,
  quarantineInvalidCliProcessOwnerManifests,
  readCliProcessOwnerRecords,
  readUnixProcessSnapshotSync,
  sameUnixProcess,
  signalOwnedUnixProcesses,
  type UnixProcessSnapshotEntry,
} from './cli-process-ownership.js';

interface ReaperLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface CliProcessOwnerReaperOptions {
  dataDir?: string;
  killGraceMs?: number;
  log: ReaperLog;
}

export interface CliProcessOwnerReaperResult {
  foundOwners: number;
  skippedActiveOwners: number;
  reapedOwners: number;
  retainedOwners: number;
  invalidManifests: number;
  termSignals: number;
  killSignals: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ownedTargets(record: CliProcessOwnerRecord, snapshot: ReadonlyMap<number, UnixProcessSnapshotEntry>) {
  return findOwnedUnixProcesses(snapshot, record.manifest.ownerId);
}

function selectStaleOwners(
  records: readonly CliProcessOwnerRecord[],
  identitySnapshot: ReadonlyMap<number, UnixProcessSnapshotEntry>,
): { stale: CliProcessOwnerRecord[]; activeCount: number } {
  const stale: CliProcessOwnerRecord[] = [];
  let activeCount = 0;
  for (const record of records) {
    if (sameUnixProcess(record.manifest.supervisor, identitySnapshot.get(record.manifest.supervisor.pid))) {
      activeCount += 1;
    } else {
      stale.push(record);
    }
  }
  return { stale, activeCount };
}

function signalOwnerPhase(
  records: readonly CliProcessOwnerRecord[],
  snapshot: ReadonlyMap<number, UnixProcessSnapshotEntry>,
  signal: NodeJS.Signals,
): { signals: number; hasTargets: boolean } {
  let signals = 0;
  let hasTargets = false;
  for (const record of records) {
    const targets = ownedTargets(record, snapshot);
    hasTargets ||= targets.length > 0;
    signals += signalOwnedUnixProcesses(targets, snapshot, signal);
  }
  return { signals, hasTargets };
}

function retainAfterScanFailure(
  result: CliProcessOwnerReaperResult,
  count: number,
  log: ReaperLog,
  phase: string,
): CliProcessOwnerReaperResult {
  result.retainedOwners = count;
  log.warn(`[cli-owner-reaper] ${phase} scan failed; retained stale manifests`);
  return result;
}

function finalizeStaleOwners(
  stale: readonly CliProcessOwnerRecord[],
  finalSnapshot: ReadonlyMap<number, UnixProcessSnapshotEntry>,
  result: CliProcessOwnerReaperResult,
  log: ReaperLog,
): void {
  for (const record of stale) {
    if (ownedTargets(record, finalSnapshot).length > 0) {
      result.retainedOwners += 1;
      continue;
    }
    try {
      completeCliProcessOwnerCleanup(record);
      result.reapedOwners += 1;
    } catch (error) {
      result.retainedOwners += 1;
      log.warn(`[cli-owner-reaper] cleanup failed for ${record.manifest.ownerId}: ${String(error)}`);
    }
  }
}

export async function reapStaleCliProcessOwners(
  options: CliProcessOwnerReaperOptions,
): Promise<CliProcessOwnerReaperResult> {
  const result: CliProcessOwnerReaperResult = {
    foundOwners: 0,
    skippedActiveOwners: 0,
    reapedOwners: 0,
    retainedOwners: 0,
    invalidManifests: 0,
    termSignals: 0,
    killSignals: 0,
  };
  if (process.platform === 'win32') return result;

  const { records, invalidPaths } = readCliProcessOwnerRecords(options.dataDir);
  result.foundOwners = records.length;
  result.invalidManifests = invalidPaths.length;
  const quarantine = quarantineInvalidCliProcessOwnerManifests(invalidPaths, options.dataDir);
  for (const path of quarantine.quarantinedPaths) {
    options.log.warn(`[cli-owner-reaper] quarantined invalid manifest: ${path}`);
  }
  for (const path of quarantine.failedPaths) {
    options.log.warn(`[cli-owner-reaper] failed to quarantine invalid manifest: ${path}`);
  }
  if (records.length === 0) return result;

  const identitySnapshot = readUnixProcessSnapshotSync();
  if (!identitySnapshot) {
    result.retainedOwners = records.length;
    options.log.warn('[cli-owner-reaper] process identity scan failed; retained all manifests');
    return result;
  }
  const selection = selectStaleOwners(records, identitySnapshot);
  const stale = selection.stale;
  result.skippedActiveOwners = selection.activeCount;
  if (stale.length === 0) return result;

  let ownershipSnapshot = readUnixProcessSnapshotSync({ includeEnvironment: true });
  if (!ownershipSnapshot) {
    return retainAfterScanFailure(result, stale.length, options.log, 'ownership');
  }
  const term = signalOwnerPhase(stale, ownershipSnapshot, 'SIGTERM');
  result.termSignals = term.signals;

  if (term.hasTargets) await delay(Math.max(1, options.killGraceMs ?? 3_000));
  ownershipSnapshot = readUnixProcessSnapshotSync({ includeEnvironment: true });
  if (!ownershipSnapshot) {
    return retainAfterScanFailure(result, stale.length, options.log, 'post-TERM');
  }
  const kill = signalOwnerPhase(stale, ownershipSnapshot, 'SIGKILL');
  result.killSignals = kill.signals;

  if (kill.hasTargets) await delay(50);
  const finalSnapshot = readUnixProcessSnapshotSync({ includeEnvironment: true });
  if (!finalSnapshot) {
    return retainAfterScanFailure(result, stale.length, options.log, 'final ownership');
  }
  finalizeStaleOwners(stale, finalSnapshot, result, options.log);
  if (result.reapedOwners > 0 || result.retainedOwners > 0) {
    options.log.info(
      `[cli-owner-reaper] stale=${stale.length} reaped=${result.reapedOwners} retained=${result.retainedOwners} term=${result.termSignals} kill=${result.killSignals}`,
    );
  }
  return result;
}
