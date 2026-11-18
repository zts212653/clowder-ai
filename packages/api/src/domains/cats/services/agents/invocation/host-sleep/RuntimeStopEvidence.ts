/**
 * F337: is the runtime's own stop under way for this process?
 *
 * The launcher stops a deployment by walking its process tree depth-first (`start-dev.sh`
 * `terminate_pid_tree_with_signal`): provider children get TERM before the API does, so their turns
 * end as provider failures before the API's own SIGTERM handler can mark the stop (boot 92 → 93:
 * two turns ended 1.4 s after the stop was signalled, still `provider_execution_failed`).
 *
 * The stop operation record names every process it will stop and gets `signalledAt` just before the
 * first signal. A turn that ends while that signal is reaching this very process instance was cut off
 * by the stop, however its provider went down. A record only requested (the executor may have exited
 * before signalling), signalled before this process started (a reused pid), or signalled long ago
 * (the launcher kills everything within its 15 s grace) is not this stop. Unreadable or absent
 * records are not a stop either.
 */

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** States of `scripts/lib/daemon-stop-record.mjs` IN_PROGRESS. */
const STOP_IN_PROGRESS = new Set(['requested', 'stopping']);
/** `stopDaemon` waits 15 s after TERM, then kills; a turn the stop cut off has ended well within this. */
export const STOP_SIGNAL_WINDOW_MS = 60_000;

/** Mirrors `daemonStatePaths` in `scripts/lib/daemon-state.mjs` (guarded by a test). */
export async function runtimeStopRecordFile(input: {
  readonly projectRoot: string;
  readonly deploymentId: string;
  readonly homeDir?: string;
}): Promise<string> {
  const canonicalRoot = await realpath(resolve(input.projectRoot));
  const rootHash = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12);
  return join(
    resolve(input.homeDir ?? homedir()),
    '.cat-cafe',
    'daemons',
    `${input.deploymentId}-${rootHash}`,
    'stop-operation.json',
  );
}

/** True when a stop in progress has signalled, recently, a set naming this process instance. */
export function stopRecordTargets(
  record: unknown,
  instance: { readonly pid: number; readonly startedAt: number },
  now: number,
): boolean {
  if (!record || typeof record !== 'object') return false;
  const { state, targetProcessSet, signalledAt } = record as {
    state?: unknown;
    targetProcessSet?: unknown;
    signalledAt?: unknown;
  };
  if (typeof state !== 'string' || !STOP_IN_PROGRESS.has(state)) return false;
  if (!Array.isArray(targetProcessSet) || !targetProcessSet.includes(instance.pid)) return false;
  const signalled = typeof signalledAt === 'string' ? Date.parse(signalledAt) : Number.NaN;
  return Number.isFinite(signalled) && signalled >= instance.startedAt && now - signalled <= STOP_SIGNAL_WINDOW_MS;
}

/**
 * The stop probe handed to invocations: the API's own SIGTERM flag, or else the deployment's stop
 * record. Read on demand (only when a turn ends without success), never cached.
 */
export function createRuntimeStopProbe(input: {
  readonly begun: () => boolean;
  readonly recordFile: Promise<string | undefined> | string | undefined;
  readonly pid?: number;
  /** When this process started (default: from `process.uptime()`). */
  readonly startedAt?: number;
  readonly now?: () => number;
  readonly read?: (file: string) => Promise<string>;
}): () => Promise<boolean> {
  const instance = {
    pid: input.pid ?? process.pid,
    startedAt: input.startedAt ?? Date.now() - Math.round(process.uptime() * 1000),
  };
  const now = input.now ?? Date.now;
  const read = input.read ?? ((file: string) => readFile(file, 'utf8'));
  return async () => {
    if (input.begun()) return true;
    let fromRecord = false;
    try {
      const file = await input.recordFile;
      if (file) fromRecord = stopRecordTargets(JSON.parse(await read(file)), instance, now());
    } catch {
      fromRecord = false;
    }
    // SIGTERM may have arrived while the record was being read; a stop already known is never dropped.
    return fromRecord || input.begun();
  };
}
