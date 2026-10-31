import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  EMPTY_WRITE_OPPORTUNITY_LINEAGE_STATE,
  type InvalidateWriteOpportunityLineageInput,
  type RecordWriteOpportunityTerminalInput,
  WRITE_OPPORTUNITY_LINEAGE_INVALIDATION_REASONS,
  WRITE_OPPORTUNITY_TERMINAL_OUTCOMES,
  type WriteOpportunityLineageInvalidationReason,
  type WriteOpportunityLineageState,
  WriteOpportunityTerminalConflictError,
  type WriteOpportunityTerminalLedger,
  type WriteOpportunityTerminalOutcome,
} from './WriteOpportunityTerminalLedger.js';
import {
  INVALIDATE_WRITE_OPPORTUNITY_LINEAGE_LUA,
  parseWriteOpportunityGenerationField,
  RECORD_WRITE_OPPORTUNITY_TERMINAL_LUA,
  WRITE_OPPORTUNITY_INVALIDATED_FIELD,
  WriteOpportunityTerminalKeys,
  writeOpportunityGenerationField,
} from './write-opportunity-terminal-redis-contract.js';

function isTerminalOutcome(value: string): value is WriteOpportunityTerminalOutcome {
  return (WRITE_OPPORTUNITY_TERMINAL_OUTCOMES as readonly string[]).includes(value);
}

function isInvalidationReason(value: string): value is WriteOpportunityLineageInvalidationReason {
  return (WRITE_OPPORTUNITY_LINEAGE_INVALIDATION_REASONS as readonly string[]).includes(value);
}

export class RedisWriteOpportunityTerminalLedger implements WriteOpportunityTerminalLedger {
  constructor(private readonly redis: RedisClient) {}

  async recordTerminal(input: RecordWriteOpportunityTerminalInput): Promise<void> {
    const key = WriteOpportunityTerminalKeys.lineage(input.ownerUserId, input.dedupeLineage);
    const result = String(
      await this.redis.eval(
        RECORD_WRITE_OPPORTUNITY_TERMINAL_LUA,
        1,
        key,
        writeOpportunityGenerationField(input.generation),
        input.outcome,
        String(input.recordedAt),
      ),
    );
    if (result.startsWith('OUTCOME_CONFLICT:')) {
      throw new WriteOpportunityTerminalConflictError(
        input.dedupeLineage,
        input.generation,
        result.slice('OUTCOME_CONFLICT:'.length),
      );
    }
    if (result === 'CONFLICT') {
      throw new Error(`terminal_ledger_key_conflict: ${key} is not a hash`);
    }
  }

  async recordInvalidated(input: InvalidateWriteOpportunityLineageInput): Promise<void> {
    const key = WriteOpportunityTerminalKeys.lineage(input.ownerUserId, input.dedupeLineage);
    const result = String(
      await this.redis.eval(
        INVALIDATE_WRITE_OPPORTUNITY_LINEAGE_LUA,
        1,
        key,
        WRITE_OPPORTUNITY_INVALIDATED_FIELD,
        input.reason,
        String(input.recordedAt),
      ),
    );
    if (result === 'CONFLICT') {
      throw new Error(`terminal_ledger_key_conflict: ${key} is not a hash`);
    }
  }

  async readLineageStates(
    ownerUserId: string,
    dedupeLineages: readonly string[],
  ): Promise<Map<string, WriteOpportunityLineageState>> {
    const unique = [...new Set(dedupeLineages)];
    const states = new Map<string, WriteOpportunityLineageState>();
    if (unique.length === 0) return states;

    const pipeline = this.redis.pipeline();
    for (const dedupeLineage of unique) {
      pipeline.hgetall(WriteOpportunityTerminalKeys.lineage(ownerUserId, dedupeLineage));
    }
    const results = (await pipeline.exec()) ?? [];

    unique.forEach((dedupeLineage, index) => {
      const entry = results[index];
      const raw = entry && !entry[0] ? (entry[1] as Record<string, string> | null) : null;
      if (!raw || Object.keys(raw).length === 0) {
        states.set(dedupeLineage, EMPTY_WRITE_OPPORTUNITY_LINEAGE_STATE);
        return;
      }
      const terminalGenerations = new Map<number, WriteOpportunityTerminalOutcome>();
      for (const [field, value] of Object.entries(raw)) {
        const generation = parseWriteOpportunityGenerationField(field);
        if (generation === null || !isTerminalOutcome(value)) continue;
        terminalGenerations.set(generation, value);
      }
      const invalidatedRaw = raw[WRITE_OPPORTUNITY_INVALIDATED_FIELD];
      states.set(dedupeLineage, {
        ...(invalidatedRaw && isInvalidationReason(invalidatedRaw) ? { invalidatedReason: invalidatedRaw } : {}),
        terminalGenerations,
      });
    });

    return states;
  }
}
