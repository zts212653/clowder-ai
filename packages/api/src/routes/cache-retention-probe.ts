import { timingSafeEqual } from 'node:crypto';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import {
  CacheRetentionProbeRefusal,
  type CacheRetentionProbeService,
} from '../domains/cats/services/session/cache/CacheRetentionProbeService.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';
import { type CacheRetentionSettingsPort, cacheRetentionSettingsRoutes } from './cache-retention-settings.js';

interface Options extends FastifyPluginOptions {
  readonly enabled: boolean;
  readonly threads: Pick<IThreadStore, 'get'>;
  readonly service: Pick<CacheRetentionProbeService, 'probe'>;
  readonly settings?: CacheRetentionSettingsPort;
}

/** Non-runtime acceptance entry. It cannot enable automatic renewal or change member settings. */
export async function cacheRetentionProbeRoutes(app: FastifyInstance, opts: Options): Promise<void> {
  if (opts.settings) await cacheRetentionSettingsRoutes(app, opts.settings);
  app.post<{ Params: { threadId: string; catId: string } }>(
    '/api/threads/:threadId/sessions/:catId/cache-retention-probe',
    async (request, reply) => {
      if (!opts.enabled) return reply.code(404).send({ error: 'Not found' });
      const userId = resolveDirectLocalAuthorizationUserId(request, { requireOwnerSession: true });
      if (!userId || !request.sessionUserId || request.sessionIsLocalOwner !== true || !request.assertSessionCurrent)
        return reply.code(401).send({ error: 'Local owner session required' });
      const presented = request.headers['x-csrf-token'];
      const expected = request.sessionCsrfToken;
      if (
        typeof presented !== 'string' ||
        !expected ||
        Buffer.byteLength(presented) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
      )
        return reply.code(403).send({ error: 'Session CSRF proof required' });
      if (!z.object({}).strict().safeParse(request.body).success)
        return reply.code(400).send({ error: 'The Host owns all probe inputs' });
      const thread = await opts.threads.get(request.params.threadId);
      if (!thread || !canAccessThread(thread, userId)) return reply.code(403).send({ error: 'Thread access denied' });
      const member = catRegistry.tryGet(request.params.catId);
      if (!member) return reply.code(404).send({ error: 'Member not found' });
      const stop = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableFinished) stop.abort();
      };
      reply.raw.once('close', onClose);
      try {
        request.assertSessionCurrent();
        return await opts.service.probe({
          userId,
          threadId: thread.id,
          catId: createCatId(request.params.catId),
          signal: stop.signal,
          assertCurrent: () => request.assertSessionCurrent!(),
        });
      } catch (error) {
        if (error instanceof CacheRetentionProbeRefusal) return reply.code(409).send({ error: error.code });
        request.log.error({ error }, 'Cache retention acceptance probe failed');
        return reply.code(500).send({ error: 'Cache retention probe failed' });
      } finally {
        reply.raw.removeListener('close', onClose);
      }
    },
  );
}
