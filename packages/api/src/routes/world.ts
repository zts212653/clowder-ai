import { WorldActionEnvelopeSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IWorldStore } from '../domains/world/interfaces.js';
import type { WorldRuntimeCoordinator } from '../domains/world/WorldRuntimeCoordinator.js';

export interface WorldRoutesOptions {
  worldStore: IWorldStore;
  coordinator: WorldRuntimeCoordinator;
}

const createWorldSchema = z.object({
  worldId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  constitution: z.string().optional(),
  threadId: z.string().optional(),
});

const createSceneSchema = z.object({
  sceneId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  mode: z.enum(['build', 'perform', 'replay']),
  setting: z.string().optional(),
  activeCharacterIds: z.array(z.string()).optional(),
});

function requireAuth(request: { sessionUserId?: string }): string {
  const userId = request.sessionUserId;
  if (!userId) throw { statusCode: 401, message: 'Authentication required' };
  return userId;
}

export const worldRoutes: FastifyPluginAsync<WorldRoutesOptions> = async (app, opts) => {
  const { worldStore, coordinator } = opts;

  app.post('/api/worlds', async (request, reply) => {
    const userId = requireAuth(request as { sessionUserId?: string });

    const body = createWorldSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });

    const now = new Date().toISOString();
    try {
      await worldStore.createWorld({
        ...body.data,
        status: 'active',
        createdBy: { kind: 'user', id: userId },
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint') || msg.includes('already exists')) {
        return reply.status(409).send({ error: `World '${body.data.worldId}' already exists` });
      }
      throw err;
    }

    const world = await worldStore.getWorld(body.data.worldId);
    return reply.status(201).send(world);
  });

  app.get('/api/worlds/:worldId', async (request, reply) => {
    const userId = requireAuth(request as { sessionUserId?: string });
    const { worldId } = request.params as { worldId: string };
    const world = await worldStore.getWorld(worldId);
    if (!world) return reply.status(404).send({ error: 'World not found' });
    if (world.createdBy.id !== userId) return reply.status(403).send({ error: 'Forbidden' });
    return world;
  });

  app.post('/api/worlds/:worldId/scenes', async (request, reply) => {
    const userId = requireAuth(request as { sessionUserId?: string });
    const { worldId } = request.params as { worldId: string };
    const world = await worldStore.getWorld(worldId);
    if (!world) return reply.status(404).send({ error: 'World not found' });
    if (world.createdBy.id !== userId) return reply.status(403).send({ error: 'Forbidden' });

    const body = createSceneSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });

    const now = new Date().toISOString();
    try {
      await worldStore.createScene({
        ...body.data,
        worldId,
        status: 'active',
        activeCharacterIds: body.data.activeCharacterIds ?? [],
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint') || msg.includes('already exists')) {
        return reply.status(409).send({ error: `Scene '${body.data.sceneId}' already exists` });
      }
      throw err;
    }

    const scene = await worldStore.getScene(body.data.sceneId);
    return reply.status(201).send(scene);
  });

  app.post('/api/worlds/:worldId/actions', async (request, reply) => {
    const userId = requireAuth(request as { sessionUserId?: string });
    const { worldId } = request.params as { worldId: string };
    const world = await worldStore.getWorld(worldId);
    if (!world) return reply.status(404).send({ error: 'World not found' });
    if (world.createdBy.id !== userId) return reply.status(403).send({ error: 'Forbidden' });
    const envelope = WorldActionEnvelopeSchema.safeParse({
      ...(request.body as Record<string, unknown>),
      worldId,
    });
    if (!envelope.success) return reply.status(400).send({ error: envelope.error.message });

    let result: Awaited<ReturnType<typeof coordinator.execute>>;
    try {
      result = await coordinator.execute(envelope.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
    if (result.errors?.length) {
      return reply.status(422).send({ errors: result.errors, events: [] });
    }
    return { events: result.events };
  });

  app.get('/api/worlds/:worldId/replay', async (request, reply) => {
    const userId = requireAuth(request as { sessionUserId?: string });
    const { worldId } = request.params as { worldId: string };
    const { sceneId, limit } = request.query as { sceneId?: string; limit?: string };

    const world = await worldStore.getWorld(worldId);
    if (!world) return reply.status(404).send({ error: 'World not found' });
    if (world.createdBy.id !== userId) return reply.status(403).send({ error: 'Forbidden' });

    if (!sceneId) return reply.status(400).send({ error: 'sceneId query parameter is required' });
    let parsedLimit = 50;
    if (limit) {
      parsedLimit = Number.parseInt(limit, 10);
      if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
        return reply.status(400).send({ error: 'limit must be a positive integer (1-500)' });
      }
    }
    const events = await worldStore.getRecentEvents(worldId, sceneId, parsedLimit);
    return { events };
  });
};
