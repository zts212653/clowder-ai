import type { FastifyBaseLogger } from 'fastify';
import type { PersonMemoryStore, RedactPersonMemoryItemInput } from '../domains/memory/people/PersonMemoryStore.js';
import type { DeferWriteOpportunityDeps } from './person-memory-defer-write-opportunity.js';
import { preparePersonWriteOpportunityInvalidation } from './person-memory-write-opportunity-route-invalidation.js';

/** The caller already validated the real owner browser session, CSRF and confirmation. */
export async function executeOwnerPersonRedaction(
  deps: DeferWriteOpportunityDeps & { ownerUserId: string; store: PersonMemoryStore },
  command: Pick<RedactPersonMemoryItemInput, 'personId' | 'item' | 'requestId' | 'expectedRevision'>,
  log: FastifyBaseLogger,
) {
  const invalidate = await preparePersonWriteOpportunityInvalidation({
    deps,
    ownerUserId: deps.ownerUserId,
    personId: command.personId,
    reason: 'source_forgotten',
    log,
  });
  const result = await deps.store.redactItem({ ...command, ownerUserId: deps.ownerUserId, redactedAt: Date.now() });
  if (!(await invalidate(result.outcome === 'applied' || result.outcome === 'replayed'))) {
    return { action: 'redact_item' as const, outcome: 'mutation_unavailable' as const };
  }
  return { action: 'redact_item' as const, ...result };
}
