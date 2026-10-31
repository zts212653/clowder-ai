/**
 * F221 Phase B: cat-side propose-taste callback route.
 *
 * POST /api/callbacks/propose-taste
 *   Cat-auth. Creates a TasteProposal (status=pending) for operator review in
 *   the F246 Approval Hub. Idempotent via clientRequestId. No file writes
 *   at propose time — writing happens only on approve (Task 7).
 *
 * The companion approve/reject endpoints are user-authenticated and live in
 * taste-proposal-decision-routes.ts.
 */

import {
  type ApprovalOriginRef,
  type CatId,
  generateProposalId,
  type TasteProposal,
  tasteMemoryCorrectionProposalInputSchema,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { TasteMemoryLifecycleStore } from '../domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryReader } from '../domains/memory/taste/TasteMemoryReader.js';
import { sourcePathFromTasteAnchor } from '../domains/memory/taste/taste-memory-identity.js';
import type { TasteRepository } from '../domains/taste/services/TasteRepository.js';
import type {
  CreateTasteProposalInput,
  ITasteProposalStore,
} from '../domains/taste/stores/ports/TasteProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { registerCallbackAuthHook, requireCallbackAuth } from './callback-auth-prehandler.js';
import { publishTasteProposal } from './wave2-proposal-publication.js';

const TASTE_DIMENSIONS = [
  'relationship-stance',
  'cognitive-honesty',
  'architecture-aesthetics',
  'visual-quality',
  'authentic-expression',
  'system-philosophy',
  'creative-craft',
] as const;

const createTasteSchema = z
  .object({
    scene: z.string().min(1).max(2000),
    quote: z.string().min(1).max(2000),
    takeaway: z.string().trim().min(1).max(500).optional(),
    tags: z.array(z.string().min(1).max(50)).min(1).max(10),
    dimension: z.enum(TASTE_DIMENSIONS),
    privacy: z.enum(['public', 'sensitive']),
    sourceMessageId: z.string().min(1).optional(),
    clientRequestId: z.string().min(1).max(200),
  })
  .strict();

const proposeSchema = z.union([createTasteSchema, tasteMemoryCorrectionProposalInputSchema]);

type CallbackRecord = NonNullable<ReturnType<typeof requireCallbackAuth>>;
type ProposalInput = Omit<
  CreateTasteProposalInput,
  'proposalId' | 'userId' | 'catId' | 'threadId' | 'approvalOriginRef' | 'clientRequestId'
> & { clientRequestId: string };
type InputFailure = { statusCode: number; body: Record<string, unknown> };

export interface ProposeTasteDeps {
  registry: InvocationRegistry;
  tasteProposalStore: ITasteProposalStore;
  socketManager: SocketManager;
  messageStore?: IMessageStore;
  approvalIngress: ApprovalIngress;
  tasteRepository?: TasteRepository;
  lifecycleStore?: Pick<TasteMemoryLifecycleStore, 'isReadable'>;
}

/**
 * Fastify plugin — must be registered via `app.register()` so the callback auth
 * preHandler hook is scoped to this route.  Plain function registration on the
 * top-level app skips the hook (Fastify encapsulation) → 401 unknown_invocation.
 */
export const callbackProposeTasteRoutes: FastifyPluginAsync<ProposeTasteDeps> = async (app, opts) => {
  const { registry } = opts;

  registerCallbackAuthHook(app, registry);

  app.post('/api/callbacks/propose-taste', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = proposeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const resolved = await resolveProposalInput(parsed.data, record, opts);
    if ('statusCode' in resolved) return reply.status(resolved.statusCode).send(resolved.body);
    return submitTasteProposal(record, resolved, opts, reply);
  });
};

async function resolveProposalInput(
  parsed: z.infer<typeof proposeSchema>,
  record: CallbackRecord,
  opts: ProposeTasteDeps,
): Promise<ProposalInput | InputFailure> {
  if (!('target' in parsed)) return parsed;
  if (!opts.tasteRepository) return { statusCode: 503, body: { error: 'Taste source unavailable' } };
  const sourcePath = sourcePathFromTasteAnchor(parsed.target.sourceAnchor);
  if (!sourcePath) return { statusCode: 400, body: { error: 'Invalid Taste correction target' } };
  const memory = await new TasteMemoryReader(opts.tasteRepository, record.userId, {
    lifecycle: opts.lifecycleStore,
  }).read({ ownerUserId: record.userId, sourcePath, revision: parsed.target.expectedRevision });
  if (!memory) {
    return {
      statusCode: 409,
      body: { error: 'Taste source changed or is unavailable', code: 'stale_revision' },
    };
  }
  const patch = parsed.target.suggestedPatch;
  const dimension = patch.dimension ?? memory.payload.dimension;
  if (!dimension) {
    return { statusCode: 409, body: { error: 'Taste source has no reviewable dimension', code: 'not_available' } };
  }
  const quotes = patch.quotes ?? memory.payload.quotes;
  return {
    scene: patch.scene ?? memory.payload.scene,
    quote: quotes[0] ?? memory.payload.quotes[0] ?? '',
    ...(patch.takeaway === null ? {} : { takeaway: patch.takeaway ?? memory.payload.takeaway }),
    tags: patch.tags ?? memory.payload.tags,
    dimension,
    privacy: memory.visibility === 'private' ? 'sensitive' : 'public',
    sourceMessageId: record.originTriggerMessageId ?? record.a2aTriggerMessageId,
    clientRequestId: parsed.clientRequestId,
    correctionTarget: parsed.target,
  };
}

async function submitTasteProposal(
  record: CallbackRecord,
  proposalInput: ProposalInput,
  opts: ProposeTasteDeps,
  reply: FastifyReply,
) {
  const retry = await recoverCachedProposal(record, proposalInput.clientRequestId, opts, reply);
  if (retry) return retry;
  if (!(await opts.registry.isLatest(record.invocationId))) return { status: 'stale_ignored' };
  const proposalId = generateProposalId();
  const winningId = await opts.tasteProposalStore.reserveDedup(
    record.userId,
    proposalInput.clientRequestId,
    proposalId,
  );
  if (winningId !== proposalId) return recoverReservationWinner(record, winningId, opts, reply);
  const originRef = deriveTasteOriginRef(record, proposalInput.sourceMessageId, record.threadId);
  const proposal = await createReservedProposal(record, proposalId, proposalInput, originRef, opts.tasteProposalStore);
  await publishTasteProposal(opts.approvalIngress, opts.tasteProposalStore, proposal, originRef);
  return { proposalId: proposal.id, status: proposal.status };
}

async function recoverCachedProposal(
  record: CallbackRecord,
  clientRequestId: string,
  opts: ProposeTasteDeps,
  reply: FastifyReply,
) {
  const cached = await opts.tasteProposalStore.getDedupProposalId(record.userId, clientRequestId);
  if (!cached) return null;
  const existing = await opts.tasteProposalStore.get(cached);
  if (!existing) return null;
  if (existing.publication?.state === 'staged' && existing.threadId !== record.threadId) {
    reply.status(409);
    return {
      error: 'Staged proposal recovery must run in its original thread',
      status: 'origin_thread_required',
      sourceThreadId: existing.threadId,
    };
  }
  if (existing.publication?.state === 'staged') {
    await publishExistingTasteProposal(record, existing, opts);
    return { proposalId: existing.id, status: 'pending', recovered: true };
  }
  if (existing.publication?.state === 'anchored') await publishExistingTasteProposal(record, existing, opts);
  return { proposalId: existing.id, status: existing.status, deduped: true };
}

async function recoverReservationWinner(
  record: CallbackRecord,
  winningId: string,
  opts: ProposeTasteDeps,
  reply: FastifyReply,
) {
  const existing = await opts.tasteProposalStore.get(winningId);
  if (!existing) return retryable(reply, 'Proposal reservation in-flight by a concurrent request; retry shortly');
  if (existing.publication?.state !== 'anchored') {
    return retryable(reply, 'Proposal publication is still in-flight; retry shortly');
  }
  await publishExistingTasteProposal(record, existing, opts);
  return { proposalId: existing.id, status: existing.status, deduped: true };
}

async function publishExistingTasteProposal(
  record: CallbackRecord,
  proposal: TasteProposal,
  opts: ProposeTasteDeps,
): Promise<void> {
  const originRef =
    proposal.approvalOriginRef ?? deriveTasteOriginRef(record, proposal.sourceMessageId, proposal.threadId);
  await publishTasteProposal(opts.approvalIngress, opts.tasteProposalStore, proposal, originRef);
}

async function createReservedProposal(
  record: CallbackRecord,
  proposalId: string,
  proposalInput: ProposalInput,
  originRef: ApprovalOriginRef,
  store: ITasteProposalStore,
): Promise<TasteProposal> {
  try {
    return await store.create({
      proposalId,
      userId: record.userId,
      catId: record.catId,
      threadId: record.threadId,
      ...proposalInput,
      approvalOriginRef: originRef,
    });
  } catch (error) {
    try {
      await store.releaseDedup(record.userId, proposalInput.clientRequestId, proposalId);
    } catch {
      // Best-effort release; preserve the original create error.
    }
    throw error;
  }
}

function retryable(reply: FastifyReply, error: string) {
  reply.status(503).header('retry-after', '1');
  return { error, status: 'retryable' };
}

/**
 * Derive origin ref for taste proposals: prefer explicit sourceMessageId from the cat,
 * then fall back to the invocation trigger message, then event origin.
 */
function deriveTasteOriginRef(
  record: { originTriggerMessageId?: string; a2aTriggerMessageId?: string; invocationId: string; catId: CatId },
  sourceMessageId: string | undefined,
  threadId: string,
): ApprovalOriginRef {
  const messageId = sourceMessageId ?? record.originTriggerMessageId ?? record.a2aTriggerMessageId;
  if (messageId) {
    return { kind: 'message', threadId, messageId };
  }
  return {
    kind: 'event',
    anchor: `invocation:${record.invocationId}`,
    summary: `Taste proposal from ${record.catId}`,
    threadId,
  };
}
