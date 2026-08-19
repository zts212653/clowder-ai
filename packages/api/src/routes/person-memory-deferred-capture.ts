import { type DeferredPersonMemoryInput, deferredPersonMemoryInputSchema } from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  InvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type {
  DeferredPersonMemoryReceiptStore,
  RearmDeferredPersonMemoryReceiptResult,
  StageDeferredPersonMemoryReceiptResult,
} from '../domains/memory/DeferredPersonMemoryReceiptStore.js';
import { DeferredPersonMemorySourceResolver } from '../domains/memory/DeferredPersonMemorySourceResolver.js';
import type { ProactiveCandidateRegistryMatch } from '../domains/memory/ProactiveCandidateRegistryResolver.js';
import {
  eligibleOwnerMessage,
  ownerMessageSourceRef,
} from '../domains/memory/people/PersonMemorySourceBundleResolver.js';
import { personMemoryDeltaFingerprint } from '../domains/memory/people/person-memory-delta-lineage.js';
import { observePersonMemoryStage } from '../domains/memory/people/person-memory-telemetry.js';
import type { WriteOpportunityDeliveryStore } from '../domains/memory/people/WriteOpportunityDeliveryStore.js';
import {
  WriteOpportunityTerminalConflictError,
  type WriteOpportunityTerminalLedger,
} from '../domains/memory/people/WriteOpportunityTerminalLedger.js';
import { normalizeCandidatePhrase } from '../domains/memory/proactive-memory-lexical-noise.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import {
  deferredPersonMemoryReceiptId,
  invalidateDeferredWriteOpportunity,
  resolveDeferredWriteOpportunity,
} from './person-memory-defer-write-opportunity.js';
import { recordWriteOpportunityRouteError } from './write-opportunity-route-telemetry.js';

interface DeferredRegistryResolver {
  resolve(input: { ownerUserId: string; phrase: string }): Promise<ProactiveCandidateRegistryMatch>;
}

export interface DeferredCaptureDeps {
  registry: InvocationRegistry;
  messageStore: Pick<IMessageStore, 'getById'>;
  receiptStore: Pick<
    DeferredPersonMemoryReceiptStore,
    'stage' | 'withdraw' | 'hardForget' | 'get' | 'rearmWriteOpportunity'
  >;
  registryResolver: DeferredRegistryResolver;
  writeOpportunityDeliveryStore?: WriteOpportunityDeliveryStore;
  writeOpportunityTerminalLedger?: WriteOpportunityTerminalLedger;
}

type CaptureFailure = { statusCode: number; payload: Record<string, unknown> };
type CaptureStep<T> = { status: 'ok'; value: T } | { status: 'handled' } | { status: 'error'; failure: CaptureFailure };

async function prepareCaptureInvocation(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: DeferredCaptureDeps,
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

async function resolveKnownSubject(ownerUserId: string, subject: string, deps: DeferredCaptureDeps) {
  const registryMatch = await deps.registryResolver.resolve({ ownerUserId, phrase: subject });
  if (registryMatch.kind !== 'registered_person' && registryMatch.kind !== 'registered_entity') {
    return { status: 'error', failure: { statusCode: 409, payload: { error: 'known_person_not_available' } } } as const;
  }
  const normalizedSubject = normalizeCandidatePhrase(subject);
  return normalizedSubject
    ? ({ status: 'ok', value: { registryMatch, normalizedSubject } } as const)
    : ({ status: 'error', failure: { statusCode: 400, payload: { error: 'invalid_subject' } } } as const);
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

type DeferredCaptureContext = {
  auth: InvocationRecord;
  body: DeferredPersonMemoryInput;
  registryMatch: Extract<ProactiveCandidateRegistryMatch, { kind: 'registered_person' | 'registered_entity' }>;
  normalizedSubject: string;
  sourceResolver: DeferredPersonMemorySourceResolver;
  resolved: ResolvedSources;
  receiptId: string;
  destinationReceiptId: string;
  now: number;
  lineageResolution: Awaited<ReturnType<typeof resolveDeferredWriteOpportunity>>;
  dedupeHash: string;
  origin: StoredMessage;
};

async function prepareDeferredCapture(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: DeferredCaptureDeps,
): Promise<CaptureStep<DeferredCaptureContext>> {
  const invocation = await prepareCaptureInvocation(request, reply, deps);
  if (invocation.status !== 'ok') return invocation;
  const { auth, body, origin } = invocation.value;
  if (body.writeOpportunityRef && (!deps.writeOpportunityDeliveryStore || !deps.writeOpportunityTerminalLedger)) {
    return {
      status: 'error',
      failure: {
        statusCode: 503,
        payload: {
          error: 'write_opportunity_disposition_unavailable',
          reason: 'write_opportunity_durable_authority_unavailable',
        },
      },
    };
  }
  const subject = await resolveKnownSubject(auth.userId, body.subject, deps);
  if (subject.status !== 'ok') return subject;
  const sourceResolver = new DeferredPersonMemorySourceResolver(deps.messageStore);
  const sources = await resolveCaptureSources(body, auth.userId, sourceResolver);
  if (sources.status !== 'ok') return sources;
  const receiptId = deferredPersonMemoryReceiptId(auth.userId, auth.catId, body.clientRequestId);
  const destinationReceiptId = body.reentryReceipt?.receiptId ?? receiptId;
  const now = Date.now();
  const lineageResolution = await resolveDeferredWriteOpportunity(
    deps,
    body.writeOpportunityRef,
    auth,
    now,
    destinationReceiptId,
  );
  if (lineageResolution.status === 'rejected') {
    return {
      status: 'error',
      failure: {
        statusCode: 409,
        payload: { error: 'write_opportunity_ref_rejected', reason: lineageResolution.reason },
      },
    };
  }
  if (lineageResolution.status !== 'resolved' && body.reentryReceipt) {
    return {
      status: 'error',
      failure: { statusCode: 409, payload: { error: 'write_opportunity_reentry_receipt_unexpected' } },
    };
  }
  if (lineageResolution.status === 'resolved' && lineageResolution.lineage.generation > 1 && !body.reentryReceipt) {
    return {
      status: 'error',
      failure: { statusCode: 409, payload: { error: 'write_opportunity_reentry_receipt_required' } },
    };
  }
  return {
    status: 'ok',
    value: {
      auth,
      body,
      origin,
      ...subject.value,
      sourceResolver,
      resolved: sources.value,
      receiptId,
      destinationReceiptId,
      now,
      lineageResolution,
      dedupeHash: personMemoryDeltaFingerprint(subject.value.registryMatch, sources.value.coordinates),
    },
  };
}

type DeferredStageResult = StageDeferredPersonMemoryReceiptResult | RearmDeferredPersonMemoryReceiptResult;
type AcceptedDeferredStageResult = Extract<DeferredStageResult, { receipt: unknown }>;

async function stageDeferredCapture(
  context: DeferredCaptureContext,
  deps: DeferredCaptureDeps,
): Promise<DeferredStageResult> {
  const { auth, body, lineageResolution, now } = context;
  const reentryReceipt = body.reentryReceipt;
  if (reentryReceipt && lineageResolution.status === 'resolved') {
    return observePersonMemoryStage(
      'capture',
      () =>
        deps.receiptStore.rearmWriteOpportunity({
          ownerUserId: auth.userId,
          receiptId: reentryReceipt.receiptId,
          claimId: reentryReceipt.claimId,
          requesterCatId: auth.catId,
          dedupeHash: context.dedupeHash,
          writeOpportunityLineage: lineageResolution.lineage,
          writeOpportunityReceipt: lineageResolution.receipt,
          now,
        }),
      (result) => (result.outcome === 'rearmed' ? 'success' : 'conflict'),
    );
  }
  return observePersonMemoryStage(
    'capture',
    () =>
      deps.receiptStore.stage({
        receiptId: context.receiptId,
        ownerUserId: auth.userId,
        requesterCatId: auth.catId,
        invocationId: auth.invocationId,
        originMessageRef: ownerMessageSourceRef(context.origin),
        subject: body.subject,
        normalizedSubject: context.normalizedSubject,
        registryBinding: context.registryMatch,
        sourceCoordinates: context.resolved.coordinates,
        sourceBundleDigest: context.resolved.bundleDigest,
        dedupeHash: context.dedupeHash,
        ...(lineageResolution.status === 'resolved' ? { writeOpportunityLineage: lineageResolution.lineage } : {}),
        ...(lineageResolution.status === 'resolved' ? { writeOpportunityReceipt: lineageResolution.receipt } : {}),
        ready: context.resolved.ready,
        createdAt: now,
      }),
    (result) => {
      if (result.outcome === 'conflict') return 'conflict';
      return result.outcome === 'created' ? 'success' : 'replayed';
    },
  );
}

function acceptDeferredStage(reply: FastifyReply, staged: DeferredStageResult): AcceptedDeferredStageResult | null {
  if (staged.outcome === 'not_available') {
    reply.code(409).send({ error: 'write_opportunity_reentry_receipt_not_available' });
    return null;
  }
  if (staged.outcome === 'already_proposed') {
    reply.code(409).send({ error: 'delta_already_proposed', proposalId: staged.proposalId });
    return null;
  }
  if (staged.outcome === 'conflict') {
    reply.code(409).send({ error: 'deferred_receipt_conflict' });
    return null;
  }
  return staged;
}

async function finishDeferredCapture(
  context: DeferredCaptureContext,
  staged: AcceptedDeferredStageResult,
  request: FastifyRequest,
  reply: FastifyReply,
  deps: DeferredCaptureDeps,
) {
  const { auth, body, lineageResolution, now } = context;
  const postStage = await context.sourceResolver.revalidate(body.sources, auth.userId, context.resolved.bundleDigest);
  if (postStage.status === 'invalid') {
    if (staged.outcome === 'created' || staged.outcome === 'rearmed') {
      await deps.receiptStore.hardForget(auth.userId, context.destinationReceiptId);
    }
    if (lineageResolution.status === 'resolved') {
      await invalidateDeferredWriteOpportunity(
        deps,
        request,
        auth.userId,
        { writeOpportunityLineage: lineageResolution.lineage },
        'source_corrected',
      );
    }
    return reply.code(409).send({ error: 'source_drift' });
  }
  if (lineageResolution.status === 'resolved' && deps.writeOpportunityTerminalLedger) {
    try {
      await deps.writeOpportunityTerminalLedger.recordTerminal({
        ownerUserId: auth.userId,
        dedupeLineage: lineageResolution.lineage.dedupeLineage,
        generation: lineageResolution.lineage.generation,
        outcome: 'defer',
        recordedAt: now,
      });
    } catch (error) {
      request.log.warn({ err: error }, 'write opportunity terminal record rejected');
      if (error instanceof WriteOpportunityTerminalConflictError) {
        recordWriteOpportunityRouteError('already_disposed');
        await deps.receiptStore.hardForget(auth.userId, context.destinationReceiptId);
        return reply.code(409).send({ error: 'write_opportunity_generation_conflict' });
      }
      recordWriteOpportunityRouteError('terminal_ledger_unavailable');
      return reply.code(503).send({ error: 'write_opportunity_terminal_authority_unavailable' });
    }
  }
  return {
    receiptId: staged.receipt.receiptId,
    status: staged.receipt.state,
    deduped: staged.outcome !== 'created' && staged.outcome !== 'rearmed',
  };
}

function captureStepResponse(reply: FastifyReply, step: Exclude<CaptureStep<unknown>, { status: 'ok' }>) {
  if (step.status === 'handled') return;
  reply.status(step.failure.statusCode);
  return step.failure.payload;
}

export async function handleDeferredPersonMemoryCapture(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: DeferredCaptureDeps,
) {
  const prepared = await prepareDeferredCapture(request, reply, deps);
  if (prepared.status !== 'ok') return captureStepResponse(reply, prepared);
  const accepted = acceptDeferredStage(reply, await stageDeferredCapture(prepared.value, deps));
  if (!accepted) return;
  return finishDeferredCapture(prepared.value, accepted, request, reply, deps);
}
