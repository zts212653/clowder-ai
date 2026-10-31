import type { DeliveredWriteOpportunityRecordV1 } from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AsrPersonMemoryContractTrial } from '../domains/memory/people/AsrPersonMemoryContractTrial.js';
import type { PersonMemoryStore, StoredPersonMemoryCandidate } from '../domains/memory/people/PersonMemoryStore.js';
import type { WriteOpportunityDeliveryStore } from '../domains/memory/people/WriteOpportunityDeliveryStore.js';
import { resolveWriteOpportunityDispositionBinding } from '../domains/memory/people/WriteOpportunityDispositionBinding.js';
import type { WriteOpportunityTerminalLedger } from '../domains/memory/people/WriteOpportunityTerminalLedger.js';
import { WriteOpportunityTerminalConflictError } from '../domains/memory/people/WriteOpportunityTerminalLedger.js';
import type { PreparedPersonMemoryProposal } from './person-memory-proposal-evidence.js';
import { recordWriteOpportunityRouteError } from './write-opportunity-route-telemetry.js';

export interface ProposalWriteOpportunityDeps {
  writeOpportunityDeliveryStore?: WriteOpportunityDeliveryStore;
  writeOpportunityTerminalLedger?: WriteOpportunityTerminalLedger;
}

export type ProposalOpportunityBinding =
  | { status: 'absent'; recordedAt: number }
  | {
      status: 'resolved';
      record: DeliveredWriteOpportunityRecordV1;
      terminalLedger: WriteOpportunityTerminalLedger;
      recordedAt: number;
    };

export async function prepareProposalOpportunityBinding(
  prepared: PreparedPersonMemoryProposal,
  deps: ProposalWriteOpportunityDeps,
  reply: FastifyReply,
): Promise<ProposalOpportunityBinding | null> {
  const recordedAt = Date.now();
  const binding = await resolveWriteOpportunityDispositionBinding({
    store: deps.writeOpportunityDeliveryStore,
    terminalLedger: deps.writeOpportunityTerminalLedger,
    ref: prepared.body.writeOpportunityRef,
    ownerUserId: prepared.auth.userId,
    invocationId: prepared.auth.invocationId,
    now: recordedAt,
  });
  if (binding.status === 'rejected') {
    reply.code(409).send({ error: 'write_opportunity_ref_rejected', reason: binding.reason });
    return null;
  }
  if (binding.status === 'absent') return { status: 'absent', recordedAt };
  if (!deps.writeOpportunityTerminalLedger) {
    reply.code(503).send({
      error: 'write_opportunity_disposition_unavailable',
      reason: 'write_opportunity_terminal_ledger_unavailable',
    });
    return null;
  }
  return { ...binding, terminalLedger: deps.writeOpportunityTerminalLedger, recordedAt };
}

/** Close only after the canonical F276 candidate has been durably staged and source-revalidated. */
export async function closeProposalOpportunity(input: {
  binding: ProposalOpportunityBinding;
  candidate: StoredPersonMemoryCandidate;
  prior: StoredPersonMemoryCandidate | null;
  auth: PreparedPersonMemoryProposal['auth'];
  request: FastifyRequest;
  reply: FastifyReply;
  store: PersonMemoryStore;
}): Promise<boolean> {
  const { binding, candidate, prior, auth, request, reply, store } = input;
  if (binding.status === 'absent') return false;
  const disposition = new AsrPersonMemoryContractTrial().recordDeliveredDisposition(binding.record, {
    v: 1,
    opportunityId: binding.record.opportunityId,
    generation: binding.record.generation,
    recordedAt: binding.recordedAt,
    disposition: 'propose',
    destination: { proposalContract: 'F276.CaptureCandidate.v1', proposalId: candidate.candidateId },
  });
  if (disposition.status === 'rejected') {
    if (!prior) await store.abortStaged(candidate.candidateId, disposition.reason);
    reply.code(409).send({ error: 'write_opportunity_disposition_rejected', reason: disposition.reason });
    return true;
  }
  try {
    await binding.terminalLedger.recordTerminal({
      ownerUserId: auth.userId,
      dedupeLineage: binding.record.dedupeLineage,
      generation: binding.record.generation,
      outcome: 'propose',
      recordedAt: binding.recordedAt,
    });
  } catch (error) {
    request.log.warn({ err: error }, 'write opportunity proposal terminal record rejected');
    if (error instanceof WriteOpportunityTerminalConflictError) {
      recordWriteOpportunityRouteError('already_disposed');
      if (!prior) await store.abortStaged(candidate.candidateId, 'write_opportunity_generation_conflict');
      reply.code(409).send({ error: 'write_opportunity_generation_conflict' });
      return true;
    }
    recordWriteOpportunityRouteError('terminal_ledger_unavailable');
    reply.code(503).send({ error: 'write_opportunity_terminal_authority_unavailable' });
    return true;
  }
  return false;
}
