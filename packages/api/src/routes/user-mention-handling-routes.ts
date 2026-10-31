import type { IgnoredItemSnapshot } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { requirePluginOwnerLocalAccess } from './plugin-access-guards.js';
import { readUserMentionPersonalPreview } from './user-mention-personal-preview.js';
import { classifyUserMentionPeriod } from './user-mention-todo-projection.js';

export type UserMentionInboxStore = Pick<
  IMessageStore,
  | 'getLastUserMentionHandling'
  | 'getUserMentionStateRevisions'
  | 'restoreUserMentionRequest'
  | 'listUserMentionRequests'
  | 'resolveUserMentionRequest'
  | 'initializeUserMentionInbox'
  | 'listHandledUserMentions'
  | 'getUserMentionHandlingMetadata'
  | 'handleUserMentionRequests'
  | 'undoUserMentionHandling'
>;

export function registerUserMentionHandlingRoutes(
  app: FastifyInstance,
  options: {
    ownerUserId: string;
    messageStore?: UserMentionInboxStore;
    now?: () => number;
    cutover: number;
    onResolved?: (userId: string) => void;
    readIgnoredItemPreferences?: (ownerUserId: string) => IgnoredItemSnapshot | Promise<IgnoredItemSnapshot>;
  },
) {
  const authorize = (request: Parameters<typeof requirePluginOwnerLocalAccess>[0], operation: 'read' | 'write') => {
    const access = requirePluginOwnerLocalAccess(request, operation);
    if ('error' in access) return access;
    return access.operator === options.ownerUserId ? access : { status: 403, error: 'Host owner required' };
  };
  app.get('/api/concierge/work/mentions/handling-preview', async (request, reply) => {
    const access = authorize(request, 'read');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    const query = z
      .object({
        before: z.coerce.number().int().nonnegative().optional(),
        period: z.enum(['today', 'week', 'earlier', 'all']).default('week'),
        personalView: z.literal('visible').optional(),
      })
      .strict()
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid time boundary' });
    if (query.data.personalView === 'visible') {
      reply.header('cache-control', 'no-store');
      return readUserMentionPersonalPreview({
        ownerUserId: access.operator,
        period: query.data.period,
        before: query.data.before,
        cutover: options.cutover,
        now: (options.now ?? Date.now)(),
        messageStore: options.messageStore,
        readIgnoredItemPreferences: options.readIgnoredItemPreferences,
      });
    }
    if (!options.messageStore) return reply.code(503).send({ error: 'Message owner unavailable' });
    const rows = await options.messageStore.listUserMentionRequests(access.operator);
    const now = (options.now ?? Date.now)();
    const revisions = await options.messageStore.getUserMentionStateRevisions(access.operator);
    const counts = { week: 0, earlier: 0 };
    for (const m of rows)
      counts[classifyUserMentionPeriod(m.timestamp, options.cutover, now) === 'earlier' ? 'earlier' : 'week']++;
    return {
      ownerUserId: access.operator,
      period: query.data.period,
      counts,
      requests: rows
        .filter((m) => {
          if (query.data.before !== undefined && m.timestamp >= query.data.before) return false;
          const group = classifyUserMentionPeriod(m.timestamp, options.cutover, now);
          return (
            query.data.period === 'all' ||
            (query.data.period === 'week' ? group !== 'earlier' : group === query.data.period)
          );
        })
        .map((m) => ({ threadId: m.threadId, messageId: m.id, expectedRevision: revisions[m.threadId] ?? 0 })),
      observedAt: now,
    };
  });
  app.get('/api/concierge/work/mentions/last-handling', async (request, reply) => {
    const access = authorize(request, 'read');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    if (!options.messageStore) return reply.code(503).send({ error: 'Message owner unavailable' });
    return {
      ownerUserId: access.operator,
      receipt: await options.messageStore.getLastUserMentionHandling(access.operator),
    };
  });
  app.post('/api/concierge/work/mentions/restore', async (request, reply) => {
    const access = authorize(request, 'write');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    const body = z
      .object({
        threadId: z.string().min(1).max(200),
        messageId: z.string().min(1).max(200),
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request version' });
    if (!options.messageStore) return reply.code(503).send({ error: 'Message owner unavailable' });
    const { threadId, messageId, expectedRevision } = body.data;
    const restored = await options.messageStore.restoreUserMentionRequest(
      access.operator,
      threadId,
      messageId,
      expectedRevision,
    );
    if (!restored) return reply.code(409).send({ error: 'Request changed; reread before restoring' });
    options.onResolved?.(access.operator);
    return { restored: true };
  });
  app.post('/api/concierge/work/mentions/handle', async (request, reply) => {
    const access = authorize(request, 'write');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    const body = z
      .object({
        requests: z
          .array(
            z
              .object({
                threadId: z.string().min(1).max(200),
                messageId: z.string().min(1).max(200),
                expectedRevision: z.number().int().nonnegative().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(10000),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request snapshot' });
    if (!options.messageStore) return reply.code(503).send({ error: 'Message owner unavailable' });
    const result = await options.messageStore.handleUserMentionRequests(access.operator, body.data.requests);
    if (!result) return reply.code(409).send({ error: 'Requests changed; reread before handling' });
    options.onResolved?.(access.operator);
    return result;
  });
  app.post('/api/concierge/work/mentions/undo', async (request, reply) => {
    const access = authorize(request, 'write');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    const body = z.object({ undoId: z.string().uuid() }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid undo receipt' });
    if (!options.messageStore) return reply.code(503).send({ error: 'Message owner unavailable' });
    const result = await options.messageStore.undoUserMentionHandling(access.operator, body.data.undoId);
    if (!result) return reply.code(409).send({ error: 'Undo is no longer available' });
    options.onResolved?.(access.operator);
    return result;
  });
}
