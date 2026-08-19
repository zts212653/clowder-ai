import { proactiveMemoryAbstentionInputSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { AsrPersonMemoryContractTrial } from '../domains/memory/people/AsrPersonMemoryContractTrial.js';
import type { WriteOpportunityDeliveryStore } from '../domains/memory/people/WriteOpportunityDeliveryStore.js';
import { resolveWriteOpportunityDispositionBinding } from '../domains/memory/people/WriteOpportunityDispositionBinding.js';
import {
  WriteOpportunityTerminalConflictError,
  type WriteOpportunityTerminalLedger,
} from '../domains/memory/people/WriteOpportunityTerminalLedger.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { recordWriteOpportunityRouteError } from './write-opportunity-route-telemetry.js';

export interface CallbackRecordProactiveMemoryAbstentionDeps {
  registry: InvocationRegistry;
  writeOpportunityDeliveryStore?: WriteOpportunityDeliveryStore;
  writeOpportunityTerminalLedger?: WriteOpportunityTerminalLedger;
}

type ResolvedDispositionBinding = Extract<
  Awaited<ReturnType<typeof resolveWriteOpportunityDispositionBinding>>,
  { status: 'resolved' }
>;

async function closeAbstention(
  binding: ResolvedDispositionBinding,
  reasonCode: string,
  ownerUserId: string,
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CallbackRecordProactiveMemoryAbstentionDeps,
  now: number,
) {
  const terminalLedger = deps.writeOpportunityTerminalLedger;
  if (!terminalLedger) {
    return reply.code(503).send({
      error: 'write_opportunity_disposition_unavailable',
      reason: 'write_opportunity_terminal_ledger_unavailable',
    });
  }
  const disposition = new AsrPersonMemoryContractTrial().recordDeliveredDisposition(binding.record, {
    v: 1,
    opportunityId: binding.record.opportunityId,
    generation: binding.record.generation,
    recordedAt: now,
    disposition: 'abstain',
    reasonCode,
  });
  if (disposition.status === 'rejected') {
    return reply.code(409).send({ error: 'write_opportunity_disposition_rejected', reason: disposition.reason });
  }
  try {
    await terminalLedger.recordTerminal({
      ownerUserId,
      dedupeLineage: binding.record.dedupeLineage,
      generation: binding.record.generation,
      outcome: 'abstain',
      recordedAt: now,
    });
  } catch (error) {
    request.log.warn({ err: error }, 'write opportunity abstention terminal record rejected');
    if (error instanceof WriteOpportunityTerminalConflictError) {
      recordWriteOpportunityRouteError('already_disposed');
      return reply.code(409).send({ error: 'write_opportunity_generation_conflict' });
    }
    recordWriteOpportunityRouteError('terminal_ledger_unavailable');
    return reply.code(503).send({ error: 'write_opportunity_terminal_authority_unavailable' });
  }
  return { status: 'recorded' };
}

export function registerCallbackRecordProactiveMemoryAbstentionRoutes(
  app: FastifyInstance,
  deps: CallbackRecordProactiveMemoryAbstentionDeps,
): void {
  app.post('/api/callbacks/record-proactive-memory-abstention', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const parsed = proactiveMemoryAbstentionInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', details: parsed.error.issues });
    if (!(await deps.registry.isLatest(auth.invocationId))) return { status: 'stale_ignored' };

    const now = Date.now();
    const binding = await resolveWriteOpportunityDispositionBinding({
      store: deps.writeOpportunityDeliveryStore,
      terminalLedger: deps.writeOpportunityTerminalLedger,
      ref: parsed.data.writeOpportunityRef,
      ownerUserId: auth.userId,
      invocationId: auth.invocationId,
      now,
    });
    if (binding.status === 'rejected') {
      return reply.code(409).send({ error: 'write_opportunity_ref_rejected', reason: binding.reason });
    }
    if (binding.status === 'absent') return { status: 'recorded' };
    return closeAbstention(binding, parsed.data.reasonCode, auth.userId, request, reply, deps, now);
  });
}
