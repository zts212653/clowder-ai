/**
 * F337: tell a lid-close/idle sleep apart from a provider failure.
 *
 * The OS writes every Sleep / DarkWake / Wake to the power-management ASL logs. The existing
 * reader (`runtime/process-observation/mac-power-evidence.mjs`) is synchronous and may block for
 * seconds, which the API main thread cannot afford, so this reads the same records with an async
 * child process and reuses only its pure parser. Anything unreadable stays unknown: no sleep is ever
 * claimed without the OS record.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type MacPowerEvidence,
  parseMacSleepEvidence,
} from '../../../../../../../runtime/process-observation/mac-power-evidence.mjs';

const execFileAsync = promisify(execFile);
const DAY_MS = 86_400_000;
const LOG_ROOT = '/var/log/powermanagement';
const FORMAT = '$(Time)\t$(TimeNanoSec)\t$(com.apple.iokit.domain)\t$(uuid)';
const READ_TIMEOUT_MS = 5_000;

/** A failure seen later than this after the wake that ended a mid-turn sleep is not blamed on it. */
export const SLEEP_FAILURE_ATTRIBUTION_WINDOW_MS = 10 * 60_000;

export type HostSleepEvidence = MacPowerEvidence;
export type HostSleepEvidenceReader = (window: { from: number; to: number }) => Promise<HostSleepEvidence>;

export interface HostSleepEvidenceReaderOptions {
  readonly platform?: string;
  readonly exists?: (file: string) => boolean;
  readonly run?: (file: string, args: readonly string[]) => Promise<string>;
}

async function runSyslog(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, [...args], {
    encoding: 'utf8',
    timeout: READ_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 1_048_576,
  });
  return stdout;
}

/** ASL files are named by local date; adjacent UTC dates cover both timezone directions. */
function powerLogFiles(from: number, to: number): string[] {
  const files: string[] = [];
  for (let day = Math.floor(from / DAY_MS) - 1; day <= Math.floor(to / DAY_MS) + 1; day += 1) {
    files.push(path.join(LOG_ROOT, `${new Date(day * DAY_MS).toISOString().slice(0, 10).replaceAll('-', '.')}.asl`));
  }
  return files;
}

export function createHostSleepEvidenceReader(options: HostSleepEvidenceReaderOptions = {}): HostSleepEvidenceReader {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const run = options.run ?? runSyslog;
  return async ({ from, to }) => {
    if (platform !== 'darwin') return { status: 'unavailable', reason: 'unsupported power source' };
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
      return { status: 'unavailable', reason: 'invalid power window' };
    }
    const files = powerLogFiles(from, to).filter((file) => exists(file));
    if (files.length === 0) return { status: 'unavailable', reason: 'power log unavailable' };
    try {
      const output = await run('/usr/bin/syslog', [
        ...files.flatMap((file) => ['-f', file]),
        '-T',
        'sec',
        '-F',
        FORMAT,
        '-k',
        'Time',
        'Nle',
        String(Math.ceil(to / 1000) + 1),
        '-k',
        'com.apple.iokit.domain',
        'Req',
        '^(Sleep|DarkWake|Wake)$',
      ]);
      return parseMacSleepEvidence(output);
    } catch (error) {
      return {
        status: 'unavailable',
        reason: `power log read failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

export interface SleepInterruption {
  readonly sleptAt: number;
  readonly wokeAt: number;
}

/**
 * The machine slept after this turn started and the failure came within the attribution window of
 * waking up. A Sleep whose Wake the OS has not published yet still counts: this code is running, so
 * the machine is awake at `failedAt`.
 */
export function findSleepInterruption(
  evidence: HostSleepEvidence,
  turn: { readonly turnStartedAt: number; readonly failedAt: number },
): SleepInterruption | null {
  if (evidence.status !== 'available') return null;
  const sleeps: SleepInterruption[] = evidence.confirmedSleep
    .filter((interval) => interval.endedAt > interval.startedAt)
    .map((interval) => ({ sleptAt: interval.startedAt, wokeAt: interval.endedAt }));
  if (evidence.pendingSleep) sleeps.push({ sleptAt: evidence.pendingSleep.startedAt, wokeAt: turn.failedAt });
  let latest: SleepInterruption | null = null;
  for (const sleep of sleeps) {
    if (sleep.sleptAt <= turn.turnStartedAt || sleep.sleptAt >= turn.failedAt) continue;
    if (sleep.wokeAt > turn.failedAt) continue;
    if (turn.failedAt - sleep.wokeAt > SLEEP_FAILURE_ATTRIBUTION_WINDOW_MS) continue;
    if (!latest || sleep.sleptAt > latest.sleptAt) latest = sleep;
  }
  return latest;
}

/**
 * True once the latest power transition after `since` is a full wake (lid opened, user active), not
 * a maintenance dark wake that will sleep again in a minute. `null` when the log cannot be read.
 */
export function isInFullWakeSince(evidence: HostSleepEvidence, since: number): boolean | null {
  if (evidence.status !== 'available') return null;
  if (evidence.pendingSleep && evidence.pendingSleep.startedAt >= since) return false;
  let last: { endedAt: number; wakeKind: 'dark' | 'full' } | null = null;
  for (const interval of evidence.confirmedSleep) {
    if (!last || interval.endedAt >= last.endedAt) last = interval;
  }
  return last !== null && last.endedAt >= since && last.wakeKind === 'full';
}
