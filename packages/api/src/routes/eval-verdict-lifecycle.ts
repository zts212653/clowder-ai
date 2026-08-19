import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { requireConnectorWriteNetworkGuard } from '../config/connector-secret-write-guards.js';
import {
  buildCapabilityWakeupClosureImport,
  CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID,
} from '../infrastructure/harness-eval/capability-wakeup-closure-import.js';
import { getEvalCatOverride } from '../infrastructure/harness-eval/domain/eval-domain-override.js';
import type { EvalReleaseTruthResolver } from '../infrastructure/harness-eval/eval-release-truth-resolver.js';
import { EvalReleaseTruthError } from '../infrastructure/harness-eval/eval-release-truth-resolver.js';
import { loadEvalVerdictLifecycleRoot } from '../infrastructure/harness-eval/hub/eval-hub-lifecycle-projection.js';
import { loadReevalCaseRoot } from '../infrastructure/harness-eval/reeval-case-root.js';
import { ReevalCaseCommandError, ReevalCaseService } from '../infrastructure/harness-eval/reeval-case-service.js';
import { ReevalClosureProjectionError } from '../infrastructure/harness-eval/reeval-closure.js';
import { buildLifecycleOpenedEvent } from '../infrastructure/harness-eval/reeval-closure-bootstrap.js';
import type { IReevalClosureEventLog } from '../infrastructure/harness-eval/reeval-closure-event-log.js';
import {
  ReevalClosureCommandError,
  ReevalClosureService,
} from '../infrastructure/harness-eval/reeval-closure-service.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';

export interface EvalVerdictLifecycleRoutesOptions {
  harnessFeedbackRoot: string;
  eventLog?: IReevalClosureEventLog;
  redis?: Redis;
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
  releaseTruth?: Pick<EvalReleaseTruthResolver, 'verifyMainLanded' | 'verifyLiveActive'>;
  now?: () => string;
}

const CALLER_IDENTITY_FIELDS = ['actor', 'principal', 'catId', 'userId', 'verdictId'] as const;

function sessionUserId(request: FastifyRequest): string | undefined {
  const value = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function rejectCallerIdentity(body: Record<string, unknown>, reply: FastifyReply): boolean {
  const field = CALLER_IDENTITY_FIELDS.find((name) => Object.hasOwn(body, name));
  if (!field) return false;
  reply.status(400).send({ error: `caller-authored actor or identity field '${field}' is forbidden` });
  return true;
}

type LifecycleActor = { kind: 'cat' | 'cvo'; id: string };

function requireCommandBody(request: FastifyRequest, reply: FastifyReply): Record<string, unknown> | undefined {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    reply.status(400).send({ error: 'lifecycle command body must be an object' });
    return undefined;
  }
  const commandBody = body as Record<string, unknown>;
  return rejectCallerIdentity(commandBody, reply) ? undefined : commandBody;
}

function requireCvoActor(
  request: FastifyRequest,
  reply: FastifyReply,
  ownerSessionUserId: string | undefined,
): LifecycleActor | undefined {
  if (!ownerSessionUserId) {
    reply.status(403).send({ error: 'owner browser session required for reassignment or suppression' });
    return undefined;
  }
  const networkError = requireConnectorWriteNetworkGuard(request);
  if (networkError) {
    reply.status(networkError.status).send({ error: networkError.error });
    return undefined;
  }
  const ownerError = resolveOwnerGate(ownerSessionUserId, {
    errorMessage: 'Verdict lifecycle governance can only be modified by the configured owner',
  });
  if (ownerError) {
    reply.status(ownerError.status).send({ error: ownerError.error });
    return undefined;
  }
  return { kind: 'cvo', id: ownerSessionUserId };
}

function requireCatActor(request: FastifyRequest, reply: FastifyReply): LifecycleActor | undefined {
  if (!request.callbackPrincipal) {
    reply.status(403).send({ error: 'callback or agent-key cat principal required for lifecycle writeback' });
    return undefined;
  }
  return { kind: 'cat', id: request.callbackPrincipal.catId };
}

function requireLifecycleActor(
  request: FastifyRequest,
  reply: FastifyReply,
  commandBody: Record<string, unknown>,
): LifecycleActor | undefined {
  const ownerSessionUserId = sessionUserId(request);
  if (!request.callbackPrincipal && !ownerSessionUserId) {
    reply.status(401).send({ error: 'callback, agent-key, or owner session authentication required' });
    return undefined;
  }
  const type = typeof commandBody.type === 'string' ? commandBody.type : '';
  if (type === 'suppress') return requireCvoActor(request, reply, ownerSessionUserId);
  if (type === 'reassign_owner' && !request.callbackPrincipal) {
    return requireCvoActor(request, reply, ownerSessionUserId);
  }
  return requireCatActor(request, reply);
}

function mapLifecycleError(error: unknown, reply: FastifyReply) {
  if (error instanceof EvalReleaseTruthError) {
    return reply.status(error.code === 'invalid_commit' ? 400 : 409).send({ error: error.code, detail: error.message });
  }
  if (error instanceof ReevalCaseCommandError) {
    const status = error.code === 'root_not_found' ? 404 : error.code === 'invalid_command' ? 400 : 409;
    return reply.status(status).send({ error: error.code, detail: error.message });
  }
  if (error instanceof ReevalClosureCommandError) {
    const status =
      error.code === 'root_not_found'
        ? 404
        : error.code === 'idempotency_collision' ||
            error.code === 'eval_authority_unavailable' ||
            error.code === 'reeval_sla_unavailable' ||
            error.code === 'bootstrap_unavailable'
          ? 409
          : 400;
    return reply.status(status).send({ error: error.code, detail: error.message });
  }
  if (error instanceof ReevalClosureProjectionError) {
    const status = error.code === 'authority_mismatch' ? 403 : 409;
    return reply.status(status).send({ error: error.code, detail: error.message });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return reply.status(500).send({ error: 'lifecycle_write_failed', detail });
}

async function executeLifecycleCommand(
  service: Pick<ReevalClosureService | ReevalCaseService, 'execute'>,
  actor: LifecycleActor,
  commandBody: Record<string, unknown>,
  verdictId: string,
  reply: FastifyReply,
) {
  try {
    const result = await service.execute(actor, { ...commandBody, verdictId });
    if (result.outcome === 'conflict') {
      return reply.status(409).send({ error: 'sequence_conflict', actualSequence: result.actualSequence });
    }
    return result;
  } catch (error) {
    return mapLifecycleError(error, reply);
  }
}

export const evalVerdictLifecycleRoutes: FastifyPluginAsync<EvalVerdictLifecycleRoutesOptions> = async (app, opts) => {
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

  const service = opts.eventLog
    ? new ReevalClosureService({
        eventLog: opts.eventLog,
        loadRoot: async (verdictId) => {
          const resolved = loadEvalVerdictLifecycleRoot(opts.harnessFeedbackRoot, verdictId);
          if (!resolved || !opts.redis) return resolved?.projectorRoot;
          const override = await getEvalCatOverride(opts.redis, resolved.artifact.domainId);
          return override ? { ...resolved.projectorRoot, assignedEvalCatId: override.catId } : resolved.projectorRoot;
        },
        loadBootstrap: async (verdictId) => {
          if (verdictId === CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID) {
            return buildCapabilityWakeupClosureImport().bootstrapEvents;
          }
          const resolved = loadEvalVerdictLifecycleRoot(opts.harnessFeedbackRoot, verdictId);
          if (!resolved || resolved.artifact.verdict === 'keep_observe') return undefined;
          return [buildLifecycleOpenedEvent(resolved.artifact)];
        },
        ...(opts.now ? { now: opts.now } : {}),
      })
    : undefined;
  const caseService =
    opts.eventLog && opts.releaseTruth
      ? new ReevalCaseService({
          eventLog: opts.eventLog,
          releaseTruth: opts.releaseTruth,
          loadRoot: async (verdictId) => {
            const unresolved = loadReevalCaseRoot(opts.harnessFeedbackRoot, verdictId);
            if (!unresolved || !opts.redis) return unresolved?.projectorRoot;
            const override = await getEvalCatOverride(opts.redis, unresolved.requestedRoot.domainId);
            return loadReevalCaseRoot(opts.harnessFeedbackRoot, verdictId, override?.catId)?.projectorRoot;
          },
          ...(opts.now ? { now: opts.now } : {}),
        })
      : undefined;

  app.post('/api/eval-verdicts/:verdictId/lifecycle-events', async (request, reply) => {
    if (!service) return reply.status(503).send({ error: 'canonical lifecycle persistence unavailable' });
    const commandBody = requireCommandBody(request, reply);
    if (!commandBody) return;
    const actor = requireLifecycleActor(request, reply, commandBody);
    if (!actor) return;
    const { verdictId } = request.params as { verdictId: string };
    const resolved = loadEvalVerdictLifecycleRoot(opts.harnessFeedbackRoot, verdictId);
    if (resolved?.artifact.schemaVersion === 2) {
      if (!caseService) return reply.status(503).send({ error: 'verified release truth unavailable' });
      return executeLifecycleCommand(caseService, actor, commandBody, verdictId, reply);
    }
    return executeLifecycleCommand(service, actor, commandBody, verdictId, reply);
  });
};
