import {
  type ApprovalOriginRef,
  type EventMemoryCorrectionProposal,
  type EventMemoryCorrectionProposalInput,
  eventMemoryCorrectionProposalInputSchema,
  generateProposalId,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  eventMemoryRevision,
  type IEventMemoryStore,
  type StoredEventMemoryLifecycle,
} from '../domains/memory/EventMemoryStore.js';
import type { EventMemoryCorrectionProposalStore } from '../domains/memory/event/EventMemoryCorrectionProposalStore.js';
import { registerCallbackAuthHook, requireCallbackAuth } from './callback-auth-prehandler.js';
import type { EventMemorySourceReaders } from './event-memory-source.js';
import { readEventMemorySource } from './event-memory-source.js';
import { publishEventMemoryCorrectionProposal } from './wave2-proposal-publication.js';

export interface ProposeEventMemoryCorrectionDeps {
  registry: InvocationRegistry;
  eventMemoryStore: Pick<IEventMemoryStore, 'getEvent'>;
  proposalStore: EventMemoryCorrectionProposalStore;
  approvalIngress: ApprovalIngress;
  sourceReaders: EventMemorySourceReaders;
}

export const callbackProposeEventMemoryCorrectionRoutes: FastifyPluginAsync<ProposeEventMemoryCorrectionDeps> = async (
  app,
  opts,
) => {
  registerCallbackAuthHook(app, opts.registry);

  app.post('/api/callbacks/propose-event-memory-correction', async (request, reply) => {
    const actor = requireCallbackAuth(request, reply);
    if (!actor) return;
    const parsed = eventMemoryCorrectionProposalInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    const input = parsed.data;
    const deduped = await recoverDeduplicated(actor, input.clientRequestId, opts, reply);
    if (deduped) return deduped;
    if (!(await opts.registry.isLatest(actor.invocationId))) return { status: 'stale_ignored' };

    const event = await resolveProposalTarget(actor.userId, input, opts, reply);
    if (!event) return;

    const proposalId = generateProposalId();
    const winner = await opts.proposalStore.reserveDedup(actor.userId, input.clientRequestId, proposalId);
    if (winner !== proposalId) {
      return recoverReservationWinner(winner, actor, opts, reply);
    }
    return createAndPublishProposal(proposalId, actor, input, event, opts);
  });
};

type CallbackActor = NonNullable<ReturnType<typeof requireCallbackAuth>>;

async function recoverDeduplicated(
  actor: CallbackActor,
  clientRequestId: string,
  opts: ProposeEventMemoryCorrectionDeps,
  reply: FastifyReply,
) {
  const existingId = await opts.proposalStore.getDedupProposalId(actor.userId, clientRequestId);
  if (!existingId) return null;
  const existing = await opts.proposalStore.get(existingId);
  return existing ? recoverExisting(existing, actor, opts, reply) : null;
}

async function resolveProposalTarget(
  ownerUserId: string,
  input: EventMemoryCorrectionProposalInput,
  opts: ProposeEventMemoryCorrectionDeps,
  reply: FastifyReply,
): Promise<StoredEventMemoryLifecycle | null> {
  const event = opts.eventMemoryStore.getEvent(input.eventId);
  if (!event || event.ownerUserId !== ownerUserId || event.status !== 'active') {
    reply.status(404).send({ error: 'Event not found' });
    return null;
  }
  if (eventMemoryRevision(event) !== input.expectedRevision) {
    reply.status(409).send({ error: 'Revision changed', code: 'stale_revision' });
    return null;
  }
  if ((await readEventMemorySource(event, ownerUserId, opts.sourceReaders)).status !== 'ready') {
    reply.status(409).send({ error: 'Event source unavailable', code: 'source_unavailable' });
    return null;
  }
  return event;
}

async function recoverReservationWinner(
  proposalId: string,
  actor: CallbackActor,
  opts: ProposeEventMemoryCorrectionDeps,
  reply: FastifyReply,
) {
  const existing = await opts.proposalStore.get(proposalId);
  if (existing) return recoverExisting(existing, actor, opts, reply);
  reply.header('retry-after', '1');
  return reply.status(503).send({ error: 'Proposal reservation in-flight', status: 'retryable' });
}

async function createAndPublishProposal(
  proposalId: string,
  actor: CallbackActor,
  input: EventMemoryCorrectionProposalInput,
  event: StoredEventMemoryLifecycle,
  opts: ProposeEventMemoryCorrectionDeps,
) {
  const originRef = approvalOriginOf(actor);
  try {
    const proposal = await opts.proposalStore.create({
      proposalId,
      eventId: event.eventId,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
      suggestedPatch: input.suggestedPatch,
      ownerUserId: actor.userId,
      sourceCatId: actor.catId,
      sourceThreadId: actor.threadId,
      sourceInvocationId: actor.invocationId,
      source: { threadId: event.threadId, messageId: event.messageId },
      clientRequestId: input.clientRequestId,
      approvalOriginRef: originRef,
    });
    await publishEventMemoryCorrectionProposal(opts.approvalIngress, opts.proposalStore, proposal, originRef);
    return { proposalId: proposal.proposalId, status: proposal.status };
  } catch (error) {
    await opts.proposalStore.releaseDedup(actor.userId, input.clientRequestId, proposalId).catch(() => {});
    throw error;
  }
}

async function recoverExisting(
  proposal: EventMemoryCorrectionProposal,
  actor: { userId: string; threadId: string; invocationId: string; catId: string },
  opts: ProposeEventMemoryCorrectionDeps,
  reply: FastifyReply,
) {
  if (proposal.ownerUserId !== actor.userId) return reply.status(404).send({ error: 'Proposal not found' });
  if (proposal.publication?.state === 'staged') {
    if (proposal.sourceThreadId !== actor.threadId) {
      return reply.status(409).send({ error: 'Staged recovery requires its original thread' });
    }
    await publishEventMemoryCorrectionProposal(
      opts.approvalIngress,
      opts.proposalStore,
      proposal,
      proposal.approvalOriginRef,
    );
    return { proposalId: proposal.proposalId, status: proposal.status, recovered: true };
  }
  return { proposalId: proposal.proposalId, status: proposal.status, deduped: true };
}

function approvalOriginOf(actor: {
  invocationId: string;
  threadId: string;
  catId: string;
  originTriggerMessageId?: string;
  a2aTriggerMessageId?: string;
}): ApprovalOriginRef {
  const messageId = actor.originTriggerMessageId ?? actor.a2aTriggerMessageId;
  return messageId
    ? { kind: 'message', threadId: actor.threadId, messageId }
    : {
        kind: 'event',
        anchor: `invocation:${actor.invocationId}`,
        summary: `Event memory correction from ${actor.catId}`,
        threadId: actor.threadId,
      };
}
