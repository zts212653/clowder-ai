/**
 * Leadership Routes — F160 Phase D (铲屎官六维)
 * GET  /api/journey/leadership         — co-creator leadership profile
 * GET  /api/journey/leadership/titles   — unlocked leadership titles
 * GET  /api/journey/leadership/events   — leadership footfall audit trail
 */

import type { FastifyPluginAsync } from 'fastify';
import type { LeadershipService } from '../domains/cats/services/growth/LeadershipService.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface LeadershipRoutesOptions {
  leadershipService: LeadershipService;
}

export const leadershipRoutes: FastifyPluginAsync<LeadershipRoutesOptions> = async (app, opts) => {
  const { leadershipService } = opts;

  /** Co-creator leadership profile snapshot */
  app.get('/api/journey/leadership', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const profile = await leadershipService.getProfile();
    return profile;
  });

  /** Unlocked leadership titles, newest first. */
  app.get('/api/journey/leadership/titles', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const titles = await leadershipService.getUnlockedTitles();
    return { titles };
  });

  /** Leadership footfall audit trail — newest first, with pagination. */
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/api/journey/leadership/events',
    async (request, reply) => {
      const userId = resolveHeaderUserId(request);
      if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

      const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), 200);
      const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0);

      const events = await leadershipService.getAuditLog(limit, offset);
      return { events, limit, offset };
    },
  );
};
