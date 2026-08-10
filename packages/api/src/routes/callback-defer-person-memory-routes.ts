import { createHash } from 'node:crypto';
import {
  type DeferredPersonMemoryInput,
  deferredPersonMemoryInputSchema,
  deferredPersonMemoryReceiptIdSchema,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  InvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { DeferredPersonMemoryReceiptStore } from '../domains/memory/DeferredPersonMemoryReceiptStore.js';
import { DeferredPersonMemorySourceResolver } from '../domains/memory/DeferredPersonMemorySourceResolver.js';
import type { ProactiveCandidateRegistryMatch } from '../domains/memory/ProactiveCandidateRegistryResolver.js';
import {
  eligibleOwnerMessage,
  ownerMessageSourceRef,
} from '../domains/memory/people/PersonMemorySourceBundleResolver.js';
import { personMemoryDeltaFingerprint } from '../domains/memory/people/person-memory-delta-lineage.js';
import { observePersonMemoryStage } from '../domains/memory/people/person-memory-telemetry.js';
import { normalizeCandidatePhrase } from '../domains/memory/proactive-memory-lexical-noise.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

interface DeferredRegistryResolver {
  resolve(input: { ownerUserId: string; phrase: string }): Promise<ProactiveCandidateRegistryMatch>;
}

export interface CallbackDeferPersonMemoryDeps {
  registry: InvocationRegistry;
  messageStore: Pick<IMessageStore, 'getById'>;
  receiptStore: Pick<DeferredPersonMemoryReceiptStore, 'stage' | 'withdraw' | 'hardForget'>;
  registryResolver: DeferredRegistryResolver;
}

function receiptId(ownerUserId: string, requesterCatId: string, clientRequestId: string): string {
  const digest = createHash('sha256')
    .update(`${ownerUserId}\0${requesterCatId}\0${clientRequestId}`)
    .digest('hex')
    .slice(0, 32);
  return `deferred_person_${digest}`;
}

type CaptureFailure = { statusCode: number; payload: Record<string, unknown> };
type CaptureStep<T> = { status: 'ok'; value: T } | { status: 'handled' } | { status: 'error'; failure: CaptureFailure };

async function prepareCaptureInvocation(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CallbackDeferPersonMemoryDeps,
): Promise<CaptureStep<{ auth: InvocationRecord; body: DeferredPersonMemoryInput; origin: StoredMessage }>> {
  const auth = requireCallbackAuth(request, reply);
  if (!auth) return { status: 'handled' };
  const parsed = deferredPersonMemoryInputSchema.safeParse(request.body);
  if (!parsed.success) {
    return {
      status: 'error',
      failure: { statusCode: 400, payload: { error: 'invalid_request', details: parsed.error.issues } },
    };
  }
  if (!(await deps.registry.isLatest(auth.invocationId))) {
    return { status: 'error', failure: { statusCode: 200, payload: { status: 'stale_ignored' } } };
  }
  const originMessageId = auth.originTriggerMessageId ?? auth.a2aTriggerMessageId;
  if (!originMessageId) {
    return { status: 'error', failure: { statusCode: 400, payload: { error: 'exact_invocation_origin_required' } } };
  }
  const origin = await deps.messageStore.getById(originMessageId);
  if (!eligibleOwnerMessage(origin, { ownerUserId: auth.userId }) || origin.threadId !== auth.threadId) {
    return { status: 'error', failure: { statusCode: 422, payload: { error: 'invocation_origin_not_eligible' } } };
  }
  return { status: 'ok', value: { auth, body: parsed.data, origin } };
}

async function resolveKnownSubject(
  ownerUserId: string,
  subject: string,
  deps: CallbackDeferPersonMemoryDeps,
): Promise<
  CaptureStep<{
    registryMatch: Extract<ProactiveCandidateRegistryMatch, { kind: 'registered_person' | 'registered_entity' }>;
    normalizedSubject: string;
  }>
> {
  const registryMatch = await deps.registryResolver.resolve({ ownerUserId, phrase: subject });
  if (registryMatch.kind !== 'registered_person' && registryMatch.kind !== 'registered_entity') {
    return { status: 'error', failure: { statusCode: 409, payload: { error: 'known_person_not_available' } } };
  }
  const normalizedSubject = normalizeCandidatePhrase(subject);
  return normalizedSubject
    ? { status: 'ok', value: { registryMatch, normalizedSubject } }
    : { status: 'error', failure: { statusCode: 400, payload: { error: 'invalid_subject' } } };
}

type ResolvedSources = Extract<
  Awaited<ReturnType<DeferredPersonMemorySourceResolver['resolve']>>,
  { status: 'resolved' }
>;

async function resolveCaptureSources(
  body: DeferredPersonMemoryInput,
  ownerUserId: string,
  sourceResolver: DeferredPersonMemorySourceResolver,
): Promise<CaptureStep<ResolvedSources>> {
  const resolved = await sourceResolver.resolve(body.sources, ownerUserId);
  if (resolved.status === 'invalid') {
    return { status: 'error', failure: { statusCode: 422, payload: { error: resolved.error } } };
  }
  const preflight = await sourceResolver.revalidate(body.sources, ownerUserId, resolved.bundleDigest);
  return preflight.status === 'invalid'
    ? { status: 'error', failure: { statusCode: 409, payload: { error: preflight.error } } }
    : { status: 'ok', value: resolved };
}

function captureStepResponse(reply: FastifyReply, step: Exclude<CaptureStep<unknown>, { status: 'ok' }>) {
  if (step.status === 'handled') return;
  reply.status(step.failure.statusCode);
  return step.failure.payload;
}

export function registerCallbackDeferPersonMemoryRoutes(
  app: FastifyInstance,
  deps: CallbackDeferPersonMemoryDeps,
): void {
  app.post('/api/callbacks/defer-person-memory', async (request, reply) => {
    const invocation = await prepareCaptureInvocation(request, reply, deps);
    if (invocation.status !== 'ok') return captureStepResponse(reply, invocation);
    const { auth, body, origin } = invocation.value;
    const subject = await resolveKnownSubject(auth.userId, body.subject, deps);
    if (subject.status !== 'ok') return captureStepResponse(reply, subject);
    const { registryMatch, normalizedSubject } = subject.value;
    const sourceResolver = new DeferredPersonMemorySourceResolver(deps.messageStore);
    const sources = await resolveCaptureSources(body, auth.userId, sourceResolver);
    if (sources.status !== 'ok') return captureStepResponse(reply, sources);
    const resolved = sources.value;

    const id = receiptId(auth.userId, auth.catId, body.clientRequestId);
    const now = Date.now();
    const dedupeHash = personMemoryDeltaFingerprint(registryMatch, resolved.coordinates);
    const staged = await observePersonMemoryStage(
      'capture',
      () =>
        deps.receiptStore.stage({
          receiptId: id,
          ownerUserId: auth.userId,
          requesterCatId: auth.catId,
          invocationId: auth.invocationId,
          originMessageRef: ownerMessageSourceRef(origin),
          subject: body.subject,
          normalizedSubject,
          registryBinding: registryMatch,
          sourceCoordinates: resolved.coordinates,
          sourceBundleDigest: resolved.bundleDigest,
          dedupeHash,
          ready: resolved.ready,
          createdAt: now,
        }),
      (result) => {
        if (result.outcome === 'conflict') return 'conflict';
        return result.outcome === 'created' ? 'success' : 'replayed';
      },
    );
    if (staged.outcome === 'already_proposed') {
      reply.status(409);
      return { error: 'delta_already_proposed', proposalId: staged.proposalId };
    }
    if (staged.outcome === 'conflict') {
      reply.status(409);
      return { error: 'deferred_receipt_conflict' };
    }

    const postStage = await sourceResolver.revalidate(body.sources, auth.userId, resolved.bundleDigest);
    if (postStage.status === 'invalid') {
      if (staged.outcome === 'created') await deps.receiptStore.hardForget(auth.userId, id);
      reply.status(409);
      return { error: 'source_drift' };
    }
    return {
      receiptId: staged.receipt.receiptId,
      status: staged.receipt.state,
      deduped: staged.outcome !== 'created',
    };
  });

  const receiptActionSchema = z.object({ receiptId: deferredPersonMemoryReceiptIdSchema }).strict();
  app.post('/api/callbacks/person-memory/deferred/withdraw', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const parsed = receiptActionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'invalid_request', details: parsed.error.issues };
    }
    const result = await deps.receiptStore.withdraw(auth.userId, parsed.data.receiptId, Date.now());
    switch (result.outcome) {
      case 'conflict':
        return reply.status(409).send({ error: 'receipt_not_withdrawable' });
      case 'not_available':
        return reply.status(404).send({ error: 'not_available' });
      case 'withdrawn':
      case 'replayed':
        return {
          receiptId: result.receipt.receiptId,
          status: 'withdrawn',
          replayed: result.outcome === 'replayed',
        };
    }
  });

  app.post('/api/callbacks/person-memory/deferred/forget', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const parsed = receiptActionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'invalid_request', details: parsed.error.issues };
    }
    const result = await deps.receiptStore.hardForget(auth.userId, parsed.data.receiptId);
    if (result.outcome === 'proposal_bound') {
      reply.status(409);
      return { error: 'proposal_bound', proposalId: result.proposalId };
    }
    return { receiptId: parsed.data.receiptId, status: result.outcome };
  });
}
