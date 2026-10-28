import type { IgnoredItemSnapshot } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { RuntimeInteractionPendingReadSource } from '../domains/runtime-interaction/ports/RuntimeInteractionStore.js';
import type { CollectiveAccountabilitySource } from './companion-collective-accountability-source.js';
import { companionDecisionWireResponse, readCompanionDecisionProjection } from './companion-decision-read-service.js';
import { requirePluginOwnerLocalAccess } from './plugin-access-guards.js';
import { registerUserMentionHandlingRoutes, type UserMentionInboxStore } from './user-mention-handling-routes.js';
import type { MentionReadOptions } from './user-mention-todo-projection.js';

const pageSchema = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(20).default(20),
    view: z.literal('unified').optional(),
    includeUserMentions: z.literal('true').optional(),
    mentionPeriod: z.enum(['recent', 'today', 'week', 'earlier', 'handled', 'all']).default('week'),
    personalView: z.enum(['visible', 'ignored']).optional(),
  })
  .strict();

/** Owner-local decision read and exact-source mention acknowledgement, independent of Live configuration. */
export const companionDecisionRoutes: FastifyPluginAsync<{
  ownerUserId: string;
  collectiveAccountability?: CollectiveAccountabilitySource;
  messageStore?: UserMentionInboxStore & Pick<IMessageStore, 'getById'>;
  now?: () => number;
  threadStore?: MentionReadOptions['threads'];
  runtimeInteractionStore?: RuntimeInteractionPendingReadSource;
  onResolved?: (userId: string) => void;
  readIgnoredItemPreferences?: (ownerUserId: string) => IgnoredItemSnapshot | Promise<IgnoredItemSnapshot>;
}> = async (app, options) => {
  const cutover = options.messageStore
    ? await options.messageStore.initializeUserMentionInbox((options.now ?? Date.now)())
    : 0;
  registerUserMentionHandlingRoutes(app, { ...options, cutover });
  app.get('/api/concierge/work/decisions', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    if (access.operator !== options.ownerUserId) return reply.code(403).send({ error: 'Host owner required' });
    const page = pageSchema.safeParse(request.query);
    if (!page.success) return reply.code(400).send({ error: 'Invalid decision page' });
    const { offset, limit, view, includeUserMentions, mentionPeriod, personalView } = page.data;
    if (personalView && view !== 'unified')
      return reply.code(400).send({ error: 'Personal view requires unified read' });
    const result = await readCompanionDecisionProjection(
      app,
      access.operator,
      { offset, limit },
      view === 'unified' && includeUserMentions === 'true' ? options.messageStore : undefined,
      { cutover, now: (options.now ?? Date.now)(), period: mentionPeriod, threads: options.threadStore },
      options.runtimeInteractionStore,
      personalView ? { mode: personalView, read: options.readIgnoredItemPreferences } : undefined,
      options.messageStore,
      options.collectiveAccountability,
    );
    const response = companionDecisionWireResponse(result, view);
    return reply.code(response.statusCode).send(response.body);
  });
  app.post('/api/concierge/work/mentions/:threadId/resolve', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    if (access.operator !== options.ownerUserId) return reply.code(403).send({ error: 'Host owner required' });
    const params = z
      .object({ threadId: z.string().min(1).max(200) })
      .strict()
      .safeParse(request.params);
    const body = z
      .object({
        expectedMessageId: z.string().min(1).max(200),
        expectedRevision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid request source' });
    if (!options.messageStore) return reply.code(503).send({ error: 'Message owner unavailable' });
    const closed = await options.messageStore.resolveUserMentionRequest(
      access.operator,
      params.data.threadId,
      body.data.expectedMessageId,
      body.data.expectedRevision,
    );
    if (closed) options.onResolved?.(access.operator);
    return closed ? { status: 'resolved' } : reply.code(409).send({ error: 'Request changed; reread current source' });
  });
};
