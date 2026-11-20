import { timingSafeEqual } from 'node:crypto';
import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CacheRetentionSettingsService } from '../domains/cats/services/session/cache/CacheRetentionSettingsService.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

export type CacheRetentionSettingsPort = Pick<CacheRetentionSettingsService, 'get' | 'set'>;

function owner(request: FastifyRequest): string | null {
  const userId = resolveDirectLocalAuthorizationUserId(request, { requireOwnerSession: true });
  return userId && request.sessionUserId && request.sessionIsLocalOwner === true && request.assertSessionCurrent
    ? userId
    : null;
}

export async function cacheRetentionSettingsRoutes(
  app: FastifyInstance,
  settings: CacheRetentionSettingsPort,
): Promise<void> {
  app.get<{ Params: { catId: string } }>('/api/cats/:catId/cache-retention', async (request, reply) => {
    const userId = owner(request);
    if (!userId) return reply.code(401).send({ error: 'Local owner session required' });
    if (!catRegistry.tryGet(request.params.catId)) return reply.code(404).send({ error: 'Member not found' });
    request.assertSessionCurrent!();
    return settings.get(userId, request.params.catId);
  });
  app.put<{ Params: { catId: string } }>('/api/cats/:catId/cache-retention', async (request, reply) => {
    const userId = owner(request);
    if (!userId) return reply.code(401).send({ error: 'Local owner session required' });
    const token = request.headers['x-csrf-token'],
      expected = request.sessionCsrfToken;
    if (
      typeof token !== 'string' ||
      !expected ||
      Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    )
      return reply.code(403).send({ error: 'Session CSRF proof required' });
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Only the enabled preference can be changed' });
    if (!catRegistry.tryGet(request.params.catId)) return reply.code(404).send({ error: 'Member not found' });
    request.assertSessionCurrent!();
    const current = await settings.get(userId, request.params.catId);
    if (parsed.data.enabled && !current.supported)
      return reply.code(409).send({ error: current.reason ?? 'Cache retention is unavailable for this member' });
    request.assertSessionCurrent!();
    return settings.set(userId, request.params.catId, parsed.data.enabled);
  });
}
