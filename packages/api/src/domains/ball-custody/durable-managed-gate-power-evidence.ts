import { readFileSync } from 'node:fs';

import {
  type MacPowerEvidenceCommandOptions,
  readMacSleepEvidence,
} from '../../../runtime/process-observation/mac-power-evidence.mjs';

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

type PowerEvidenceCommandOptions = Omit<MacPowerEvidenceCommandOptions, 'execute'> & {
  readonly execFileSync?: MacPowerEvidenceCommandOptions['execute'];
};

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
  } else {
    // Keep the persisted mac_pmset discriminator for existing jobs; its
    // transport now uses the same bounded native evidence as the command clock.
    evidence = readMacSleepEvidence(input, { ...commandOptions, execute: commandOptions.execFileSync });
  }
  if (evidence.status !== 'available') return evidence;
  return {
    status: 'available',
    confirmedSleep: evidence.confirmedSleep.filter(
      (interval) => interval.startedAt < input.to && interval.endedAt > input.from,
    ),
  };
}
