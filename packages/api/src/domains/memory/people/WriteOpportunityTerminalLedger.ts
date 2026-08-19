/**
 * Cross-invocation terminal truth for Standing Reflex write opportunities.
 *
 * Why this exists: admission previously received `terminalGenerationKeys: new Set()`, so a terminal
 * generation could be re-presented in a later invocation and an invalidated lineage could come back
 * after a carrier resume (SR:129). This ledger is the persisted answer to "has this exact generation
 * already been judged, and is this lineage still alive at all?".
 *
 * It is read at admission, never pushed: this domain has no invalidation event bus — invalidation is
 * discovered lazily on read or enforced by Redis fences inside Lua — so the bridge revalidates.
 */
export const WRITE_OPPORTUNITY_TERMINAL_OUTCOMES = ['propose', 'defer', 'abstain', 'expired'] as const;
export type WriteOpportunityTerminalOutcome = (typeof WRITE_OPPORTUNITY_TERMINAL_OUTCOMES)[number];

/** Mirrors the WriteOpportunity invalidators minus `expired`, which is a terminal outcome here. */
export const WRITE_OPPORTUNITY_LINEAGE_INVALIDATION_REASONS = [
  'source_corrected',
  'source_forgotten',
  'scope_revoked',
  'superseded',
] as const;
export type WriteOpportunityLineageInvalidationReason = (typeof WRITE_OPPORTUNITY_LINEAGE_INVALIDATION_REASONS)[number];

export interface WriteOpportunityLineageState {
  /** Present once the lineage is dead; absorbing, and never re-presentable. */
  readonly invalidatedReason?: WriteOpportunityLineageInvalidationReason;
  /** generation -> the disposition that closed it. */
  readonly terminalGenerations: ReadonlyMap<number, WriteOpportunityTerminalOutcome>;
}

export interface RecordWriteOpportunityTerminalInput {
  readonly ownerUserId: string;
  readonly dedupeLineage: string;
  readonly generation: number;
  readonly outcome: WriteOpportunityTerminalOutcome;
  readonly recordedAt: number;
}

export interface InvalidateWriteOpportunityLineageInput {
  readonly ownerUserId: string;
  readonly dedupeLineage: string;
  readonly reason: WriteOpportunityLineageInvalidationReason;
  readonly recordedAt: number;
}

export class WriteOpportunityTerminalConflictError extends Error {
  constructor(
    readonly dedupeLineage: string,
    readonly generation: number,
    readonly existingOutcome: string,
  ) {
    super(`terminal_outcome_conflict: ${dedupeLineage}:${generation} is already terminal as ${existingOutcome}`);
    this.name = 'WriteOpportunityTerminalConflictError';
  }
}

export interface WriteOpportunityTerminalLedger {
  recordTerminal(input: RecordWriteOpportunityTerminalInput): Promise<void>;
  recordInvalidated(input: InvalidateWriteOpportunityLineageInput): Promise<void>;
  /** Every requested lineage is present in the result; unknown lineages default to empty. */
  readLineageStates(
    ownerUserId: string,
    dedupeLineages: readonly string[],
  ): Promise<Map<string, WriteOpportunityLineageState>>;
}

export const EMPTY_WRITE_OPPORTUNITY_LINEAGE_STATE: WriteOpportunityLineageState = Object.freeze({
  terminalGenerations: new Map<number, WriteOpportunityTerminalOutcome>(),
});

/** Admission-shaped projection: `${dedupeLineage}:${generation}` keys that are already closed. */
export function terminalGenerationKeysFrom(states: ReadonlyMap<string, WriteOpportunityLineageState>): Set<string> {
  const keys = new Set<string>();
  for (const [dedupeLineage, state] of states) {
    for (const generation of state.terminalGenerations.keys()) {
      keys.add(`${dedupeLineage}:${generation}`);
    }
  }
  return keys;
}
