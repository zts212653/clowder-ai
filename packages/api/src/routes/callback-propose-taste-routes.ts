/** Cat-authenticated F221 proposal admission; original owner approval remains the only writer. */
import { generateProposalId, type TasteProposal } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { TasteMemoryLifecycleStore } from '../domains/memory/taste/TasteMemoryLifecycleStore.js';
import type { TasteRepository } from '../domains/taste/services/TasteRepository.js';
import { eligibleTasteOrigin, readTasteProposalOrigin } from '../domains/taste/services/taste-proposal-source.js';
import type { ITasteProposalStore } from '../domains/taste/stores/ports/TasteProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { registerCallbackAuthHook, requireCallbackAuth } from './callback-auth-prehandler.js';
import {
  resolveTasteProposalInput,
  type TasteProposalInput,
  tasteProposalInputSchema,
  tasteProposalRetryMatches,
} from './taste-proposal-input.js';
import { publishTasteProposal } from './wave2-proposal-publication.js';

type CallbackRecord = NonNullable<ReturnType<typeof requireCallbackAuth>>;

export interface ProposeTasteDeps {
  registry: InvocationRegistry;
  tasteProposalStore: ITasteProposalStore;
  socketManager: SocketManager;
  messageStore?: IMessageStore;
  approvalIngress: ApprovalIngress;
  tasteRepository?: TasteRepository;
  lifecycleStore?: Pick<TasteMemoryLifecycleStore, 'isReadable'>;
}

/** Register as a Fastify plugin so callback auth remains scoped to this route. */
export const callbackProposeTasteRoutes: FastifyPluginAsync<ProposeTasteDeps> = async (app, opts) => {
  registerCallbackAuthHook(app, opts.registry);
  app.post('/api/callbacks/propose-taste', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = tasteProposalInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    if (!(await opts.registry.isLatest(record.invocationId))) return { status: 'stale_ignored' };
    const origin = await resolveInvocationOrigin(record, opts.messageStore);
    if (typeof origin !== 'string') return reply.status(origin.statusCode).send(origin.body);
    return submitTasteProposal(record, parsed.data, origin, opts, reply);
  });
};

async function submitTasteProposal(
  record: CallbackRecord,
  input: TasteProposalInput,
  originMessageId: string,
  opts: ProposeTasteDeps,
  reply: FastifyReply,
) {
  // Read the original outcome before resolving a correction against a potentially newer target.
  const cached = await opts.tasteProposalStore.getDedupProposalId(record.userId, input.clientRequestId);
  if (cached) return recoverTasteProposal(record, cached, input, opts, reply);
  if (!('target' in input) && input.sourceMessageId && input.sourceMessageId !== originMessageId) {
    return reply.status(400).send({ error: 'sourceMessageId must match the authenticated invocation origin' });
  }
  const resolved = await resolveTasteProposalInput(input, record.userId, originMessageId, opts);
  if ('statusCode' in resolved) return reply.status(resolved.statusCode).send(resolved.body);

  const proposalId = generateProposalId();
  const winningId = await opts.tasteProposalStore.reserveDedup(record.userId, resolved.clientRequestId, proposalId);
  if (winningId !== proposalId) return recoverTasteProposal(record, winningId, input, opts, reply, true);
  const originRef = { kind: 'message' as const, threadId: record.threadId, messageId: originMessageId };
  let proposal: TasteProposal;
  try {
    proposal = await opts.tasteProposalStore.create({
      ...resolved,
      proposalId,
      userId: record.userId,
      catId: record.catId,
      threadId: record.threadId,
      approvalOriginRef: originRef,
    });
  } catch (error) {
    // Both stores release only an empty reservation; a lost create response retains the committed identity.
    try {
      await opts.tasteProposalStore.releaseDedup(record.userId, resolved.clientRequestId, proposalId);
    } catch {
      /* Keep the original error. */
    }
    throw error;
  }
  await publishTasteProposal(opts.approvalIngress, opts.tasteProposalStore, proposal, originRef);
  return { proposalId: proposal.id, status: proposal.status };
}

async function recoverTasteProposal(
  record: CallbackRecord,
  proposalId: string,
  input: TasteProposalInput,
  opts: ProposeTasteDeps,
  reply: FastifyReply,
  reservationLoser = false,
) {
  const proposal = await opts.tasteProposalStore.get(proposalId);
  if (!proposal)
    return reply
      .status(503)
      .header('retry-after', '1')
      .send({ error: 'Proposal reservation is in flight; retry the same request', status: 'retryable' });
  if (
    proposal.userId === record.userId &&
    proposal.catId === record.catId &&
    proposal.threadId !== record.threadId &&
    proposal.publication?.state === 'staged'
  ) {
    return reply.status(409).send({
      error: 'Staged proposal recovery must run in its original thread',
      status: 'origin_thread_required',
      sourceThreadId: proposal.threadId,
    });
  }
  if (!tasteProposalRetryMatches(proposal, input, record))
    return reply.status(409).send({ error: 'client_request_conflict' });
  const originRef = await readTasteProposalOrigin(proposal, opts.messageStore);
  if (!originRef) return reply.status(409).send({ error: 'origin_not_eligible' });
  const recovered = proposal.publication?.state === 'staged';
  if (reservationLoser && proposal.publication?.state !== 'anchored') {
    return reply
      .status(503)
      .header('retry-after', '1')
      .send({ error: 'Proposal publication is in flight; retry the same request', status: 'retryable' });
  }
  if (proposal.publication?.state === 'staged' || proposal.publication?.state === 'anchored') {
    await publishTasteProposal(opts.approvalIngress, opts.tasteProposalStore, proposal, originRef);
  }
  return { proposalId: proposal.id, status: proposal.status, ...(recovered ? { recovered: true } : { deduped: true }) };
}

async function resolveInvocationOrigin(
  record: CallbackRecord,
  messages: IMessageStore | undefined,
): Promise<string | { statusCode: number; body: { error: string } }> {
  const messageId = record.originTriggerMessageId ?? record.a2aTriggerMessageId;
  if (!messageId)
    return { statusCode: 400, body: { error: 'Exact source message is required for an approval proposal' } };
  if (!(await eligibleTasteOrigin(messages, messageId, record)))
    return { statusCode: 409, body: { error: 'origin_not_eligible' } };
  return messageId;
}
