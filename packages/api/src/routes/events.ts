/**
 * F227 PR-1 Task 3 — Event Memory query route.
 *
 * GET /api/memory/events — filtered, paged, newest-first event list backed by
 * EventMemoryStore. Enum filters reuse the shared single-source const arrays.
 */

import { randomUUID } from 'node:crypto';
import {
  COGNITIVE_TRANSITIONS,
  EVENT_CONFIDENCES,
  EVENT_TRIGGERS,
  type EventMemoryOwnerAction,
  eventMemoryOwnerActionSchema,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadCompiledGovernanceL0Sync } from '../domains/cats/services/context/governance-l0.js';
import { loadStagingBody } from '../domains/cats/services/context/StagingContent.js';
import type { EventMemoryFilter, IEventMemoryStore } from '../domains/memory/EventMemoryStore.js';
import { eventMemoryRevision, type StoredEventMemoryLifecycle } from '../domains/memory/EventMemoryStore.js';
import type { EventMemoryCorrectionProposalStore } from '../domains/memory/event/EventMemoryCorrectionProposalStore.js';
import { EventMemoryLifecycleService } from '../domains/memory/event/EventMemoryLifecycleService.js';
import { toEventMemoryCorrectionProposalView } from '../domains/memory/event/event-memory-correction-proposal-view.js';
import type { BackfillMessageSource, BackfillThreadSource } from '../domains/memory/event-backfill.js';
import { runCorpusBackfill } from '../domains/memory/event-backfill.js';
import type { MagicWordMeaning } from '../domains/memory/magic-word-meanings.js';
import { parseMagicWordMeanings } from '../domains/memory/magic-word-meanings.js';
import type { OwnerMemoryActionCoordinator } from '../domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';
import { type EventMemorySourceReaders, readEventMemorySource } from './event-memory-source.js';
import { authorizeOwnerBrowserAction, ownerMemoryActionHttpStatus } from './owner-memory-browser-auth.js';

/**
 * F227 (砚砚 P1): Event Memory routes expose stored events + broadcast teleport
 * side effects — they must not be unauthenticated. Accept either a logged-in user
 * session (Hub frontend) or a verified callback principal (MCP via callbackPost).
 * The global callback-auth preHandler decorates request.callbackPrincipal;
 * the session middleware decorates request.sessionUserId.
 */
function isAuthenticated(request: FastifyRequest): boolean {
  const r = request as FastifyRequest & { sessionUserId?: string; callbackPrincipal?: unknown };
  return Boolean(r.sessionUserId) || Boolean(r.callbackPrincipal);
}

/**
 * Resolve the caller's owner scope (session user, else callback principal). Returns null
 * when no owner can be determined — callers MUST fail closed rather than fall back to a
 * shared/global scope (cloud-review P1 / 砚砚: no unknown/default fallback).
 */
function ownerUserIdOf(request: FastifyRequest): string | null {
  const r = request as FastifyRequest & { sessionUserId?: string; callbackPrincipal?: { userId?: string } };
  return r.sessionUserId ?? r.callbackPrincipal?.userId ?? null;
}

// F227 Task 8 (AC-A5): magic-word meanings come from their injected governance
// sources (compiled L0 + ADR-038 staging), never a hardcoded meaning table.
// Static + small → lazy-load once and cache.
let cachedMagicWordMeanings: MagicWordMeaning[] | null = null;
function getMagicWordMeanings(): MagicWordMeaning[] {
  if (cachedMagicWordMeanings) return cachedMagicWordMeanings;
  try {
    const parsed = parseMagicWordMeanings(`${loadCompiledGovernanceL0Sync().content}\n${loadStagingBody()}`);
    cachedMagicWordMeanings = [...new Map(parsed.map((meaning) => [meaning.word, meaning])).values()];
  } catch {
    cachedMagicWordMeanings = []; // missing/uncompilable governance → graceful empty (popover shows nothing)
  }
  return cachedMagicWordMeanings;
}

/** Query params — z.coerce handles GET string → number; enums reuse shared arrays. */
const listSchema = z.object({
  trigger: z.enum(EVENT_TRIGGERS).optional(),
  cat: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  confidence: z.enum(EVENT_CONFIDENCES).optional(),
  cognitiveTransition: z.enum(COGNITIVE_TRANSITIONS).optional(),
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export interface EventsRoutesOptions {
  eventMemoryStore: IEventMemoryStore;
  lifecycleService?: EventMemoryLifecycleService;
  ownerActionCoordinator?: OwnerMemoryActionCoordinator;
  correctionProposalStore?: EventMemoryCorrectionProposalStore;
  /** F227: socket emitter for thread:teleport navigation events. */
  socketEmit?: (event: string, data: unknown, room: string) => void;
  /** F227 (砚砚 R2 P1): callback auth for the MCP path (cat_cafe_teleport via
   * callbackPost). Fastify encapsulation means a sibling plugin's hook does NOT
   * cover us — register our own in this plugin's scope. */
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
  /** F227 Task 7: corpus sources for the historical backfill route (optional —
   * GET/teleport work without them). Structurally satisfied by IThreadStore /
   * IMessageStore. */
  threadStore?: BackfillThreadSource & EventMemorySourceReaders['threadStore'];
  messageStore?: BackfillMessageSource & EventMemorySourceReaders['messageStore'];
}

export interface EventsListResponse {
  events: Array<
    ReturnType<typeof projectOwnerEvent> & {
      summaryTruncated?: boolean;
      originalSummaryChars?: number;
      drillDown?: EventDrillDown;
    }
  >;
  meta: { count: number; limit: number; offset: number; hasMore: boolean; nextOffset?: number };
}

const EVENT_RESPONSE_MAX_CHARS = 24_000;

interface EventDrillDown {
  path: string;
  charOffset: number;
  revision: string;
  tool: 'cat_cafe_list_events';
  args: { eventId: string; charOffset: number; revision: string };
}

function eventDrillDown(eventId: string, charOffset: number, revision: string): EventDrillDown {
  return {
    path: `/api/memory/events/${encodeURIComponent(eventId)}?revision=${encodeURIComponent(revision)}`,
    charOffset,
    revision,
    tool: 'cat_cafe_list_events',
    args: { eventId, charOffset, revision },
  };
}

function fitEventListPage(
  window: StoredEventMemoryLifecycle[],
  limit: number,
  offset: number,
  pendingCorrectionCounts: ReadonlyMap<string, number>,
): EventsListResponse {
  const events: EventsListResponse['events'] = [];
  const responseFor = (items: EventsListResponse['events']): EventsListResponse => {
    const hasMore = items.length < window.length;
    return {
      events: items,
      meta: { count: items.length, limit, offset, hasMore, ...(hasMore ? { nextOffset: offset + items.length } : {}) },
    };
  };
  for (const event of window.slice(0, limit)) {
    const projected = projectOwnerEvent(event, pendingCorrectionCounts.get(event.eventId) ?? 0);
    if (JSON.stringify(responseFor([...events, projected])).length <= EVENT_RESPONSE_MAX_CHARS) {
      events.push(projected);
      continue;
    }
    if (events.length > 0) break;
    const placeholder = {
      ...projected,
      summary: event.summary.slice(0, 120),
      relatedHarness: event.relatedHarness?.slice(0, 4) ?? null,
      summaryTruncated: true,
      originalSummaryChars: event.summary.length,
      drillDown: eventDrillDown(event.eventId, 0, projected.revision),
    };
    if (JSON.stringify(responseFor([placeholder])).length > EVENT_RESPONSE_MAX_CHARS) {
      throw new Error('Event source reference exceeds the bounded response budget');
    }
    events.push(placeholder);
    break;
  }
  return responseFor(events);
}

export const eventsRoutes: FastifyPluginAsync<EventsRoutesOptions> = async (app, opts) => {
  // F227 (砚砚 R2 P1): register callback auth in THIS plugin's scope so MCP
  // callbackPost (cat_cafe_teleport) X-Invocation-Id/X-Callback-Token headers
  // actually decorate request.callbackPrincipal. Fastify encapsulation means a
  // sibling plugin's hook does not reach sibling routes.
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }
  const sourceReaders =
    opts.threadStore && opts.messageStore ? { threadStore: opts.threadStore, messageStore: opts.messageStore } : null;
  const lifecycleService =
    opts.lifecycleService ??
    (opts.ownerActionCoordinator && sourceReaders
      ? new EventMemoryLifecycleService({
          store: opts.eventMemoryStore,
          coordinator: opts.ownerActionCoordinator,
          sourceAvailable: async (event) =>
            (await readEventMemorySource(event, event.ownerUserId, sourceReaders)).status === 'ready',
        })
      : null);

  app.get('/api/memory/events', async (request, reply) => {
    if (!isAuthenticated(request)) {
      reply.status(401);
      return { error: 'auth required' };
    }
    const owner = ownerUserIdOf(request);
    if (!owner) {
      reply.status(403);
      return { error: 'owner scope required' };
    }
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parsed.error.issues };
    }

    // Owner scope is server-enforced (cloud-review P1): callers only ever see their own
    // events; `ownerUserId` is appended LAST so a client-supplied value can't widen it.
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const filter: EventMemoryFilter = { ...parsed.data, limit: limit + 1, offset, ownerUserId: owner };
    const window = opts.eventMemoryStore.listEvents(filter);
    const counts = opts.correctionProposalStore
      ? await opts.correctionProposalStore.countActionableForEvents(
          owner,
          window.slice(0, limit).map((event) => event.eventId),
        )
      : new Map<string, number>();
    return fitEventListPage(window, limit, offset, counts);
  });

  app.get<{ Params: { eventId: string }; Querystring: { charOffset?: string; revision?: string } }>(
    '/api/memory/events/:eventId',
    async (request, reply) => {
      if (!isAuthenticated(request)) return reply.status(401).send({ error: 'auth required' });
      const owner = ownerUserIdOf(request);
      if (!owner) return reply.status(403).send({ error: 'owner scope required' });
      const event = opts.eventMemoryStore.getEvent(request.params.eventId);
      if (!event || event.ownerUserId !== owner) return reply.status(404).send({ error: 'Event not found' });
      const correctionProposals = await listEventCorrections(opts.correctionProposalStore, owner, event.eventId);
      const snapshot = projectEventSnapshot(event);
      const detailProjection = {
        ...snapshot,
        pendingCorrectionCount: correctionProposals.length,
        correctionProposals: correctionProposals.map(toEventMemoryCorrectionProposalView),
      };
      if (request.query.revision !== undefined && request.query.revision !== snapshot.revision) {
        return reply.status(409).send({ error: 'Revision changed' });
      }
      const serialized = JSON.stringify(snapshot);
      const slice = buildEventSlice(serialized, snapshot.revision, request.query);
      if (slice) return reply.status(slice.statusCode).send(slice.body);
      if (serialized.length <= EVENT_RESPONSE_MAX_CHARS) return reply.send(detailProjection);
      return reply.send({
        eventId: event.eventId,
        revision: snapshot.revision,
        status: snapshot.status,
        pendingCorrectionCount: detailProjection.pendingCorrectionCount,
        correctionProposals: detailProjection.correctionProposals,
        oversized: true,
        eventChars: serialized.length,
        drillDown: eventDrillDown(event.eventId, 0, snapshot.revision),
      });
    },
  );

  app.get<{ Params: { eventId: string }; Querystring: { revision?: string } }>(
    '/api/memory/events/:eventId/source',
    async (request, reply) => {
      const owner = resolveSessionUserId(request);
      if (!owner) return reply.status(401).send({ error: 'Session required' });
      if (!request.query.revision) return reply.status(400).send({ error: 'Revision required' });
      if (!sourceReaders) return reply.status(503).send({ error: 'Source reader unavailable' });
      const event = opts.eventMemoryStore.getEvent(request.params.eventId);
      if (!event || event.ownerUserId !== owner) return reply.status(404).send({ error: 'Event not found' });
      if (eventMemoryRevision(event) !== request.query.revision) {
        return reply.status(409).send({ error: 'Revision changed' });
      }
      return readEventMemorySource(event, owner, sourceReaders);
    },
  );

  app.post<{ Params: { eventId: string }; Body: EventMemoryOwnerAction }>(
    '/api/memory/events/:eventId/actions',
    async (request, reply) => {
      const browserAuth = authorizeOwnerBrowserAction(request);
      if (!browserAuth) return reply.status(403).send({ error: 'invalid_action' });
      const owner = resolveSessionUserId(request);
      if (!owner) return reply.status(403).send({ error: 'invalid_action' });
      if (!lifecycleService) return reply.status(503).send({ error: 'mutation_unavailable' });
      const body = eventMemoryOwnerActionSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: 'invalid_request', details: body.error.issues });
      try {
        const result = await lifecycleService.executeOwnerAction(owner, request.params.eventId, body.data);
        if (!('error' in result)) return result;
        return reply.status(ownerMemoryActionHttpStatus(result.error)).send(result);
      } catch (error) {
        request.log.warn({ err: error }, '[F227] Owner Event mutation unavailable');
        return reply.status(503).send({ error: 'mutation_unavailable' });
      }
    },
  );

  // F227 Task 8 (AC-A5): magic-word meanings (word → meaning/action) read from injected governance.
  // The timeline's meaning popover consumes this; no hardcoded word table.
  app.get('/api/memory/magic-words', async (request, reply) => {
    if (!isAuthenticated(request)) {
      reply.status(401);
      return { error: 'auth required' };
    }
    return { magicWords: getMagicWordMeanings() };
  });

  // F227 Task 4: generic teleport — POST /api/memory/teleport → socket thread:teleport.
  // Independent socket event (does NOT reuse workspace:navigate, per design gate).
  // Takes a real (threadId, messageId); the Hub switches thread + scrolls to it.
  app.post<{ Body: { threadId?: string; messageId?: string; catId?: string } }>(
    '/api/memory/teleport',
    async (request, reply) => {
      if (!isAuthenticated(request)) {
        reply.status(401);
        return { error: 'auth required' };
      }
      const owner = ownerUserIdOf(request);
      if (!owner) {
        reply.status(403);
        return { error: 'owner scope required' };
      }
      const { threadId, messageId } = request.body ?? {};
      if (!threadId || !messageId) {
        reply.status(400);
        return { error: 'threadId and messageId required' };
      }
      // F227 (cloud-review P1 / 砚砚): only teleport to one of the caller's OWN event
      // coordinates — a client cannot drive navigation to another user's event.
      if (opts.eventMemoryStore.getByCoord(threadId, messageId, owner).length === 0) {
        reply.status(404);
        return { error: 'no such event for this owner' };
      }
      const eventData = { threadId, messageId, eventId: randomUUID() };
      opts.socketEmit?.('thread:teleport', eventData, 'workspace:global');
      return { ok: true, threadId, messageId };
    },
  );

  // F227 Task 7: backfill historical magic-word events from the message corpus.
  // Idempotent (store atomic UNIQUE owner+coord+type) — safe to re-run and safe vs the
  // PR-1 live path. Operator/cat-triggered (cat_cafe_backfill_events). Owner-scoped: only
  // the caller's own messages are scanned and written (cloud-review P1).
  app.post('/api/memory/events/backfill', async (request, reply) => {
    if (!isAuthenticated(request)) {
      reply.status(401);
      return { error: 'auth required' };
    }
    if (!opts.threadStore || !opts.messageStore) {
      reply.status(501);
      return { error: 'backfill not configured' };
    }
    const owner = ownerUserIdOf(request);
    if (!owner) {
      reply.status(403);
      return { error: 'owner scope required' };
    }
    const result = await runCorpusBackfill(opts.threadStore, opts.messageStore, opts.eventMemoryStore, {
      userId: owner,
    });
    return { ok: true, ...result };
  });
};

function projectOwnerEvent(event: StoredEventMemoryLifecycle, pendingCorrectionCount: number) {
  return { ...projectEventSnapshot(event), pendingCorrectionCount };
}

function projectEventSnapshot(event: StoredEventMemoryLifecycle) {
  return { ...event, revision: eventMemoryRevision(event) };
}

async function listEventCorrections(
  store: EventMemoryCorrectionProposalStore | undefined,
  ownerUserId: string,
  eventId: string,
) {
  return store ? store.listActionableForEvent(ownerUserId, eventId, 100) : [];
}

function buildEventSlice(
  serialized: string,
  revision: string,
  query: { charOffset?: string; revision?: string },
): { statusCode: 200 | 400; body: Record<string, unknown> } | null {
  if (query.charOffset === undefined) return null;
  if (!query.revision) return { statusCode: 400, body: { error: 'Revision required' } };
  if (!/^\d+$/.test(query.charOffset)) {
    return { statusCode: 400, body: { error: 'Invalid charOffset' } };
  }
  const charOffset = Number(query.charOffset);
  if (!Number.isSafeInteger(charOffset) || charOffset >= serialized.length) {
    return { statusCode: 400, body: { error: 'Invalid charOffset' } };
  }
  const eventSlice = serialized.slice(charOffset, charOffset + 8_000);
  const nextCharOffset = charOffset + eventSlice.length;
  return {
    statusCode: 200,
    body: {
      revision,
      eventSlice,
      charOffset,
      totalChars: serialized.length,
      ...(nextCharOffset < serialized.length ? { nextCharOffset } : {}),
    },
  };
}
