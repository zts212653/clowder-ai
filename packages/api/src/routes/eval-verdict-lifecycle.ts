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
import { type EvalLifecycleSpace, lifecycleSpaceOf } from '../infrastructure/harness-eval/lifecycle-space.js';
import {
  frictionLifecycleV3QuarantineDiagnostic,
  loadReevalCaseRoot,
} from '../infrastructure/harness-eval/reeval-case-root.js';
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
  /** F257 × F266: the owner whose lifecycle space is the install's (repository history + runtime verdicts). */
  configuredOwnerUserId: string;
  /** The install space's canonical log. */
  eventLog?: IReevalClosureEventLog;
  /** F257: the artifact store whose owner partitions hold runtime verdicts and their lifecycle roots. */
  artifactStoreRoot?: string;
  /** F257: opens another owner's canonical log, for the lifecycles of the runtime verdicts that owner published. */
  ownerEventLog?: (ownerUserId: string) => IReevalClosureEventLog;
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

/** The authenticated caller: who acts, and whose runtime verdicts the command may reach. */
interface LifecycleCaller {
  actor: LifecycleActor;
  ownerUserId: string;
}

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
): LifecycleCaller | undefined {
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
  return { actor: { kind: 'cvo', id: ownerSessionUserId }, ownerUserId: ownerSessionUserId };
}

function requireCatActor(request: FastifyRequest, reply: FastifyReply): LifecycleCaller | undefined {
  if (!request.callbackPrincipal) {
    reply.status(403).send({ error: 'callback or agent-key cat principal required for lifecycle writeback' });
    return undefined;
  }
  return {
    actor: { kind: 'cat', id: request.callbackPrincipal.catId },
    ownerUserId: request.callbackPrincipal.userId,
  };
}

function requireLifecycleCaller(
  request: FastifyRequest,
  reply: FastifyReply,
  commandBody: Record<string, unknown>,
): LifecycleCaller | undefined {
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

interface LifecycleSpaceLog {
  space: EvalLifecycleSpace;
  eventLog: IReevalClosureEventLog;
}

/**
 * The space a command acts in: the caller's owner's, and nothing outside it. The
 * configured owner's space is the install's, so its commands reach the repository's
 * history and that owner's runtime verdicts alike; any other owner reaches only the
 * runtime verdicts it published.
 */
function resolveLifecycleSpace(
  opts: EvalVerdictLifecycleRoutesOptions,
  ownerUserId: string,
): LifecycleSpaceLog | { status: 404 | 503; error: string } {
  const space = lifecycleSpaceOf(ownerUserId, opts);
  if (!space) return { status: 404, error: 'root_not_found' };
  const eventLog = space.kind === 'install' ? opts.eventLog : opts.ownerEventLog?.(ownerUserId);
  if (!eventLog) return { status: 503, error: 'canonical lifecycle persistence unavailable' };
  return { space, eventLog };
}

function createClosureService(opts: EvalVerdictLifecycleRoutesOptions, { space, eventLog }: LifecycleSpaceLog) {
  return new ReevalClosureService({
    eventLog,
    loadRoot: async (verdictId) => {
      const resolved = loadEvalVerdictLifecycleRoot(space, verdictId);
      if (resolved?.artifact.schemaVersion === 3) return undefined;
      if (!resolved || !opts.redis) return resolved?.projectorRoot;
      const override = await getEvalCatOverride(opts.redis, resolved.artifact.domainId);
      return override ? { ...resolved.projectorRoot, assignedEvalCatId: override.catId } : resolved.projectorRoot;
    },
    loadBootstrap: async (verdictId) => {
      if (space.kind === 'install' && verdictId === CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID) {
        return buildCapabilityWakeupClosureImport().bootstrapEvents;
      }
      const resolved = loadEvalVerdictLifecycleRoot(space, verdictId);
      if (resolved?.artifact.schemaVersion === 3) return undefined;
      if (!resolved || resolved.artifact.verdict === 'keep_observe') return undefined;
      return [buildLifecycleOpenedEvent(resolved.artifact)];
    },
    ...(opts.now ? { now: opts.now } : {}),
  });
}

function createCaseService(opts: EvalVerdictLifecycleRoutesOptions, { space, eventLog }: LifecycleSpaceLog) {
  if (!opts.releaseTruth) return undefined;
  return new ReevalCaseService({
    eventLog,
    releaseTruth: opts.releaseTruth,
    loadRoot: async (verdictId) => {
      const unresolved = loadReevalCaseRoot(space, verdictId);
      if (!unresolved || !opts.redis) return unresolved?.projectorRoot;
      const override = await getEvalCatOverride(opts.redis, unresolved.requestedRoot.domainId);
      return loadReevalCaseRoot(space, verdictId, override?.catId)?.projectorRoot;
    },
    ...(opts.now ? { now: opts.now } : {}),
  });
}

/** Routes a command to the service for its root's schema, inside the resolved space. */
function executeInLifecycleSpace(
  opts: EvalVerdictLifecycleRoutesOptions,
  lifecycle: LifecycleSpaceLog,
  actor: LifecycleActor,
  commandBody: Record<string, unknown>,
  verdictId: string,
  reply: FastifyReply,
) {
  const resolved = loadEvalVerdictLifecycleRoot(lifecycle.space, verdictId);
  if (resolved?.artifact.schemaVersion === 3) {
    return reply.status(409).send(frictionLifecycleV3QuarantineDiagnostic());
  }
  if (resolved?.artifact.schemaVersion === 2) {
    const caseService = createCaseService(opts, lifecycle);
    if (!caseService) return reply.status(503).send({ error: 'verified release truth unavailable' });
    return executeLifecycleCommand(caseService, actor, commandBody, verdictId, reply);
  }
  return executeLifecycleCommand(createClosureService(opts, lifecycle), actor, commandBody, verdictId, reply);
}

export const evalVerdictLifecycleRoutes: FastifyPluginAsync<EvalVerdictLifecycleRoutesOptions> = async (app, opts) => {
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

  app.post('/api/eval-verdicts/:verdictId/lifecycle-events', async (request, reply) => {
    if (!opts.eventLog && !opts.ownerEventLog) {
      return reply.status(503).send({ error: 'canonical lifecycle persistence unavailable' });
    }
    const commandBody = requireCommandBody(request, reply);
    if (!commandBody) return;
    const caller = requireLifecycleCaller(request, reply, commandBody);
    if (!caller) return;
    const { verdictId } = request.params as { verdictId: string };
    const lifecycle = resolveLifecycleSpace(opts, caller.ownerUserId);
    if ('error' in lifecycle) return reply.status(lifecycle.status).send({ error: lifecycle.error });
    return executeInLifecycleSpace(opts, lifecycle, caller.actor, commandBody, verdictId, reply);
  });
};
