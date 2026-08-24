import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOCAL_REVIEW_MESSAGE_ID_PATTERN } from '../domains/ball-custody/LocalReviewEvidenceProvider.js';
import type { LocalReviewVerdictService } from '../domains/ball-custody/LocalReviewVerdictService.js';
import type { InvocationRecord as CallbackInvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type {
  IInvocationRecordStore,
  InvocationActionLeaseRef,
  InvocationRecord as StoredInvocationRecord,
} from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { getDeletedCallbackThreadGuard } from './callback-scope-helpers.js';

const localReviewVerdictSchema = z
  .object({
    messageId: z.string().regex(LOCAL_REVIEW_MESSAGE_ID_PATTERN),
    actionLeaseRef: z
      .object({ leaseId: z.string().min(1), generation: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();

const localReviewRecoverySchema = z
  .object({
    messageId: z.string().regex(LOCAL_REVIEW_MESSAGE_ID_PATTERN),
    actionLeaseRef: z.object({ leaseId: z.string().min(1), generation: z.number().int().positive() }).strict(),
  })
  .strict();

export interface CallbackLocalReviewVerdictRouteDeps {
  invocationRecordStore?: Pick<IInvocationRecordStore, 'get'>;
  localReviewVerdictService?: Pick<LocalReviewVerdictService, 'record' | 'recover'>;
  threadStore?: Pick<IThreadStore, 'get'>;
}

type CarrierResolution =
  | { ok: true; carrier: InvocationActionLeaseRef }
  | { ok: false; statusCode: 403 | 409 | 503; body: { error: string; code: string } };

function carrierRecordMatchesPrincipal(
  carrierRecord: Pick<StoredInvocationRecord, 'threadId' | 'userId' | 'targetCats'>,
  callbackRecord: Pick<CallbackInvocationRecord, 'threadId' | 'userId' | 'catId'>,
): boolean {
  return (
    carrierRecord.threadId === callbackRecord.threadId &&
    carrierRecord.userId === callbackRecord.userId &&
    carrierRecord.targetCats.includes(callbackRecord.catId)
  );
}

async function resolveActionSuccessorCarrier(
  deps: Pick<CallbackLocalReviewVerdictRouteDeps, 'invocationRecordStore'>,
  record: CallbackInvocationRecord,
  suppliedLeaseRef: InvocationActionLeaseRef | undefined,
): Promise<CarrierResolution> {
  if (!deps.invocationRecordStore) {
    return {
      ok: false,
      statusCode: 503,
      body: { error: 'Invocation carrier read surface is unavailable', code: 'action_lease_preflight_unavailable' },
    };
  }
  const carrierInvocationId = record.parentInvocationId ?? record.invocationId;
  const carrierRecord = await deps.invocationRecordStore.get(carrierInvocationId);
  if (!carrierRecord) {
    return {
      ok: false,
      statusCode: 409,
      body: { error: 'Invocation carrier is unavailable', code: 'action_lease_required' },
    };
  }
  if (!carrierRecordMatchesPrincipal(carrierRecord, record)) {
    return {
      ok: false,
      statusCode: 403,
      body: { error: 'Invocation carrier is outside the callback principal scope', code: 'wrong_principal' },
    };
  }
  const carrier = carrierRecord.actionLeaseCarrier;
  if (!carrier || carrier.kind !== 'action_successor') {
    return {
      ok: false,
      statusCode: 409,
      body: { error: 'Invocation does not carry a local review action lease', code: 'action_lease_required' },
    };
  }
  if (
    suppliedLeaseRef &&
    (suppliedLeaseRef.leaseId !== carrier.leaseId || suppliedLeaseRef.generation !== carrier.generation)
  ) {
    return {
      ok: false,
      statusCode: 409,
      body: { error: 'Provided action lease does not match the invocation carrier', code: 'action_lease_mismatch' },
    };
  }
  return { ok: true, carrier };
}

export function registerCallbackLocalReviewVerdictRoute(
  app: FastifyInstance,
  deps: CallbackLocalReviewVerdictRouteDeps,
): void {
  app.post('/api/callbacks/record-local-review-verdict', async (request, reply) => {
    if (!deps.localReviewVerdictService) {
      reply.status(503);
      return { error: 'Local review verdict service not configured' };
    }
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = localReviewVerdictSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const deletedThreadGuard = await getDeletedCallbackThreadGuard(deps.threadStore, record.threadId);
    if (deletedThreadGuard) {
      reply.status(deletedThreadGuard.statusCode);
      return deletedThreadGuard.body;
    }

    const carrierResolution = await resolveActionSuccessorCarrier(deps, record, parsed.data.actionLeaseRef);
    if (!carrierResolution.ok) {
      reply.status(carrierResolution.statusCode);
      return carrierResolution.body;
    }
    const { carrier } = carrierResolution;

    const result = await deps.localReviewVerdictService.record({
      leaseId: carrier.leaseId,
      generation: carrier.generation,
      messageId: parsed.data.messageId,
      now: Date.now(),
      principal: { catId: record.catId, threadId: record.threadId, tenantScope: record.userId },
    });
    if (result.outcome !== 'committed') {
      reply.status(result.outcome === 'insufficient' ? 422 : 409);
    }
    return result;
  });

  app.post('/api/callbacks/recover-local-review-verdict', async (request, reply) => {
    if (!deps.localReviewVerdictService) {
      reply.status(503);
      return { error: 'Local review verdict service not configured' };
    }
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = localReviewRecoverySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const deletedThreadGuard = await getDeletedCallbackThreadGuard(deps.threadStore, record.threadId);
    if (deletedThreadGuard) {
      reply.status(deletedThreadGuard.statusCode);
      return deletedThreadGuard.body;
    }

    const result = await deps.localReviewVerdictService.recover({
      leaseId: parsed.data.actionLeaseRef.leaseId,
      generation: parsed.data.actionLeaseRef.generation,
      messageId: parsed.data.messageId,
      now: Date.now(),
      principal: { catId: record.catId, threadId: record.threadId, tenantScope: record.userId },
    });
    if (result.outcome !== 'committed') {
      reply.status(result.outcome === 'insufficient' ? 422 : 409);
    }
    return result;
  });
}
