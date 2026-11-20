/**
 * Companion scene archive routes (F336 Phase C, plan §D)
 *
 * GET /api/concierge/companion-scene?catId=…&sceneId=desktop — 200 found | not_found; 503 error
 * PUT /api/concierge/companion-scene?catId=…&sceneId=desktop — {baseRevision, snapshot}
 *     200 ok {revision}; 409 conflict {current}; 503 error
 *
 * Owner-local only, like the native config view; keyed by the authenticated operator.
 * No clearing route: the first slice has no way to delete a scene.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  companionSceneSnapshotError,
  isCompanionSceneSnapshot,
} from '../domains/concierge/scene/companion-scene-snapshot.js';
import type { ICompanionSceneStore } from '../domains/concierge/scene/companion-scene-store.js';
import { requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export interface ConciergeCompanionSceneOptions {
  store: ICompanionSceneStore;
}

const ROUTE = '/api/concierge/companion-scene';

// catId is a key component here, not a routing target: a format check (colon-free)
// keeps the key unambiguous, and a scene stays readable if the roster changes.
const addressSchema = z
  .object({
    catId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    sceneId: z.literal('desktop'),
  })
  .strict();

const writeSchema = z
  .object({
    baseRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    snapshot: z.unknown(),
  })
  .strict();

export function registerConciergeCompanionSceneRoutes(
  app: FastifyInstance,
  { store }: ConciergeCompanionSceneOptions,
): void {
  app.get(ROUTE, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    const address = addressSchema.safeParse(request.query);
    if (!address.success) return reply.code(400).send({ error: 'Invalid companion scene address' });
    const result = await store.get({ userId: access.operator, ...address.data });
    if (result.status !== 'error') return result;
    request.log.warn({ code: 'companion_scene_unreadable', reason: result.reason, ...address.data }, 'Scene unread');
    return reply.code(503).send(result);
  });

  app.put(ROUTE, async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    const address = addressSchema.safeParse(request.query);
    if (!address.success) return reply.code(400).send({ error: 'Invalid companion scene address' });
    const body = writeSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid companion scene write' });
    const { baseRevision, snapshot } = body.data;
    if (!isCompanionSceneSnapshot(snapshot))
      return reply.code(400).send({ error: companionSceneSnapshotError(snapshot) });
    const result = await store.put({ userId: access.operator, ...address.data }, { baseRevision, snapshot });
    if (result.status === 'ok') return result;
    if (result.status === 'conflict') return reply.code(409).send(result);
    request.log.warn({ code: 'companion_scene_unwritten', ...address.data }, 'Scene write unavailable');
    return reply.code(503).send(result);
  });
}
