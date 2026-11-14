import {
  bringToDeskInputSchema,
  restoreSuggestionKindBodySchema,
  type SuggestionByline,
  type SuggestionView,
  suggestionDecisionBodySchema,
  suggestionFactsQuerySchema,
  suggestionOfferInputSchema,
  suggestionReceiptInputSchema,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SuggestionDesk } from '../domains/suggestions/desk-delivery.js';
import type {
  SuggestionActor,
  SuggestionFailureCode,
  SuggestionResult,
  SuggestionService,
} from '../domains/suggestions/SuggestionService.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { requirePrivilegedRouteOwner } from '../utils/privileged-route-guard.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import {
  type AgentKeyAuthRegistry,
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';
import { deriveCallbackActor } from './callback-scope-helpers.js';

export interface SuggestionSocketPublisher {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

export type SuggestionCallbackOperation = 'offer' | 'receipt' | 'facts' | 'bring';

export interface SuggestionRoutesOptions {
  service: SuggestionService;
  /** F335 交付三：cats bring a finished work to the desk. */
  desk?: SuggestionDesk;
  callbackRegistry: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
  /** Who is speaking for a callback actor; the watcher line plugs in its own check. Default: an ordinary cat. */
  resolveByline?(actor: Omit<SuggestionActor, 'byline'>): SuggestionByline | Promise<SuggestionByline>;
  /** `bring` (交付三 desk delivery) speaks to the person like `offer`; only `facts` is read-only. */
  authorizeActor?(actor: SuggestionActor, operation: SuggestionCallbackOperation): Promise<boolean>;
}

/** `suggestion_updated` to the conversation's room; the open page swaps the one row in place. */
export function publishSuggestionUpdate(
  socketManager: SuggestionSocketPublisher | null | undefined,
  threadId: string,
  suggestion: SuggestionView,
): void {
  socketManager?.broadcastToRoom(`thread:${threadId}`, 'suggestion_updated', { threadId, suggestion });
}

const STATUS: Record<SuggestionFailureCode, number> = {
  invalid: 400,
  unknown_kind: 400,
  kind_stopped: 409,
  message_not_found: 404,
  message_taken: 409,
  not_found: 404,
  conflict: 409,
  action_failed: 422,
  action_partial: 422,
};

function send<T>(reply: FastifyReply, result: SuggestionResult<T>) {
  if (result.ok) return result.value;
  reply.status(STATUS[result.code]);
  return { error: result.error, code: result.code, ...(result.view ? { suggestion: result.view } : {}) };
}

const CAT_CREDENTIAL_HEADERS = ['x-invocation-id', 'x-callback-token', 'x-agent-key-secret'] as const;
const PERSON_ONLY = { error: 'Only the person can decide this row', code: 'person_only' };

/** Anything carrying a cat's credentials — verified or not — is a cat acting, never the person clicking. */
function carriesCatCredentials(request: FastifyRequest): boolean {
  return (
    Boolean(request.callbackPrincipal) || CAT_CREDENTIAL_HEADERS.some((name) => request.headers[name] !== undefined)
  );
}

const idParams = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const threadParams = z.object({ threadId: z.string().trim().min(1).max(200) }).strict();

/**
 * F335 交付二「给人的东西」：回话下面那一排。人：列出、点用、撤销 / 恢复、忽略、「设置 › 你」已隐藏的建议；
 * 猫（回调）：发提议、发回执、把做好的作品带到桌面（交付三）、读按种类的事实（可顺带决定不再提某类）。
 */
export function registerSuggestionRoutes(app: FastifyInstance, options: SuggestionRoutesOptions): void {
  registerCallbackAuthHook(app, options.callbackRegistry, {
    ...(options.agentKeyRegistry ? { agentKeyRegistry: options.agentKeyRegistry } : {}),
  });
  const { service } = options;

  /** Reading the rows: the person's own session. Identity headers and request bodies never stand in for it. */
  function sessionPerson(request: FastifyRequest, reply: FastifyReply): string | null {
    if (carriesCatCredentials(request)) {
      reply.status(403).send(PERSON_ONLY);
      return null;
    }
    const userId = resolveSessionUserId(request);
    if (!userId) reply.status(401).send({ error: 'Authenticated session required' });
    return userId;
  }

  /**
   * Deciding a row acts as the person — Works comments, scheduled tasks, and the facts cats will weigh — so it takes
   * the owner's own session through the same gate as direct schedule mutations, never a cat's credentials. Apply and
   * undo also come from this machine only, like the Works page that writes the same comments.
   */
  function ownerDecision(request: FastifyRequest, reply: FastifyReply, local: boolean): string | null {
    if (carriesCatCredentials(request)) {
      reply.status(403).send(PERSON_ONLY);
      return null;
    }
    const gate = requirePrivilegedRouteOwner(request, reply, {
      surface: 'Suggestion decisions',
      ownerErrorMessage: 'Only the owner can act on these suggestions',
    });
    if (!gate.ok) {
      reply.send(gate.response);
      return null;
    }
    if (local && !isDirectLoopbackRequest(request)) {
      reply.status(403).send({ error: 'Apply and undo are available on this machine only', code: 'local_only' });
      return null;
    }
    return resolveSessionUserId(request);
  }

  app.get('/api/threads/:threadId/suggestions', async (request, reply) => {
    const userId = sessionPerson(request, reply);
    if (!userId) return reply;
    const params = threadParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid thread' });
    return { threadId: params.data.threadId, suggestions: await service.listThread(userId, params.data.threadId) };
  });

  const decisions = [
    ['apply', true, (u: string, id: string, r: number) => service.apply(u, id, r)],
    ['undo', true, (u: string, id: string, r: number) => service.undo(u, id, r)],
    ['dismiss', false, (u: string, id: string, r: number) => service.dismiss(u, id, r)],
  ] as const;
  for (const [verb, local, decide] of decisions) {
    app.post(`/api/suggestions/:id/${verb}`, async (request, reply) => {
      const userId = ownerDecision(request, reply, local);
      if (!userId) return reply;
      const params = idParams.safeParse(request.params);
      const body = suggestionDecisionBodySchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.status(400).send({ error: 'Invalid request' });
      return send(reply, await decide(userId, params.data.id, body.data.expectedRevision));
    });
  }

  app.get('/api/suggestions/hidden-kinds', async (request, reply) => {
    const userId = sessionPerson(request, reply);
    if (!userId) return reply;
    return { hidden: await service.listHidden(userId) };
  });

  app.post('/api/suggestions/hidden-kinds/restore', async (request, reply) => {
    const userId = ownerDecision(request, reply, false);
    if (!userId) return reply;
    const body = restoreSuggestionKindBodySchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Invalid request' });
    return { restored: await service.restoreKind(userId, body.data.catId, body.data.kind) };
  });

  async function catActor(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: SuggestionCallbackOperation,
  ): Promise<SuggestionActor | null> {
    const record = requireCallbackAuth(request, reply);
    if (!record) return null;
    const actor = deriveCallbackActor(record);
    const base = {
      userId: actor.userId,
      threadId: actor.threadId,
      catId: actor.catId,
      invocationId: actor.invocationId,
      ...(actor.parentInvocationId ? { parentInvocationId: actor.parentInvocationId } : {}),
    };
    const resolved = { ...base, byline: (await options.resolveByline?.(base)) ?? 'cat' };
    if (options.authorizeActor && !(await options.authorizeActor(resolved, operation))) {
      reply.code(403).send({ error: 'Watcher is quiet or no longer current', code: 'watcher_quiet' });
      return null;
    }
    return resolved;
  }

  app.post('/api/callbacks/suggestions', async (request, reply) => {
    const actor = await catActor(request, reply, 'offer');
    if (!actor) return;
    const body = suggestionOfferInputSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Invalid suggestion', details: body.error.issues });
    return send(reply, await service.offer(actor, body.data));
  });

  app.post('/api/callbacks/suggestion-receipts', async (request, reply) => {
    const actor = await catActor(request, reply, 'receipt');
    if (!actor) return;
    const body = suggestionReceiptInputSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Invalid receipt', details: body.error.issues });
    return send(reply, await service.postReceipt(actor, body.data));
  });

  const { desk } = options;
  if (desk) {
    app.post('/api/callbacks/desk-deliveries', async (request, reply) => {
      const actor = await catActor(request, reply, 'bring');
      if (!actor) return;
      const body = bringToDeskInputSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: 'Invalid delivery', details: body.error.issues });
      return send(reply, await desk.bring(actor, body.data));
    });
  }

  app.post('/api/callbacks/suggestion-facts', async (request, reply) => {
    const actor = await catActor(request, reply, 'facts');
    if (!actor) return;
    const body = suggestionFactsQuerySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Invalid query', details: body.error.issues });
    return send(reply, await service.facts(actor, body.data));
  });
}
