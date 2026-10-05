import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_PMSET_LOG_BYTES = 64 * 1024 * 1024;
const MAX_PMSET_TIMEOUT_MS = 5_000;

export interface DurableGateConfirmedSleepInterval {
  readonly evidenceId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly wakeKind: 'dark' | 'full';
}

export type DurableGatePowerEvidence =
  | { readonly status: 'available'; readonly confirmedSleep: readonly DurableGateConfirmedSleepInterval[] }
  | { readonly status: 'unavailable'; readonly reason: string };

export type DurableGatePowerEvidenceReader = (input: {
  readonly from: number;
  readonly to: number;
  readonly timeoutMs?: number;
}) => DurableGatePowerEvidence;

export type DurableGatePowerEvidenceSource =
  | { readonly kind: 'mac_pmset' }
  | { readonly kind: 'json_file'; readonly path: string };

interface PowerEvidenceCommandOptions {
  readonly platform?: NodeJS.Platform;
  readonly execFileSync?: (
    file: string,
    args: readonly string[],
    options: {
      readonly encoding: 'utf8';
      readonly killSignal: 'SIGKILL';
      readonly maxBuffer: number;
      readonly timeout: number;
    },
  ) => string;
}

function eventTimestamp(match: RegExpMatchArray): number | null {
  const [, date, time, offset] = match;
  const isoOffset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const value = Date.parse(`${date}T${time}${isoOffset}`);
  return Number.isFinite(value) ? value : null;
}

function parseMacPowerEvent(line: string): { readonly at: number; readonly kind: string } | null {
  const match = line.match(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{4})\s+(Sleep|DarkWake|Wake(?!\s+Requests\b))(?=\s|$)/u,
  );
  if (!match) return null;
  const at = eventTimestamp(match);
  return at === null ? null : { at, kind: match[4] };
}

export function parseMacPowerLog(output: string): DurableGateConfirmedSleepInterval[] {
  const intervals: DurableGateConfirmedSleepInterval[] = [];
  let sleepingAt: number | null = null;
  let awaitingFullWake = false;
  for (const line of output.split('\n')) {
    const event = parseMacPowerEvent(line);
    if (!event) continue;
    const { at, kind } = event;
    if (kind === 'Sleep') {
      sleepingAt ??= at;
      awaitingFullWake = false;
      continue;
    }
    if (sleepingAt === null) {
      if (kind === 'Wake' && awaitingFullWake) {
        intervals.push({
          evidenceId: `pmset:full-wake:${at}`,
          startedAt: at,
          endedAt: at,
          wakeKind: 'full',
        });
        awaitingFullWake = false;
      }
      continue;
    }
    if (at < sleepingAt) continue;
    const wakeKind = kind === 'Wake' ? 'full' : 'dark';
    intervals.push({
      evidenceId: `pmset:${sleepingAt}:${at}:${wakeKind}`,
      startedAt: sleepingAt,
      endedAt: at,
      wakeKind,
    });
    sleepingAt = null;
    awaitingFullWake = wakeKind === 'dark';
  }
  return intervals;
}

function parseFixtureEvidence(path: string): DurableGatePowerEvidence {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.confirmedSleep)) {
      return { status: 'unavailable', reason: 'invalid power-evidence fixture' };
    }
    const confirmedSleep: DurableGateConfirmedSleepInterval[] = [];
    for (const candidate of value.confirmedSleep) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { status: 'unavailable', reason: 'invalid power-evidence interval' };
      }
      const interval = candidate as Record<string, unknown>;
      if (
        typeof interval.evidenceId !== 'string' ||
        !interval.evidenceId ||
        typeof interval.startedAt !== 'number' ||
        !Number.isFinite(interval.startedAt) ||
        typeof interval.endedAt !== 'number' ||
        !Number.isFinite(interval.endedAt) ||
        interval.endedAt < interval.startedAt ||
        (interval.wakeKind !== undefined && interval.wakeKind !== 'dark' && interval.wakeKind !== 'full')
      ) {
        return { status: 'unavailable', reason: 'invalid power-evidence interval' };
      }
      confirmedSleep.push({
        evidenceId: interval.evidenceId,
        startedAt: interval.startedAt,
        endedAt: interval.endedAt,
        wakeKind: interval.wakeKind === 'dark' ? 'dark' : 'full',
      });
    }
    return { status: 'available', confirmedSleep };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function readDurableGatePowerEvidence(
  source: DurableGatePowerEvidenceSource,
  input: { readonly from: number; readonly to: number; readonly timeoutMs?: number },
  commandOptions: PowerEvidenceCommandOptions = {},
): DurableGatePowerEvidence {
  let evidence: DurableGatePowerEvidence;
  if (source.kind === 'json_file') {
    evidence = parseFixtureEvidence(source.path);
  } else if ((commandOptions.platform ?? process.platform) !== 'darwin') {
    evidence = { status: 'unavailable', reason: 'pmset power evidence is only available on macOS' };
  } else {
    try {
      const runCommand =
        commandOptions.execFileSync ??
        ((
          file: string,
          args: readonly string[],
          options: Parameters<NonNullable<PowerEvidenceCommandOptions['execFileSync']>>[2],
        ) => execFileSync(file, [...args], options));
      evidence = {
        status: 'available',
        confirmedSleep: parseMacPowerLog(
          runCommand('/usr/bin/pmset', ['-g', 'log'], {
            encoding: 'utf8',
            killSignal: 'SIGKILL',
            maxBuffer: MAX_PMSET_LOG_BYTES,
            timeout: Math.min(MAX_PMSET_TIMEOUT_MS, Math.max(1, input.timeoutMs ?? MAX_PMSET_TIMEOUT_MS)),
          }),
        ),
      };
    } catch (error) {
      evidence = { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  if (evidence.status !== 'available') return evidence;
  return {
    status: 'available',
    confirmedSleep: evidence.confirmedSleep.filter(
      (interval) => interval.startedAt < input.to && interval.endedAt > input.from,
    ),
  };
}
