/**
 * Session Chain Routes
 * F24: API endpoints for session chain + context health data.
 *
 * GET   /api/threads/:threadId/sessions            - List sessions (optional catId filter)
 * GET   /api/sessions/:sessionId                   - Get single session record
 * POST  /api/sessions/:sessionId/seal              - Safely seal an idle active session
 * POST  /api/sessions/:sessionId/unseal            - Restore historical session as current (#F062)
 * PATCH /api/threads/:threadId/sessions/:catId/bind - Manual bind CLI session ID (#72)
 */

import { type CatId, catRegistry, type SessionRecord } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import type { RuntimeSessionMetadata } from '../domains/cats/services/runtime-session/RuntimeSessionMetadata.js';
import type { IRuntimeSessionStore } from '../domains/cats/services/runtime-session/RuntimeSessionStore.js';
import { backfillBoundSessionHistory } from '../domains/cats/services/session/BoundSessionHistoryImporter.js';
import type { ISessionSealer } from '../domains/cats/services/session/SessionSealer.js';
import type { TranscriptReader } from '../domains/cats/services/session/TranscriptReader.js';
import {
  canReadThreadRecord,
  filterThreadRecords,
  resolveThreadAccess,
  threadAccessDeniedBody,
  threadRecordAccessDeniedBody,
} from '../domains/cats/services/session/thread-access-policy.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type {
  ISessionChainStore,
  RestoreActiveSessionResult,
} from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread, isSharedDefaultThread } from '../domains/guides/guide-state-access.js';
import { resolveUserId } from '../utils/request-identity.js';

const bindSessionSchema = z.object({
  cliSessionId: z.string().min(1).max(500),
});

const restoreSessionSchema = z
  .object({
    expectedActiveSessionId: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();

type RestoreSessionBody = z.infer<typeof restoreSessionSchema>;

interface RestoreRouteResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

interface SessionChainRouteOptions extends FastifyPluginOptions {
  sessionChainStore: ISessionChainStore;
  threadStore: IThreadStore;
  messageStore?: IMessageStore;
  transcriptReader?: TranscriptReader;
  sessionSealer?: ISessionSealer;
  runtimeSessionStore?: IRuntimeSessionStore;
  /** Process-local busy probe: true while the cat has a live invocation or queued work for this user. */
  isSessionSwitchBusy?: (threadId: string, catId: string, userId: string) => boolean;
  /** Process-local control plane. Any live provider turn for the cat must block a manual seal. */
  invocationTracker?: {
    has(threadId: string, catId: string): boolean;
    guardSessionSeal?(threadId: string, catId: string): { acquired: boolean; release(): void };
  };
  /** Canonical durable/provider liveness projection. Incomplete reads fail closed. */
  resolveSessionSealLiveness?: (
    threadId: string,
    ownerUserId: string,
  ) => Promise<{ catIds: readonly string[]; complete: boolean }>;
}

interface RuntimeSessionSummary {
  runtime: RuntimeSessionMetadata['runtime'];
  runtimeSessionId: string;
  runtimeConversationId?: string;
  lifecycleState: RuntimeSessionMetadata['lifecycle']['state'];
  lastObservedAt: number;
  retryFragment?: RuntimeSessionMetadata['lifecycle']['retryFragment'];
  unexpectedRuntimeSessionSwitch?: RuntimeSessionMetadata['lifecycle']['unexpectedRuntimeSessionSwitch'];
}

type ManualSealCandidate =
  | { kind: 'ready'; session: SessionRecord }
  | { kind: 'error'; status: 403 | 404 | 409; body: Record<string, unknown> };

async function resolveManualSealCandidate(input: {
  sessionId: string;
  userId: string;
  sessionChainStore: ISessionChainStore;
  threadStore: IThreadStore;
}): Promise<ManualSealCandidate> {
  const session = await input.sessionChainStore.get(input.sessionId);
  if (!session) {
    return { kind: 'error', status: 404, body: { error: 'Session not found', code: 'SESSION_NOT_FOUND' } };
  }
  const thread = await input.threadStore.get(session.threadId);
  if (!thread) {
    return { kind: 'error', status: 404, body: { error: 'Thread not found', code: 'THREAD_NOT_FOUND' } };
  }
  if (!canAccessSessionRecord(thread, session, input.userId)) {
    return { kind: 'error', status: 403, body: { error: 'Access denied', code: 'SESSION_ACCESS_DENIED' } };
  }
  if (session.status !== 'active') {
    return {
      kind: 'error',
      status: 409,
      body: {
        error: 'Only an active session can be sealed',
        code: 'SESSION_NOT_ACTIVE',
        currentStatus: session.status,
      },
    };
  }
  return { kind: 'ready', session };
}

function canAccessSessionRecord(
  thread: {
    id: string;
    createdBy: string;
    externalRuntimeAnchorState?: { userId: string } | undefined;
  } | null,
  session: { userId: string } | null,
  userId: string,
): boolean {
  if (!thread || !session) return false;
  if (thread.createdBy === userId) return true;
  if (thread.externalRuntimeAnchorState?.userId === userId && session.userId === userId) return true;
  return isSharedDefaultThread(thread) && session.userId === userId;
}

function formatRuntimeSessionSummary(metadata: RuntimeSessionMetadata): RuntimeSessionSummary {
  return {
    runtime: metadata.runtime,
    runtimeSessionId: metadata.runtimeSessionId,
    ...('runtimeConversationId' in metadata && metadata.runtimeConversationId
      ? { runtimeConversationId: metadata.runtimeConversationId }
      : {}),
    lifecycleState: metadata.lifecycle.state,
    lastObservedAt: metadata.lifecycle.lastObservedAt,
    ...(metadata.lifecycle.retryFragment ? { retryFragment: metadata.lifecycle.retryFragment } : {}),
    ...(metadata.lifecycle.unexpectedRuntimeSessionSwitch
      ? { unexpectedRuntimeSessionSwitch: metadata.lifecycle.unexpectedRuntimeSessionSwitch }
      : {}),
  };
}

async function attachRuntimeSessionSummary<T extends { id: string }>(
  session: T,
  runtimeSessionStore?: IRuntimeSessionStore,
): Promise<T & { runtimeSession?: RuntimeSessionSummary }> {
  if (!runtimeSessionStore) return session;
  const metadata = await runtimeSessionStore.getBySessionId(session.id);
  if (!metadata) return session;
  return {
    ...session,
    runtimeSession: formatRuntimeSessionSummary(metadata),
  };
}

async function attachRuntimeSessionSummaries<T extends { id: string }>(
  sessions: T[],
  runtimeSessionStore?: IRuntimeSessionStore,
): Promise<Array<T & { runtimeSession?: RuntimeSessionSummary }>> {
  if (!runtimeSessionStore) return sessions;
  return Promise.all(sessions.map((session) => attachRuntimeSessionSummary(session, runtimeSessionStore)));
}

async function prepareRestore(
  session: SessionRecord,
  body: unknown,
  store: ISessionChainStore,
  isBusy: SessionChainRouteOptions['isSessionSwitchBusy'],
  userId: string,
): Promise<{ active: SessionRecord | null } | { response: RestoreRouteResponse }> {
  const parsedBody = restoreSessionSchema.safeParse(body ?? {});
  if (!parsedBody.success) {
    return {
      response: {
        statusCode: 400,
        body: { error: 'Invalid restore request', details: parsedBody.error.flatten() },
      },
    };
  }

  const active = await store.getActive(session.catId, session.threadId, session.userId);
  const expectedActiveSessionId = parsedBody.data.expectedActiveSessionId;
  if (active && active.id !== session.id && expectedActiveSessionId === undefined) {
    return {
      response: {
        statusCode: 409,
        body: {
          code: 'active_session_confirmation_required',
          error: 'Confirm the currently active session before restoring this historical session',
          activeSessionId: active.id,
          activeSessionSeq: active.seq,
          activeMessageCount: active.messageCount ?? 0,
        },
      },
    };
  }
  if ((active?.id ?? null) !== (expectedActiveSessionId ?? null)) {
    return {
      response: {
        statusCode: 409,
        body: {
          code: 'active_session_changed',
          error: 'The active session changed; refresh before restoring',
          ...(active ? { activeSessionId: active.id } : {}),
        },
      },
    };
  }
  if (isBusy?.(session.threadId, session.catId, userId)) {
    return {
      response: {
        statusCode: 409,
        body: {
          code: 'session_switch_busy',
          error: 'This cat has queued or running work in the thread; wait for it to finish before restoring',
          ...(active ? { activeSessionId: active.id } : {}),
        },
      },
    };
  }
  return { active };
}

function formatNonRestoredResult(
  result: Exclude<RestoreActiveSessionResult, { status: 'restored' }>,
): RestoreRouteResponse {
  switch (result.status) {
    case 'target_missing':
      return { statusCode: 404, body: { error: 'Session not found' } };
    case 'target_not_restorable':
      return { statusCode: 409, body: { error: `Session status ${result.targetStatus} cannot be restored` } };
    case 'active_changed':
      return {
        statusCode: 409,
        body: {
          code: 'active_session_changed',
          error: 'The active session changed; refresh before restoring',
          ...(result.activeSessionId ? { activeSessionId: result.activeSessionId } : {}),
        },
      };
    case 'already_active':
      return { statusCode: 200, body: { session: result.session, mode: 'already_active' } };
  }
}

async function loadRestoreTarget(
  sessionId: string,
  userId: string,
  sessionChainStore: ISessionChainStore,
  threadStore: IThreadStore,
): Promise<{ session: SessionRecord } | { response: RestoreRouteResponse }> {
  const session = await sessionChainStore.get(sessionId);
  if (!session) {
    return { response: { statusCode: 404, body: { error: 'Session not found' } } };
  }
  const thread = await threadStore.get(session.threadId);
  if (!thread) {
    return { response: { statusCode: 404, body: { error: 'Thread not found' } } };
  }
  if (!canAccessSessionRecord(thread, session, userId)) {
    return { response: { statusCode: 403, body: { error: 'Access denied' } } };
  }
  if (session.status === 'active') {
    return {
      response: { statusCode: 200, body: { session, mode: 'already_active' } },
    };
  }
  if (session.status !== 'sealed') {
    return {
      response: { statusCode: 409, body: { error: `Session status ${session.status} cannot be restored` } },
    };
  }
  return { session };
}

export async function sessionChainRoutes(app: FastifyInstance, opts: SessionChainRouteOptions): Promise<void> {
  const {
    sessionChainStore,
    threadStore,
    messageStore,
    transcriptReader,
    sessionSealer,
    runtimeSessionStore,
    isSessionSwitchBusy,
  } = opts;

  app.get<{
    Params: { threadId: string };
    Querystring: { catId?: string };
  }>('/api/threads/:threadId/sessions', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const { threadId } = request.params;
    const thread = await threadStore.get(threadId);
    const access = await resolveThreadAccess({
      threadStore,
      thread,
      userId,
      request: { resource: 'sessions', action: 'list' },
    });
    if (access.status === 403) {
      return reply.status(403).send(threadAccessDeniedBody(access));
    }

    const { catId } = request.query;
    const callerCatId = request.headers['x-cat-id'] as string | undefined;

    // When caller identifies as a specific cat (MCP tool), restrict to own sessions only.
    // Query param `catId` is ignored when it differs from caller — prevents cross-cat enumeration.
    const effectiveCatId = callerCatId ?? catId;

    if (effectiveCatId) {
      if (callerCatId && catId && catId !== callerCatId) {
        reply.status(403);
        return { error: `Cannot query sessions for cat '${catId}' — you are '${callerCatId}'` };
      }
      const sessions = await sessionChainStore.getChain(
        effectiveCatId as CatId,
        threadId,
        access.scope === 'user' ? userId : undefined,
      );
      const visibleSessions = filterThreadRecords(access, sessions);
      return reply.send({ sessions: await attachRuntimeSessionSummaries(visibleSessions, runtimeSessionStore) });
    }

    // No catId filter at all (hub UI god-view) — shared system threads stay user-scoped.
    const sessions = await sessionChainStore.getChainByThread(threadId);
    const visibleSessions = filterThreadRecords(access, sessions);
    return reply.send({ sessions: await attachRuntimeSessionSummaries(visibleSessions, runtimeSessionStore) });
  });

  app.get<{
    Params: { sessionId: string };
  }>('/api/sessions/:sessionId', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const { sessionId } = request.params;
    const session = await sessionChainStore.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // Verify thread ownership via session -> thread
    const thread = await threadStore.get(session.threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }
    const access = await resolveThreadAccess({
      threadStore,
      thread,
      userId,
      request: { resource: 'sessions', action: 'read' },
    });
    if (access.status === 403) {
      return reply.status(403).send(threadAccessDeniedBody(access));
    }
    if (!canReadThreadRecord(access, session)) {
      return reply.status(403).send(threadRecordAccessDeniedBody());
    }

    return reply.send(await attachRuntimeSessionSummary(session, runtimeSessionStore));
  });

  // POST /api/sessions/:sessionId/seal — manual, idle-only session rotation.
  // The endpoint intentionally has no fallback that writes a replacement session:
  // successful requestSeal() clears the active pointer and the next real activation
  // owns creation of its fresh session.
  app.post<{
    Params: { sessionId: string };
  }>('/api/sessions/:sessionId/seal', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    if (!sessionSealer) {
      reply.status(503);
      return { error: 'Session sealing is temporarily unavailable', code: 'SESSION_SEAL_UNAVAILABLE' };
    }

    const candidate = await resolveManualSealCandidate({
      sessionId: request.params.sessionId,
      userId,
      sessionChainStore,
      threadStore,
    });
    if (candidate.kind === 'error') {
      reply.status(candidate.status);
      return candidate.body;
    }
    const { session } = candidate;

    let liveness: { catIds: readonly string[]; complete: boolean };
    try {
      if (!opts.resolveSessionSealLiveness) throw new Error('session seal liveness resolver missing');
      liveness = await opts.resolveSessionSealLiveness(session.threadId, session.userId);
    } catch {
      reply.status(503);
      return {
        error: 'Unable to verify whether this Agent is still running',
        code: 'SESSION_LIVENESS_UNAVAILABLE',
      };
    }
    if (!liveness.complete) {
      reply.status(503);
      return {
        error: 'Unable to verify whether this Agent is still running',
        code: 'SESSION_LIVENESS_UNAVAILABLE',
      };
    }
    if (liveness.catIds.includes(session.catId)) {
      reply.status(409);
      return { error: '请先停止该 Agent，再封存会话', code: 'SESSION_ACTIVE_INVOCATION', catId: session.catId };
    }

    // The check and the session-store transition are separated by awaits. Use
    // the tracker slot guard when available so a local invocation cannot start
    // and capture this still-active record in that window. It is released as
    // soon as requestSeal atomically removes the old active pointer.
    const sealGuard = opts.invocationTracker?.guardSessionSeal
      ? opts.invocationTracker.guardSessionSeal(session.threadId, session.catId)
      : {
          acquired: !opts.invocationTracker?.has(session.threadId, session.catId),
          release: () => {},
        };
    if (!sealGuard.acquired) {
      reply.status(409);
      return { error: '请先停止该 Agent，再封存会话', code: 'SESSION_ACTIVE_INVOCATION', catId: session.catId };
    }

    let seal;
    try {
      seal = await sessionSealer.requestSeal({ sessionId: session.id, reason: 'manual' });
    } finally {
      sealGuard.release();
    }
    if (!seal.accepted) {
      const latest = await sessionChainStore.get(session.id);
      reply.status(409);
      return {
        error: '会话状态已变化，请刷新后重试',
        code: 'SESSION_SEAL_RACE',
        currentStatus: latest?.status ?? seal.status,
      };
    }

    // Keep the user-visible response honest: the card may move to sealed only after
    // transcript/digest finalization has completed. SessionSealer itself retains a
    // reaper backstop if terminal persistence cannot complete.
    const finalization = await sessionSealer.finalize({ sessionId: session.id });
    const sealed = await sessionChainStore.get(session.id);
    if (!sealed || sealed.status !== 'sealed' || !finalization.sealed) {
      reply.status(503);
      return { error: 'Session sealing has not completed yet', code: 'SESSION_SEAL_PENDING' };
    }
    if (!finalization.clean) {
      reply.status(503);
      return {
        error: 'Session sealed, but transcript or digest finalization did not complete',
        code: 'SESSION_SEAL_PARTIAL',
      };
    }
    return reply.send({
      mode: 'sealed' as const,
      session: await attachRuntimeSessionSummary(sealed, runtimeSessionStore),
    });
  });

  // POST /api/sessions/:sessionId/unseal — Manual recovery fallback (#F062)
  // Restore the selected sealed record in place. When a newer record is
  // active, the client must explicitly confirm its exact ID before the store
  // atomically seals it and moves the active pointers to the selected record.
  app.post<{
    Params: { sessionId: string };
    Body: RestoreSessionBody;
  }>('/api/sessions/:sessionId/unseal', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const target = await loadRestoreTarget(request.params.sessionId, userId, sessionChainStore, threadStore);
    if ('response' in target) {
      return reply.status(target.response.statusCode).send(target.response.body);
    }

    const prepared = await prepareRestore(target.session, request.body, sessionChainStore, isSessionSwitchBusy, userId);
    if ('response' in prepared) {
      return reply.status(prepared.response.statusCode).send(prepared.response.body);
    }

    const restored = await sessionChainStore.restoreActiveSession({
      targetSessionId: target.session.id,
      expectedActiveSessionId: prepared.active?.id ?? null,
      displacedSealReason: 'manual_session_switch',
    });
    if (restored.status !== 'restored') {
      const response = formatNonRestoredResult(restored);
      return reply.status(response.statusCode).send(response.body);
    }

    if (restored.displacedSessionId && sessionSealer) {
      sessionSealer.finalize({ sessionId: restored.displacedSessionId }).catch(() => {});
    }

    getEventAuditLog()
      .append({
        type: AuditEventTypes.SESSION_BIND,
        threadId: target.session.threadId,
        data: {
          mode: 'restore_as_current',
          restoredSessionId: target.session.id,
          displacedSessionId: restored.displacedSessionId,
          catId: target.session.catId,
          cliSessionId: target.session.cliSessionId,
          userId,
        },
      })
      .catch(() => {
        /* best-effort */
      });

    return reply.send({
      mode: 'restored' as const,
      session: restored.session,
      ...(restored.displacedSessionId ? { displacedSessionId: restored.displacedSessionId } : {}),
    });
  });

  // PATCH /api/threads/:threadId/sessions/:catId/bind — Manual bind (#72)
  // Allows co-creator to bind a known-good CLI session ID to a cat's thread session.
  // If active session exists → update cliSessionId; otherwise → create new session.
  app.patch<{
    Params: { threadId: string; catId: string };
  }>('/api/threads/:threadId/sessions/:catId/bind', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const { threadId, catId } = request.params;

    // Validate catId against runtime registry
    if (!catRegistry.has(catId)) {
      reply.status(400);
      return { error: `Invalid catId: ${catId}. Must be one of: ${catRegistry.getAllIds().join(', ')}` };
    }

    // Validate body
    const parseResult = bindSessionSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { cliSessionId } = parseResult.data;

    // Verify thread exists + ownership
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }
    if (!canAccessThread(thread, userId)) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    // Check for active session
    const active = await sessionChainStore.getActive(catId as CatId, threadId, userId);
    if (active && !canAccessSessionRecord(thread, active, userId)) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    let session;
    let mode: 'updated' | 'created';

    if (active) {
      // Late-bind through the store's atomic CLI-ID claim path. A generic
      // update can race another logical node and steal its runtime identity.
      const updated = await sessionChainStore.bindCliSessionId(active.id, cliSessionId);
      if (!updated) {
        reply.status(409);
        return { error: 'CLI session ID is already bound or the active session changed; please retry' };
      }
      session = updated;
      mode = 'updated';
    } else {
      // Establish the logical owner node first, then claim the runtime ID
      // through the same atomic path as a late bind. A direct create could
      // overwrite another chain's CLI index when this owner has no active node.
      const claimed = await sessionChainStore.getByCliSessionId(cliSessionId);
      if (claimed) {
        reply.status(409);
        return { error: 'CLI session ID is already bound or the active session changed; please retry' };
      }
      const logical = await sessionChainStore.getOrCreateActive({
        threadId,
        catId: catId as CatId,
        userId,
      });
      const bound = await sessionChainStore.bindCliSessionId(logical.id, cliSessionId);
      if (!bound) {
        reply.status(409);
        return { error: 'CLI session ID is already bound or the active session changed; please retry' };
      }
      session = bound;
      mode = 'created';
    }

    // Audit trail (best-effort, fire-and-forget)
    getEventAuditLog()
      .append({
        type: AuditEventTypes.SESSION_BIND,
        threadId,
        data: { catId, cliSessionId, mode, sessionId: session.id, userId },
      })
      .catch(() => {
        /* best-effort */
      });

    const historyImport = await backfillBoundSessionHistory({
      sessionChainStore,
      transcriptReader,
      messageStore,
      threadId,
      catId: catId as CatId,
      userId,
    });

    return reply.send({ session, mode, historyImport });
  });
}
