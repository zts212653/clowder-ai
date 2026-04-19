/**
 * Journey Routes — F160 Cat Journey RPG
 * GET  /api/journey/overview             — team-wide journey overview
 * GET  /api/journey/:catId               — single cat journey profile
 * GET  /api/journey/:catId/events        — XP event audit trail (AC-A5)
 * GET  /api/journey/:catId/titles        — unlocked titles (AC-B1)
 * GET  /api/journey/:catId/bonds         — bond relationships (AC-B2)
 * POST /api/journey/:catId/export-image  — PNG screenshot of profile card (AC-A3)
 */

import type { FastifyPluginAsync } from 'fastify';
import { resolveFrontendBaseUrl } from '../config/frontend-origin.js';
import type { GrowthService } from '../domains/cats/services/growth/GrowthService.js';
import { ImageExporter } from '../services/ImageExporter.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface GrowthRoutesOptions {
  growthService: GrowthService;
  /** Phase E (AC-E1): Evolution event service for milestone timeline */
  evolutionService?: import('../domains/cats/services/growth/EvolutionService.js').EvolutionService;
}

export const journeyRoutes: FastifyPluginAsync<GrowthRoutesOptions> = async (app, opts) => {
  const { growthService } = opts;

  // Plugin-scoped singleton ImageExporter (browser reuse across requests)
  let sharedExporter: ImageExporter | null = null;
  app.addHook('onClose', async () => {
    if (sharedExporter) {
      await sharedExporter.close();
      sharedExporter = null;
    }
  });

  /** Team overview — all cats' journey profiles */
  app.get('/api/journey/overview', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const overview = await growthService.getOverview();
    return overview;
  });

  /** Single cat journey profile */
  app.get<{ Params: { catId: string } }>('/api/journey/:catId', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const { catId } = request.params;
    const profile = await growthService.getProfile(catId);
    if (!profile) {
      return reply.status(404).send({ error: `Cat not found: ${catId}` });
    }
    return profile;
  });

  /** AC-A5: XP event audit trail — newest first, with pagination. */
  app.get<{ Params: { catId: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/journey/:catId/events',
    async (request, reply) => {
      const userId = resolveHeaderUserId(request);
      if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

      const { catId } = request.params;
      const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), 200);
      const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0);

      const events = await growthService.getXpEvents(catId, limit, offset);
      return { catId, events, limit, offset };
    },
  );

  /** AC-B1: Unlocked titles for a cat — includes all definitions with unlock status. */
  app.get<{ Params: { catId: string } }>('/api/journey/:catId/titles', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const { catId } = request.params;
    const unlocked = await growthService.getUnlockedTitles(catId);
    return { catId, unlocked };
  });

  /** AC-B2: Bond relationships for a cat. */
  app.get<{ Params: { catId: string } }>('/api/journey/:catId/bonds', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const { catId } = request.params;
    const bonds = await growthService.getBonds(catId);
    return { catId, bonds };
  });

  /** AC-E1: Evolution milestone events — newest first, with pagination. */
  if (opts.evolutionService) {
    const evoSvc = opts.evolutionService;
    app.get<{ Params: { catId: string }; Querystring: { limit?: string; offset?: string } }>(
      '/api/journey/:catId/evolution',
      async (request, reply) => {
        const userId = resolveHeaderUserId(request);
        if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

        const { catId } = request.params;
        const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), 200);
        const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0);

        const events = await evoSvc.getEvents(catId, limit, offset);
        return { catId, events, limit, offset };
      },
    );
  }

  /** AC-A3: Export cat profile card as PNG image */
  app.post<{ Params: { catId: string } }>('/api/journey/:catId/export-image', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const { catId } = request.params;

    // Verify cat exists before launching Puppeteer
    const profile = await growthService.getProfile(catId);
    if (!profile) {
      return reply.status(404).send({ error: `Cat not found: ${catId}` });
    }

    try {
      const frontendUrl = resolveFrontendBaseUrl(process.env, app.log);
      const url = `${frontendUrl}/growth-export/${catId}`;
      app.log.info({ catId, url }, 'Exporting journey card to PNG');

      const exporter = sharedExporter ?? (sharedExporter = new ImageExporter());
      const imageBuffer = await exporter.capture(url, userId, 480);

      return reply.type('image/png').send(imageBuffer);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      app.log.error({ error: msg, catId }, 'Journey card export failed');
      return reply.status(500).send({ error: 'Export failed', message: msg });
    }
  });
};
