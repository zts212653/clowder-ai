/**
 * F166: Cat display order — GET/PUT /api/config/cat-order.
 * Owner-gated writes, file-backed persistence via cat-order-store.
 */

import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getOwnerUserId } from '../config/cat-config-loader.js';
import { loadCatOrder, saveCatOrder } from '../config/cat-order-store.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface CatOrderRoutesOptions {
  projectRoot: string;
}

const putSchema = z.object({
  catOrder: z.array(z.string().min(1)),
});

export async function configCatOrderRoutes(app: FastifyInstance, opts: CatOrderRoutesOptions): Promise<void> {
  const { projectRoot } = opts;

  app.get('/api/config/cat-order', async () => ({
    catOrder: loadCatOrder(projectRoot),
  }));

  app.put('/api/config/cat-order', async (request: FastifyRequest, reply: FastifyReply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    if (operator !== getOwnerUserId()) {
      reply.status(403);
      return { error: 'Only the owner can change cat order' };
    }

    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const deduped = [...new Set(parsed.data.catOrder)];
    const unknown = deduped.find((id) => !catRegistry.has(id));
    if (unknown) {
      reply.status(400);
      return { error: `Unknown catId: ${unknown}` };
    }

    saveCatOrder(projectRoot, deduped);
    return { catOrder: deduped };
  });
}
