/**
 * Session Transcript Routes — F24 Phase D + F98
 * API endpoints for reading sealed session transcripts.
 *
 * GET  /api/sessions/:sessionId/events                    — Paginated events (view=raw|chat|handoff)
 * GET  /api/sessions/:sessionId/digest                    — Extractive digest
 * GET  /api/sessions/:sessionId/invocations/:invocationId — Events for one invocation
 * GET  /api/threads/:threadId/sessions/search              — Full-text search
 */

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { formatEventsChat, formatEventsHandoff } from '../domains/cats/services/session/TranscriptFormatter.js';
import type { TranscriptReader } from '../domains/cats/services/session/TranscriptReader.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { isSharedDefaultThread } from '../domains/guides/guide-state-access.js';
import { getEvalCatOverride } from '../infrastructure/harness-eval/domain/eval-domain-override.js';
import { resolveUserId } from '../utils/request-identity.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';

const VALID_VIEWS = new Set(['raw', 'chat', 'handoff']);

interface SessionTranscriptRouteOptions extends FastifyPluginOptions {
  sessionChainStore: ISessionChainStore;
  threadStore: IThreadStore;
  transcriptReader: TranscriptReader;
  /** Static eval cat IDs from registry (F192 eval:sop). */
  evalCatIds?: ReadonlySet<string>;
  /** Domain IDs for OQ-20 Redis override resolution. */
  evalDomainIds?: ReadonlyArray<string>;
  /** Redis for OQ-20 eval cat override resolution. */
  redis?: Redis;
  /** Callback auth registry for verified cat identity (prevents x-cat-id spoofing). */
  callbackRegistry?: CallbackAuthRegistry;
  /** Agent-key registry for persistent MCP auth. */
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

/** Strict integer parse: only pure decimal digit strings (no whitespace, no partial) */
function strictParseInt(s: string): number {
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

const searchSchema = z.object({
  q: z.string().min(1).max(500),
  cats: z.string().optional(),
  sessionIds: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  scope: z.enum(['digests', 'transcripts', 'both']).optional(),
});

/**
 * Resolve whether the caller is an effective eval cat using VERIFIED identity
 * (callback auth or agent-key principal, not spoofable x-cat-id header). Checks
 * both static registry and OQ-20 Redis override for dynamic cat swaps.
 */
async function isVerifiedEvalCat(
  request: FastifyRequest,
  staticEvalCatIds: ReadonlySet<string>,
  redis?: Redis,
  evalDomainIds?: ReadonlyArray<string>,
): Promise<boolean> {
  // Require verified identity from callback auth OR agent-key principal (not raw header).
  // callbackAuth is set by invocation creds; callbackPrincipal is set by agent-key auth.
  const verifiedCatId = (request.callbackAuth?.catId ?? request.callbackPrincipal?.catId) as string | undefined;
  if (!verifiedCatId) return false;

  // Fast path: in static registry
  if (staticEvalCatIds.has(verifiedCatId)) return true;

  // Slow path: check OQ-20 Redis overrides (dynamic cat swap)
  if (redis && evalDomainIds?.length) {
    for (const domainId of evalDomainIds) {
      try {
        const override = await getEvalCatOverride(redis, domainId);
        if (override?.catId === verifiedCatId) return true;
      } catch {
        // Redis failures are non-fatal — fall through to deny
      }
    }
  }
  return false;
}

/**
 * Resolve the caller's cat identity from the most authoritative source.
 * Priority: verified callback auth > agent-key principal > raw header.
 * Returns undefined for panel/frontend requests (no cat identity → user-level ACL sufficient).
 */
function resolveCallerCatId(request: FastifyRequest): string | undefined {
  // Callback auth: verified via InvocationRegistry (highest trust)
  const cbCatId = request.callbackAuth?.catId as string | undefined;
  if (cbCatId) return cbCatId;
  // Agent-key: verified via AgentKeyRegistry (medium trust)
  const principalCatId = request.callbackPrincipal?.catId as string | undefined;
  if (principalCatId) return principalCatId;
  // Raw header: backward compat for MCP tools not yet forwarding callback creds
  return request.headers['x-cat-id'] as string | undefined;
}

/**
 * Resolve user identity preferring verified sources (callback/agent-key principal)
 * over the spoofable x-cat-cafe-user header. Prevents cross-user read attacks
 * where an attacker forges the user header while authenticated via agent-key.
 */
function resolveVerifiedUserId(request: FastifyRequest): string | null {
  // Callback auth carries verified userId from InvocationRecord
  const cbUserId = request.callbackAuth?.userId as string | undefined;
  if (cbUserId) return cbUserId;
  // Agent-key principal carries verified userId from AgentKeyRecord
  const principalUserId = request.callbackPrincipal?.userId as string | undefined;
  if (principalUserId) return principalUserId;
  // Fallback to standard resolution (session cookie / header / origin)
  return resolveUserId(request);
}

function checkCatIdAccess(request: FastifyRequest, sessionCatId: string, callerIsEvalCat: boolean): string | null {
  const callerCatId = resolveCallerCatId(request);
  if (!callerCatId) return null;
  if (callerCatId === sessionCatId) return null;
  // F192 eval:sop — only allow cross-cat reads for VERIFIED eval cats
  if (callerIsEvalCat) return null;
  return 'Access denied: session belongs to a different cat';
}

function canAccessSessionThread(
  thread: { id: string; createdBy: string; externalRuntimeAnchorState?: { userId: string } | undefined } | null,
  session: { userId: string },
  userId: string,
): boolean {
  if (!thread) return false;
  if (thread.createdBy === userId) return true;
  if (thread.externalRuntimeAnchorState?.userId === userId && session.userId === userId) return true;
  return isSharedDefaultThread(thread) && session.userId === userId;
}

export async function sessionTranscriptRoutes(
  app: FastifyInstance,
  opts: SessionTranscriptRouteOptions,
): Promise<void> {
  const {
    sessionChainStore,
    threadStore,
    transcriptReader,
    evalCatIds,
    evalDomainIds,
    redis,
    callbackRegistry,
    agentKeyRegistry,
  } = opts;

  // Register callback auth hook so request.callbackAuth is populated with
  // verified cat identity when MCP tools call these routes via callbackPost.
  // Panel/frontend requests (no callback creds) are unaffected (hook no-ops).
  if (callbackRegistry) {
    registerCallbackAuthHook(app, callbackRegistry, { agentKeyRegistry });
  }

  // GET /api/sessions/:sessionId/events — Paginated event read (F98: view modes)
  app.get<{
    Params: { sessionId: string };
    Querystring: { cursor?: string; limit?: string; view?: string };
  }>('/api/sessions/:sessionId/events', async (request, reply) => {
    const userId = resolveVerifiedUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { sessionId } = request.params;
    const session = await sessionChainStore.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const thread = await threadStore.get(session.threadId);
    if (!canAccessSessionThread(thread, session, userId)) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const isEval = await isVerifiedEvalCat(request, evalCatIds ?? new Set(), redis, evalDomainIds);
    const callerCatIdErr = checkCatIdAccess(request, session.catId, isEval);
    if (callerCatIdErr) {
      reply.status(403);
      return { error: callerCatIdErr };
    }

    const view = (request.query.view ?? 'raw') as string;
    if (!VALID_VIEWS.has(view)) {
      reply.status(400);
      return { error: `Invalid view: must be one of raw, chat, handoff` };
    }

    const cursorParam = request.query.cursor;
    const cursorNum = cursorParam ? strictParseInt(cursorParam) : undefined;
    if (cursorNum != null && (Number.isNaN(cursorNum) || cursorNum < 0)) {
      reply.status(400);
      return { error: 'Invalid cursor: must be a non-negative integer' };
    }
    const cursor = cursorNum != null ? { eventNo: cursorNum } : undefined;

    const limitParam = request.query.limit;
    const limitNum = limitParam ? strictParseInt(limitParam) : undefined;
    if (limitNum != null && (Number.isNaN(limitNum) || limitNum < 1)) {
      reply.status(400);
      return { error: 'Invalid limit: must be a positive integer' };
    }
    const limit = limitNum != null ? Math.min(limitNum, 200) : 50;

    const result = await transcriptReader.readEvents(sessionId, session.threadId, session.catId, cursor, limit);

    if (view === 'chat') {
      return reply.send({
        messages: formatEventsChat(result.events),
        nextCursor: result.nextCursor,
        total: result.total,
      });
    }
    if (view === 'handoff') {
      return reply.send({
        invocations: formatEventsHandoff(result.events),
        nextCursor: result.nextCursor,
        total: result.total,
      });
    }

    return reply.send(result);
  });

  // GET /api/sessions/:sessionId/digest — Extractive digest
  app.get<{
    Params: { sessionId: string };
  }>('/api/sessions/:sessionId/digest', async (request, reply) => {
    const userId = resolveVerifiedUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { sessionId } = request.params;
    const session = await sessionChainStore.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const thread = await threadStore.get(session.threadId);
    if (!canAccessSessionThread(thread, session, userId)) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const isEval2 = await isVerifiedEvalCat(request, evalCatIds ?? new Set(), redis, evalDomainIds);
    const callerCatIdErr2 = checkCatIdAccess(request, session.catId, isEval2);
    if (callerCatIdErr2) {
      reply.status(403);
      return { error: callerCatIdErr2 };
    }

    const digest = await transcriptReader.readDigest(sessionId, session.threadId, session.catId);
    if (!digest) {
      return reply.status(404).send({ error: 'Digest not found' });
    }

    return reply.send(digest);
  });

  // GET /api/sessions/:sessionId/invocations/:invocationId — F98 Gap 2
  app.get<{
    Params: { sessionId: string; invocationId: string };
  }>('/api/sessions/:sessionId/invocations/:invocationId', async (request, reply) => {
    const userId = resolveVerifiedUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { sessionId, invocationId } = request.params;
    const session = await sessionChainStore.get(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const thread = await threadStore.get(session.threadId);
    if (!canAccessSessionThread(thread, session, userId)) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const isEval3 = await isVerifiedEvalCat(request, evalCatIds ?? new Set(), redis, evalDomainIds);
    const callerCatIdErr3 = checkCatIdAccess(request, session.catId, isEval3);
    if (callerCatIdErr3) {
      reply.status(403);
      return { error: callerCatIdErr3 };
    }

    const events = await transcriptReader.readInvocationEvents(
      sessionId,
      session.threadId,
      session.catId,
      invocationId,
    );
    if (!events) {
      return reply.status(404).send({ error: 'Invocation not found' });
    }

    return reply.send({ invocationId, events, total: events.length });
  });

  // GET /api/threads/:threadId/sessions/search — Full-text search
  app.get<{
    Params: { threadId: string };
    Querystring: Record<string, string>;
  }>('/api/threads/:threadId/sessions/search', async (request, reply) => {
    const userId = resolveVerifiedUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { threadId } = request.params;
    const thread = await threadStore.get(threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const parseResult = searchSchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parseResult.error.issues };
    }

    const { q, cats, sessionIds, limit, scope } = parseResult.data;

    // P0a enforcement: when caller has cat identity, force-filter to caller's own sessions only
    // Prevents game-playing cats from searching other cats' session content (KD-39)
    // F192 eval:sop — verified eval cats are exempt (need cross-cat search for SOP predicate evaluation)
    const callerCatId = resolveCallerCatId(request);
    const isEvalCat = await isVerifiedEvalCat(request, evalCatIds ?? new Set(), redis, evalDomainIds);
    const catsArr = callerCatId && !isEvalCat ? [callerCatId] : cats?.split(',').filter(Boolean);
    const sessionIdsArr = sessionIds?.split(',').filter(Boolean);

    const hits = await transcriptReader.search(threadId, q, {
      ...(catsArr ? { cats: catsArr } : {}),
      ...(sessionIdsArr ? { sessionIds: sessionIdsArr } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(scope ? { scope } : {}),
    });

    return reply.send({ hits });
  });
}
