import { readFileSync, statSync } from 'node:fs';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import { alphaRecoveryJournalPath } from './durable-managed-gate-recovery-child-contract.js';

export type AlphaRecoveryObservation =
  | { readonly kind: 'clean' | 'clock_interruption' }
  | { readonly kind: 'failed'; readonly firstFailureAt: number; readonly unitKey: string }
  | { readonly kind: 'unknown'; readonly reason: string };

type CleanupSignal = { processIdentity: { pid: number; startedAt: string }; signal: string; sentAt: number };
type ObservationEntry = Record<string, unknown> & { unitKey: string; observedAt: number };
interface ObservedCommand {
  protocol: string;
  started: boolean;
  ended: boolean;
  clock: boolean;
  observerEnded: boolean;
  interrupted: boolean;
  interruptionProven: boolean;
  pid?: number;
  startedAt?: string;
}
const unknown = (reason: string): AlphaRecoveryObservation => ({ kind: 'unknown', reason });
const failed = (entry: ObservationEntry): AlphaRecoveryObservation => ({
  kind: 'failed',
  firstFailureAt: entry.observedAt,
  unitKey: entry.unitKey,
});

function boundEntry(value: unknown, jobId: string, attemptToken: string): value is ObservationEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.version === 1 &&
    entry.jobId === jobId &&
    entry.attemptToken === attemptToken &&
    typeof entry.unitKey === 'string' &&
    entry.unitKey.length > 0 &&
    typeof entry.observedAt === 'number' &&
    Number.isFinite(entry.observedAt)
  );
}

function observeExit(unit: ObservedCommand, entry: ObservationEntry, signals: readonly CleanupSignal[]) {
  unit.ended = true;
  unit.clock = entry.timedOut === true;
  const cleanupSignal =
    entry.exitCode === null &&
    signals.some(
      (signal) =>
        signal.processIdentity.pid === unit.pid &&
        signal.processIdentity.startedAt === unit.startedAt &&
        signal.signal === entry.signal &&
        signal.sentAt <= entry.observedAt,
    );
  unit.interruptionProven = entry.timedOut === true || entry.cancelled === true || cleanupSignal;
  if (entry.exitCode !== 0 && !unit.interruptionProven) return failed(entry);
  if (entry.exitCode !== 0 && (!unit.started || unit.protocol !== 'node-test-v1')) {
    return unknown('interrupted command had no test observer');
  }
  return null;
}

function observeEntry(units: Map<string, ObservedCommand>, entry: ObservationEntry, signals: readonly CleanupSignal[]) {
  if (entry.type === 'command-start') {
    if (units.has(entry.unitKey)) return unknown('duplicate command observation');
    units.set(entry.unitKey, {
      protocol: String(entry.observerProtocol),
      started: false,
      ended: false,
      clock: false,
      observerEnded: false,
      interrupted: false,
      interruptionProven: false,
    });
    return null;
  }
  const unit = units.get(entry.unitKey);
  if (!unit) return unknown('observation has no admitted command');
  switch (entry.type) {
    case 'test-failure':
      return failed(entry);
    case 'observer-start':
      unit.started = entry.observerProtocol === 'node-test-v1';
      break;
    case 'command-spawn':
      if (typeof entry.pid === 'number') unit.pid = entry.pid;
      if (typeof entry.startedAt === 'string') unit.startedAt = entry.startedAt;
      break;
    case 'command-exit':
      return observeExit(unit, entry, signals);
    case 'observer-end':
      unit.observerEnded = true;
      break;
    case 'test-interruption':
      unit.interrupted = true;
      break;
    default:
      return unknown('unknown observation event');
  }
  return null;
}

function summarizeObservations(units: readonly ObservedCommand[]): AlphaRecoveryObservation {
  if (
    units.some(
      (unit) =>
        (unit.interrupted && !unit.interruptionProven) ||
        (unit.protocol === 'node-test-v1' &&
          unit.ended &&
          !unit.interruptionProven &&
          (!unit.started || !unit.observerEnded)),
    )
  ) {
    return unknown('test observer did not prove a complete or owned interruption');
  }
  if (!units.length || units.some((unit) => !unit.ended && (!unit.started || unit.protocol !== 'node-test-v1'))) {
    return unknown('active command has no acknowledged test observer');
  }
  return { kind: units.some((unit) => unit.clock) ? 'clock_interruption' : 'clean' };
}

/** This is observed test/command evidence, not a parser for CDP log text. */
export function readAlphaRecoveryObservation(
  job: DurableManagedGateJob,
  attemptToken: string,
  cleanupSignals: readonly CleanupSignal[] = [],
): AlphaRecoveryObservation {
  try {
    const path = alphaRecoveryJournalPath(job, attemptToken);
    if (statSync(path).size > 1_048_576) return unknown('observation journal exceeded its bound');
    const text = readFileSync(path, 'utf8');
    if (!text.endsWith('\n')) return unknown('observation journal has an unfinished record');
    const units = new Map<string, ObservedCommand>();
    for (const line of text.trim().split('\n')) {
      const entry: unknown = JSON.parse(line);
      if (!boundEntry(entry, job.jobId, attemptToken)) return unknown('observation binding is invalid');
      const outcome = observeEntry(units, entry, cleanupSignals);
      if (outcome) return outcome;
    }
    return summarizeObservations([...units.values()]);
  } catch {
    return unknown('observation journal is absent or unreadable');
  }
}
