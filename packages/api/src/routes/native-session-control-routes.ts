import { randomUUID } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentRegistry } from '../domains/cats/services/agents/registry/AgentRegistry.js';
import type { ContextEpochOwner } from '../domains/cats/services/session/ContextEpochOwner.js';
import type { DeliveryCursorStore } from '../domains/cats/services/stores/ports/DeliveryCursorStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

interface NativeSessionControlRouteOptions extends FastifyPluginOptions {
  readonly enabled: boolean;
  readonly agentRegistry: AgentRegistry;
  readonly contextEpochOwner: ContextEpochOwner;
  readonly deliveryCursorStore: Pick<DeliveryCursorStore, 'getCursor' | 'getSeenCursor'>;
  readonly sessionChainStore: ISessionChainStore;
  readonly threadStore: IThreadStore;
  readonly isSessionBusy?: (threadId: string, catId: string, userId: string) => boolean;
}

interface NativeSessionControlRequest {
  Params: { threadId: string; catId: string };
}

interface NativeCompactionTarget {
  readonly catId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly service: ReturnType<AgentRegistry['get']>;
  readonly sessionId: string;
}

export async function nativeSessionControlRoutes(
  app: FastifyInstance,
  options: NativeSessionControlRouteOptions,
): Promise<void> {
  app.post<NativeSessionControlRequest>('/api/threads/:threadId/sessions/:catId/compact-native', (request, reply) =>
    handleNativeCompaction(request, reply, options),
  );
}

async function handleNativeCompaction(
  request: FastifyRequest<NativeSessionControlRequest>,
  reply: FastifyReply,
  options: NativeSessionControlRouteOptions,
): Promise<unknown> {
  const target = await resolveNativeCompactionTarget(request, reply, options);
  if (!target) return;
  try {
    // Evidence canary, not a transactional guard: observeCompaction commits the
    // epoch transition before the second snapshot. A mismatch fails this UAT
    // journey but cannot roll the provider event back, and concurrent delivery
    // may conservatively produce the same failure.
    const cursorsBefore = await readCursorSnapshot(options.deliveryCursorStore, target);
    const event = await target.service.requestNativeCompaction?.({
      sessionId: target.sessionId,
      invocationId: `native-compact-${randomUUID()}`,
      timeoutMs: 120_000,
    });
    if (!event) return reply.status(409).send(unsupported());
    const decision = await options.contextEpochOwner.observeCompaction({
      userId: target.userId,
      catId: target.catId,
      threadId: target.threadId,
      event,
    });
    const cursorsAfter = await readCursorSnapshot(options.deliveryCursorStore, target);
    if (cursorsBefore.delivery !== cursorsAfter.delivery || cursorsBefore.seen !== cursorsAfter.seen) {
      return reply.status(502).send({
        error: 'Cursor state changed during native compaction',
        code: 'NATIVE_COMPACTION_CURSOR_CHANGED',
      });
    }
    return reply.send({
      outcome: 'observed',
      transition: decision.transition,
      replayed: decision.replayed,
      contextEpoch: decision.contextEpoch,
      contextMode: decision.contextMode,
      cursorState: 'preserved',
    });
  } catch (error) {
    const unavailable = isNativeSessionUnavailable(error);
    return reply.status(unavailable ? 409 : 502).send({
      error: unavailable ? 'Native session unavailable' : 'Provider compaction failed',
      code: unavailable ? 'NATIVE_SESSION_UNAVAILABLE' : 'NATIVE_COMPACTION_FAILED',
    });
  }
}

async function readCursorSnapshot(
  cursorStore: Pick<DeliveryCursorStore, 'getCursor' | 'getSeenCursor'>,
  target: Pick<NativeCompactionTarget, 'userId' | 'catId' | 'threadId'>,
): Promise<{ delivery: string | undefined; seen: string | undefined }> {
  const catId = target.catId as CatId;
  const [delivery, seen] = await Promise.all([
    cursorStore.getCursor(target.userId, catId, target.threadId),
    cursorStore.getSeenCursor(target.userId, catId, target.threadId),
  ]);
  return { delivery, seen };
}

async function resolveNativeCompactionTarget(
  request: FastifyRequest<NativeSessionControlRequest>,
  reply: FastifyReply,
  options: NativeSessionControlRouteOptions,
): Promise<NativeCompactionTarget | null> {
  if (!options.enabled) return reply.status(404).send({ error: 'Not found' });
  const userId = resolveStrictUserId(request);
  if (!userId) return reply.status(401).send({ error: 'Identity required' });
  const { threadId, catId } = request.params;
  const thread = await options.threadStore.get(threadId);
  if (!thread) return reply.status(404).send({ error: 'Thread not found' });
  if (!canAccessThread(thread, userId)) return reply.status(403).send({ error: 'Access denied' });
  if (options.isSessionBusy?.(threadId, catId, userId)) {
    return reply.status(409).send({ error: 'Session is busy', code: 'NATIVE_SESSION_BUSY' });
  }
  if (!options.agentRegistry.has(catId)) return reply.status(409).send(unsupported());
  const session = await options.sessionChainStore.getActive(catId as CatId, threadId, userId);
  const service = options.agentRegistry.get(catId);
  if (!session?.cliSessionId || !service.requestNativeCompaction) {
    return reply.status(409).send(unsupported());
  }
  return { userId, threadId, catId, service, sessionId: session.cliSessionId };
}

function isNativeSessionUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'codex_native_session_owner_unavailable' ||
      error.message.includes('already has an active host lease'))
  );
}

function unsupported(): { error: string; code: string } {
  return { error: 'Native compaction unsupported', code: 'NATIVE_COMPACTION_UNSUPPORTED' };
}
