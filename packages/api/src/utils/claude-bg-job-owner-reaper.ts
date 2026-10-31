import { spawn } from 'node:child_process';
import {
  buildClaudeBgJobStopEnv,
  type ClaudeBgJobOwnerRecord,
  completeClaudeBgJobOwner,
  readClaudeBgJobOwnerRecords,
} from './claude-bg-job-ownership.js';
import { readUnixProcessSnapshotSync, sameUnixProcess } from './cli-process-ownership.js';
import { resolveCliCommandOrBare } from './cli-resolve.js';

interface ReaperLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface ClaudeBgJobOwnerReaperOptions {
  dataDir?: string;
  claudeCommand?: string;
  killGraceMs?: number;
  log: ReaperLog;
}

export interface ClaudeBgJobOwnerReaperResult {
  foundOwners: number;
  skippedActiveOwners: number;
  reapedOwners: number;
  retainedOwners: number;
  invalidManifests: number;
  stopAttempts: number;
  stopFailures: number;
}

async function stopClaudeJob(
  record: ClaudeBgJobOwnerRecord,
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean> {
  if (record.manifest.state !== 'active') return false;
  const shortId = record.manifest.shortId;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ['stop', shortId], {
        env: buildClaudeBgJobStopEnv(env, record.manifest.stopContext),
        stdio: 'ignore',
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The stop dispatcher already exited.
      }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}

export async function reapStaleClaudeBgJobOwners(
  options: ClaudeBgJobOwnerReaperOptions,
): Promise<ClaudeBgJobOwnerReaperResult> {
  const result: ClaudeBgJobOwnerReaperResult = {
    foundOwners: 0,
    skippedActiveOwners: 0,
    reapedOwners: 0,
    retainedOwners: 0,
    invalidManifests: 0,
    stopAttempts: 0,
    stopFailures: 0,
  };
  if (process.platform === 'win32') return result;

  const { records, invalidPaths } = readClaudeBgJobOwnerRecords(options.dataDir);
  result.foundOwners = records.length;
  result.invalidManifests = invalidPaths.length;
  for (const path of invalidPaths) options.log.warn(`[claude-bg-owner-reaper] retained invalid manifest: ${path}`);
  if (records.length === 0) return result;

  const identitySnapshot = readUnixProcessSnapshotSync();
  if (!identitySnapshot) {
    result.retainedOwners = records.length;
    options.log.warn('[claude-bg-owner-reaper] process identity scan failed; retained all manifests');
    return result;
  }
  const stale = records.filter((record) => {
    const active = sameUnixProcess(record.manifest.apiOwner, identitySnapshot.get(record.manifest.apiOwner.pid));
    if (active) result.skippedActiveOwners += 1;
    return !active;
  });
  if (stale.length === 0) return result;

  const command = options.claudeCommand ?? resolveCliCommandOrBare('claude');
  const stopOutcomes = new Map<string, boolean>();
  await Promise.all(
    stale.map(async (record) => {
      if (record.manifest.state !== 'active') return;
      result.stopAttempts += 1;
      const stopped = await stopClaudeJob(record, command, process.env, Math.max(250, options.killGraceMs ?? 3_000));
      stopOutcomes.set(record.manifest.ownerId, stopped);
      if (!stopped) result.stopFailures += 1;
    }),
  );

  for (const record of stale) {
    if (record.manifest.state === 'pending') {
      result.retainedOwners += 1;
      options.log.warn(
        `[claude-bg-owner-reaper] retained pending owner ${record.manifest.ownerId}; no native job id is available`,
      );
      continue;
    }
    const stopSucceeded = stopOutcomes.get(record.manifest.ownerId) === true;
    if (!stopSucceeded) {
      result.retainedOwners += 1;
      continue;
    }
    try {
      completeClaudeBgJobOwner(record);
      result.reapedOwners += 1;
    } catch (error) {
      result.retainedOwners += 1;
      options.log.warn(`[claude-bg-owner-reaper] cleanup failed for ${record.manifest.ownerId}: ${String(error)}`);
    }
  }
  if (result.reapedOwners > 0 || result.retainedOwners > 0) {
    options.log.info(
      `[claude-bg-owner-reaper] stale=${stale.length} reaped=${result.reapedOwners} retained=${result.retainedOwners} stop=${result.stopAttempts} failures=${result.stopFailures}`,
    );
  }
  return result;
}
