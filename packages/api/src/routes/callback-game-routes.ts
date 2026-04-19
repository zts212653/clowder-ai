/**
 * Callback Game Routes — game action submission via HTTP callback auth.
 * Fallback path for cats whose MCP connection is unavailable (transient
 * failure, env misconfiguration, etc.). All major cats have native MCP
 * with cat_cafe_submit_game_action in collabTools — this endpoint is a
 * safety net, not the primary game action path. Auth is validated via
 * invocationId + callbackToken, then proxied to the existing game action
 * route via Fastify inject (reuses all game validation logic).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const submitGameActionSchema = z.object({
  gameId: z.string().min(1),
  round: z.number().int().min(1),
  phase: z.string().min(1),
  seat: z.number().int().min(1),
  action: z.string().min(1),
  target: z.number().int().min(1).optional(),
  text: z.string().max(2000).optional(),
  nonce: z.string().min(1).max(200),
});

export function registerCallbackGameRoutes(app: FastifyInstance): void {
  app.post('/api/callbacks/submit-game-action', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = submitGameActionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { gameId, round, phase, seat, action, target, text, nonce } = parsed.data;

    // Proxy to existing game action route — reuses all validation + nonce dedup
    // Pass invocation threadId so downstream enforces thread-game isolation (P1 fix)
    const response = await app.inject({
      method: 'POST',
      url: `/api/game/${gameId}/action`,
      headers: {
        'x-cat-id': record.catId,
        'x-cat-cafe-user': record.userId,
        ...(record.threadId ? { 'x-callback-thread-id': record.threadId } : {}),
        'content-type': 'application/json',
      },
      payload: { round, phase, seat, action, target, text, nonce },
    });

    reply.status(response.statusCode);
    return response.json();
  });
}
