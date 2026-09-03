import type { TranscriptEvent } from '../../../domains/cats/services/session/TranscriptReader.js';

export const TRAJECTORY_SCAN_CONCURRENCY = 2;

const MAX_CANDIDATES = 10_000;
const MAX_DRILLS = 10_000;
const MAX_FALLBACK_COMMANDS = 2_000;
const MAX_FALLBACK_BYTES = 4 * 1024 * 1024;
const MAX_FALLBACK_COMMAND_BYTES = 16_384;
const MAX_EVIDENCE_EVENTS_PER_CANDIDATE = 100;
const MAX_TOTAL_EVIDENCE_EVENTS = 20_000;
const MAX_TOTAL_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_INVOCATIONS_PER_SESSION = 20_000;

export interface TrajectoryScanBudget {
  drills: number;
  fallbackCommands: number;
  fallbackBytes: number;
  evidenceEvents: number;
  evidenceBytes: number;
}

export function createTrajectoryScanBudget(): TrajectoryScanBudget {
  return { drills: 0, fallbackCommands: 0, fallbackBytes: 0, evidenceEvents: 0, evidenceBytes: 0 };
}

export function assertCandidateBudget(size: number): void {
  if (size > MAX_CANDIDATES) throw new Error('trajectory_inspector_candidate_budget_exceeded');
}

export function assertInvocationStateBudget(size: number): void {
  if (size > MAX_INVOCATIONS_PER_SESSION) {
    throw new Error('trajectory_inspector_invocation_state_budget_exceeded');
  }
}

export function consumeDrillBudget(budget: TrajectoryScanBudget): void {
  budget.drills += 1;
  if (budget.drills > MAX_DRILLS) throw new Error('trajectory_inspector_drill_budget_exceeded');
}

export function retainFallbackCommand(budget: TrajectoryScanBudget, command: string): string {
  const commandBytes = Buffer.byteLength(command, 'utf8');
  if (commandBytes > MAX_FALLBACK_COMMAND_BYTES) {
    throw new Error('trajectory_inspector_fallback_command_budget_exceeded');
  }
  budget.fallbackCommands += 1;
  budget.fallbackBytes += commandBytes;
  if (budget.fallbackCommands > MAX_FALLBACK_COMMANDS || budget.fallbackBytes > MAX_FALLBACK_BYTES) {
    throw new Error('trajectory_inspector_fallback_command_budget_exceeded');
  }
  return command;
}

export function consumeEvidenceBudget(
  budget: TrajectoryScanBudget,
  event: TranscriptEvent,
  candidateEventCount: number,
): void {
  budget.evidenceEvents += 1;
  budget.evidenceBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
  if (candidateEventCount > MAX_EVIDENCE_EVENTS_PER_CANDIDATE) {
    throw new Error('trajectory_inspector_candidate_evidence_budget_exceeded');
  }
  if (budget.evidenceEvents > MAX_TOTAL_EVIDENCE_EVENTS || budget.evidenceBytes > MAX_TOTAL_EVIDENCE_BYTES) {
    throw new Error('trajectory_inspector_total_evidence_budget_exceeded');
  }
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => R | Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function consumeInBatches<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => R | Promise<R>,
  consume: (result: R) => void,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const results = await Promise.all(items.slice(offset, offset + concurrency).map(mapper));
    for (const result of results) consume(result);
  }
}
