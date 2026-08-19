import { PAW_FEEL_DISPOSITION_STATES, type PawFeelDispositionState } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requireConnectorWriteNetworkGuard } from '../config/connector-secret-write-guards.js';
import {
  type IPawFeelDutyConfigStore,
  PawFeelDutyConfigStoreError,
} from '../infrastructure/harness-eval/paw-feel-disposition/duty-config-store.js';
import type { PawFeelDutyReceiptService } from '../infrastructure/harness-eval/paw-feel-disposition/duty-receipt.js';
import type {
  PawFeelCaptureIntentSidecar,
  PawFeelCaptureService,
} from '../infrastructure/harness-eval/paw-feel-disposition/hot-intake.js';
import type {
  PawFeelDispositionReadModel,
  PawFeelInboxQuery,
} from '../infrastructure/harness-eval/paw-feel-disposition/read-model.js';
import {
  type PawFeelBulkCommandResult,
  PawFeelDispositionService,
  PawFeelDispositionServiceError,
} from '../infrastructure/harness-eval/paw-feel-disposition/service.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook, requireCallbackPrincipal } from './callback-auth-prehandler.js';
import {
  PawFeelBundleActionBodySchema,
  PawFeelCaptureBodySchema,
  PawFeelDutyUpdateBodySchema,
  PawFeelInboxQuerySchema,
  PawFeelSingleActionBodySchema,
  PawFeelTriageBodySchema,
  pawFeelSingleActionCommand,
} from './paw-feel-disposition-contracts.js';

export interface PawFeelDispositionRoutesOptions {
  readModel?: Pick<PawFeelDispositionReadModel, 'list'>;
  dispositionService?: Pick<PawFeelDispositionService, 'executeMany' | 'executeBundle'>;
  captureService?: Pick<PawFeelCaptureService, 'capture'>;
  captureIntentSidecar?: Pick<PawFeelCaptureIntentSidecar, 'declare'>;
  dutyConfigStore?: IPawFeelDutyConfigStore;
  dutyReceiptService?: Pick<PawFeelDutyReceiptService, 'reconcile'>;
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

function sessionUserId(request: FastifyRequest): string | undefined {
  const value = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireSession(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const userId = sessionUserId(request);
  if (!userId) reply.status(401).send({ error: 'Session required' });
  return userId;
}

function parseInboxQuery(request: FastifyRequest, reply: FastifyReply): PawFeelInboxQuery | undefined {
  const parsed = PawFeelInboxQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    reply.status(400).send({ error: 'invalid paw-feel inbox query', details: parsed.error.issues });
    return undefined;
  }
  let states: PawFeelDispositionState[] | undefined;
  if (parsed.data.states) {
    const requested = parsed.data.states.split(',').filter(Boolean);
    const invalid = requested.find(
      (state): state is string => !PAW_FEEL_DISPOSITION_STATES.includes(state as PawFeelDispositionState),
    );
    if (invalid) {
      reply.status(400).send({ error: `invalid paw-feel state: ${invalid}` });
      return undefined;
    }
    states = requested as PawFeelDispositionState[];
  }
  return {
    ...(states ? { states } : {}),
    ...(parsed.data.sourceCatId ? { sourceCatId: parsed.data.sourceCatId } : {}),
    ...(parsed.data.sourceMessageId ? { sourceMessageId: parsed.data.sourceMessageId } : {}),
    ...(parsed.data.overdueOnly ? { overdueOnly: parsed.data.overdueOnly === 'true' } : {}),
    ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
    ...(parsed.data.sort ? { sort: parsed.data.sort } : {}),
  };
}

async function listInbox(
  readModel: Pick<PawFeelDispositionReadModel, 'list'> | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
  overrides: PawFeelInboxQuery = {},
) {
  if (!readModel) return reply.status(503).send({ error: 'paw-feel disposition ledger unavailable' });
  const query = parseInboxQuery(request, reply);
  if (!query) return;
  return readModel.list({ ...query, ...overrides });
}

function mapServiceError(error: unknown, reply: FastifyReply) {
  if (error instanceof PawFeelDispositionServiceError) {
    const status =
      error.code === 'signal_not_found'
        ? 404
        : error.code === 'invalid_principal'
          ? 403
          : error.code === 'duplicate_target_not_found' ||
              error.code === 'duplicate_cycle' ||
              error.code === 'identity_collision' ||
              error.code === 'idempotency_collision'
            ? 409
            : 400;
    return reply.status(status).send({ error: error.code, detail: error.message });
  }
  return reply.status(500).send({
    error: 'paw_feel_triage_failed',
    detail: error instanceof Error ? error.message : String(error),
  });
}

async function reconcileDutyReceipt(
  service: Pick<PawFeelDutyReceiptService, 'reconcile'> | undefined,
  actorCatId: string,
) {
  if (!service) return {};
  try {
    return { dutyReceipt: await service.reconcile(actorCatId) };
  } catch (error) {
    return {
      dutyReceiptWarning: {
        code: 'receipt_reconciliation_failed' as const,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function triage(
  service: Pick<PawFeelDispositionService, 'executeMany'> | undefined,
  receiptService: Pick<PawFeelDutyReceiptService, 'reconcile'> | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!service) return reply.status(503).send({ error: 'paw-feel disposition ledger unavailable' });
  const principal = requireCallbackPrincipal(request, reply);
  if (!principal) return;
  const parsed = PawFeelTriageBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'invalid paw-feel triage commands', details: parsed.error.issues });
  }
  try {
    const results: PawFeelBulkCommandResult[] = await service.executeMany(
      { kind: 'cat', id: principal.catId },
      parsed.data.commands,
    );
    return { results, ...(await reconcileDutyReceipt(receiptService, principal.catId)) };
  } catch (error) {
    return mapServiceError(error, reply);
  }
}

function requireCvo(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const userId = requireSession(request, reply);
  if (!userId) return undefined;
  const networkError = requireConnectorWriteNetworkGuard(request);
  if (networkError) {
    reply.status(networkError.status).send({ error: networkError.error });
    return undefined;
  }
  const ownerError = resolveOwnerGate(userId, {
    errorMessage: 'Paw-feel duty may only be assigned by the configured owner',
  });
  if (ownerError) {
    reply.status(ownerError.status).send({ error: ownerError.error });
    return undefined;
  }
  return userId;
}

function mapDutyError(error: unknown, reply: FastifyReply) {
  if (error instanceof PawFeelDutyConfigStoreError) {
    const status = error.code === 'unauthorized' ? 403 : error.code === 'version_conflict' ? 409 : 400;
    return reply.status(status).send({
      error: error.code,
      detail: error.message,
      ...(error.actualVersion !== undefined ? { actualVersion: error.actualVersion } : {}),
    });
  }
  return reply.status(500).send({
    error: 'paw_feel_duty_update_failed',
    detail: error instanceof Error ? error.message : String(error),
  });
}

export const pawFeelDispositionRoutes: FastifyPluginAsync<PawFeelDispositionRoutesOptions> = async (app, opts) => {
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

  app.get('/api/paw-feel/inbox', async (request, reply) => {
    if (!requireSession(request, reply)) return;
    return listInbox(opts.readModel, request, reply);
  });

  app.get('/api/paw-feel/source/:messageId', async (request, reply) => {
    if (!requireSession(request, reply)) return;
    const { messageId } = request.params as { messageId: string };
    return listInbox(opts.readModel, request, reply, { sourceMessageId: messageId });
  });

  app.get('/api/paw-feel/duty', async (request, reply) => {
    if (!requireSession(request, reply)) return;
    if (!opts.dutyConfigStore) return reply.status(503).send({ error: 'paw-feel duty config unavailable' });
    return { config: await opts.dutyConfigStore.read() };
  });

  app.patch('/api/paw-feel/duty', async (request, reply) => {
    if (!opts.dutyConfigStore) return reply.status(503).send({ error: 'paw-feel duty config unavailable' });
    const userId = requireCvo(request, reply);
    if (!userId) return;
    const parsed = PawFeelDutyUpdateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid paw-feel duty config',
        details: parsed.error.issues,
      });
    }
    try {
      return { config: await opts.dutyConfigStore.update({ kind: 'cvo', id: userId }, parsed.data) };
    } catch (error) {
      return mapDutyError(error, reply);
    }
  });

  app.post('/api/paw-feel/actions', async (request, reply) => {
    if (!opts.dispositionService) {
      return reply.status(503).send({ error: 'paw-feel disposition ledger unavailable' });
    }
    const userId = requireCvo(request, reply);
    if (!userId) return;
    const parsed = PawFeelSingleActionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid paw-feel action', details: parsed.error.issues });
    }
    if (parsed.data.type !== 'fix') {
      return reply.status(403).send({
        error: 'paw_feel_cat_signature_required',
        detail: 'duplicate and no_action require callback-authenticated duty-cat confirmation',
      });
    }
    try {
      const results = await opts.dispositionService.executeMany({ kind: 'cvo', id: userId }, [
        pawFeelSingleActionCommand(parsed.data),
      ]);
      return { results, ...(await reconcileDutyReceipt(opts.dutyReceiptService, `cvo:${userId}`)) };
    } catch (error) {
      return mapServiceError(error, reply);
    }
  });

  app.post('/api/paw-feel/bundle-actions', async (request, reply) => {
    if (!opts.dispositionService) {
      return reply.status(503).send({ error: 'paw-feel disposition ledger unavailable' });
    }
    const userId = requireCvo(request, reply);
    if (!userId) return;
    const parsed = PawFeelBundleActionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid paw-feel bundle action', details: parsed.error.issues });
    }
    const actions = [parsed.data.action, ...(parsed.data.exceptions ?? []).map((entry) => entry.action)];
    if (actions.some((action) => action.type !== 'fix')) {
      return reply.status(403).send({
        error: 'paw_feel_cat_signature_required',
        detail: 'bundle duplicate and no_action require callback-authenticated duty-cat confirmation',
      });
    }
    try {
      const result = await opts.dispositionService.executeBundle({ kind: 'cvo', id: userId }, parsed.data);
      return { ...result, ...(await reconcileDutyReceipt(opts.dutyReceiptService, `cvo:${userId}`)) };
    } catch (error) {
      return mapServiceError(error, reply);
    }
  });

  app.get('/api/callbacks/paw-feel-inbox', async (request, reply) => {
    if (!requireCallbackPrincipal(request, reply)) return;
    return listInbox(opts.readModel, request, reply);
  });

  app.post('/api/callbacks/paw-feel-triage', async (request, reply) => {
    return triage(opts.dispositionService, opts.dutyReceiptService, request, reply);
  });

  app.post('/api/callbacks/paw-feel-bundle-triage', async (request, reply) => {
    if (!opts.dispositionService) {
      return reply.status(503).send({ error: 'paw-feel disposition ledger unavailable' });
    }
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const parsed = PawFeelBundleActionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid paw-feel bundle action', details: parsed.error.issues });
    }
    try {
      const result = await opts.dispositionService.executeBundle({ kind: 'cat', id: principal.catId }, parsed.data);
      return { ...result, ...(await reconcileDutyReceipt(opts.dutyReceiptService, principal.catId)) };
    } catch (error) {
      return mapServiceError(error, reply);
    }
  });

  app.post('/api/callbacks/paw-feel-capture', async (request, reply) => {
    if (!opts.captureService) {
      return reply.status(503).send({ error: 'paw-feel typed capture unavailable' });
    }
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const parsed = PawFeelCaptureBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid paw-feel capture', details: parsed.error.issues });
    }
    try {
      return await opts.captureService.capture({ kind: 'cat', id: principal.catId }, parsed.data.sourceMessageId);
    } catch (error) {
      return reply.status(400).send({
        error: 'paw_feel_capture_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/callbacks/paw-feel-capture-intent', async (request, reply) => {
    if (!opts.captureIntentSidecar) {
      return reply.status(503).send({ error: 'paw-feel typed capture intent unavailable' });
    }
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'invocation') {
      return reply.status(400).send({
        error: 'paw_feel_capture_intent_requires_invocation',
        detail: 'a future source message can only be bound to the authenticated current invocation',
      });
    }
    try {
      return opts.captureIntentSidecar.declare(principal);
    } catch (error) {
      return reply.status(409).send({
        error: 'paw_feel_capture_intent_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
