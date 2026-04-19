/**
 * Achievement Routes — F160 Phase C
 * GET  /api/achievements/:memberId              — unlocked achievements for a member
 * GET  /api/achievements/:memberId/wall         — all achievements with unlock status
 * GET  /api/achievements/:memberId/counters     — event counters for progress display
 * POST /api/achievements/:memberId/export-image — PNG screenshot of achievement wall (AC-C4)
 */

import { ACHIEVEMENT_DEFINITIONS } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { resolveFrontendBaseUrl } from '../config/frontend-origin.js';
import type { AchievementService } from '../domains/cats/services/growth/AchievementService.js';
import { ImageExporter } from '../services/ImageExporter.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface AchievementRoutesOptions {
  achievementService: AchievementService;
}

export const achievementRoutes: FastifyPluginAsync<AchievementRoutesOptions> = async (app, opts) => {
  const { achievementService } = opts;

  // Plugin-scoped singleton ImageExporter (browser reuse across requests)
  let sharedExporter: ImageExporter | null = null;
  app.addHook('onClose', async () => {
    if (sharedExporter) {
      await sharedExporter.close();
      sharedExporter = null;
    }
  });

  /** Unlocked achievements for a member (cat or co-creator) */
  app.get<{ Params: { memberId: string } }>('/api/achievements/:memberId', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const { memberId } = request.params;
    const unlocked = await achievementService.getUnlocked(memberId);
    return { memberId, unlocked };
  });

  /** Achievement wall — all definitions with unlock status */
  app.get<{ Params: { memberId: string } }>('/api/achievements/:memberId/wall', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const { memberId } = request.params;
    const unlocked = await achievementService.getUnlocked(memberId);
    const unlockedMap = new Map(unlocked.map((u) => [u.achievementId, u]));

    const wall = ACHIEVEMENT_DEFINITIONS.map((def) => ({
      ...def,
      unlocked: unlockedMap.get(def.id) ?? null,
    }));
    return {
      memberId,
      achievements: wall,
      totalUnlocked: unlocked.length,
      totalDefined: ACHIEVEMENT_DEFINITIONS.length,
    };
  });

  /** Event counters for progress display */
  app.get<{ Params: { memberId: string } }>('/api/achievements/:memberId/counters', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const { memberId } = request.params;
    const counters = await achievementService.getCounters(memberId);
    return { memberId, counters };
  });

  /** AC-C4: Export achievement wall as PNG image */
  app.post<{ Params: { memberId: string } }>('/api/achievements/:memberId/export-image', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const { memberId } = request.params;
    const unlocked = await achievementService.getUnlocked(memberId);
    if (unlocked.length === 0) {
      return reply.status(404).send({ error: '暂无已解锁成就' });
    }

    try {
      const frontendUrl = resolveFrontendBaseUrl(process.env, app.log);
      const url = `${frontendUrl}/achievement-export/${memberId}`;
      app.log.info({ memberId, url }, 'Exporting achievement wall to PNG');

      const exporter = sharedExporter ?? (sharedExporter = new ImageExporter());
      const imageBuffer = await exporter.capture(url, userId, 480);

      return reply.type('image/png').send(imageBuffer);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      app.log.error({ error: msg, memberId }, 'Achievement export failed');
      return reply.status(500).send({ error: 'Export failed', message: msg });
    }
  });
};
