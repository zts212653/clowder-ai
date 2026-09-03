import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { ThreadMeetingArtifactDispatcher } from '../domains/signal-intake/ThreadMeetingArtifactDispatcher.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

interface F296AlphaDynamicCanaryRouteOptions extends FastifyPluginOptions {
  readonly enabled: boolean;
  readonly threadStore: Pick<IThreadStore, 'get'>;
  readonly dispatcher: Pick<ThreadMeetingArtifactDispatcher, 'deliverAlphaDynamicCanary'>;
  readonly invocationTracker: Pick<InvocationTracker, 'getExecutionId'>;
}

const INVOCATION_WAIT_MS = 5_000;
const INVOCATION_POLL_MS = 10;

interface F296AlphaDynamicCanaryRequest {
  Params: { threadId: string };
  Body: { runId?: unknown };
}

export async function f296AlphaDynamicCanaryRoutes(
  app: FastifyInstance,
  options: F296AlphaDynamicCanaryRouteOptions,
): Promise<void> {
  app.post<F296AlphaDynamicCanaryRequest>('/api/threads/:threadId/f296-alpha-dynamic-canary', (request, reply) =>
    handleCanary(request, reply, options),
  );
}

async function handleCanary(
  request: FastifyRequest<F296AlphaDynamicCanaryRequest>,
  reply: FastifyReply,
  options: F296AlphaDynamicCanaryRouteOptions,
): Promise<unknown> {
  if (!options.enabled) return reply.status(404).send({ error: 'Not found' });
  const ownerId = resolveStrictUserId(request);
  if (!ownerId) return reply.status(401).send({ error: 'Identity required' });
  const { threadId } = request.params;
  const thread = await options.threadStore.get(threadId);
  if (!thread) return reply.status(404).send({ error: 'Thread not found' });
  if (!canAccessThread(thread, ownerId)) return reply.status(403).send({ error: 'Access denied' });
  const runId = request.body?.runId;
  if (
    !request.body ||
    Object.keys(request.body).length !== 1 ||
    typeof runId !== 'string' ||
    !/^[0-9a-f]{40}$/.test(runId)
  ) {
    return reply.status(400).send({ error: 'Invalid canary run id', code: 'ALPHA_DYNAMIC_CANARY_INVALID' });
  }

  let receipt: Awaited<ReturnType<ThreadMeetingArtifactDispatcher['deliverAlphaDynamicCanary']>>;
  try {
    receipt = await options.dispatcher.deliverAlphaDynamicCanary({ ownerId, threadId, runId });
  } catch {
    return reply
      .status(409)
      .send({ error: 'Canonical dynamic producer unavailable', code: 'ALPHA_DYNAMIC_CANARY_UNAVAILABLE' });
  }
  if (!receipt.started) {
    return reply
      .status(409)
      .send({ error: 'Canonical dynamic producer not started', code: 'ALPHA_DYNAMIC_CANARY_BUSY' });
  }
  const invocationId = await awaitInvocationId({
    tracker: options.invocationTracker,
    threadId,
    catId: receipt.targetCatId,
    timeoutMs: INVOCATION_WAIT_MS,
    pollMs: INVOCATION_POLL_MS,
  });
  if (!invocationId) {
    return reply
      .status(409)
      .send({ error: 'Canonical dynamic invocation unavailable', code: 'ALPHA_DYNAMIC_CANARY_BUSY' });
  }
  return reply.send({
    status: 'processing',
    invocationId,
    producer: 'meeting_artifact',
    opportunityKind: 'memory_write_opportunity',
  });
}

async function awaitInvocationId(input: {
  readonly tracker: Pick<InvocationTracker, 'getExecutionId'>;
  readonly threadId: string;
  readonly catId: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
}): Promise<string | null> {
  const deadline = Date.now() + Math.max(1, input.timeoutMs);
  while (Date.now() <= deadline) {
    const invocationId = input.tracker.getExecutionId(input.threadId, input.catId);
    if (invocationId) return invocationId;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, input.pollMs)));
  }
  return null;
}
