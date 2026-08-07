/** F264: persisted author message-disposition preferences. */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  resolveMessageDispositionPreference,
  saveMessageDispositionPreference,
} from '../config/user-preferences-store.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface MessageDispositionRoutesOptions {
  projectRoot: string;
}

const dispositionSchema = z.enum(['continue_current', 'next_work']);
const querySchema = z.object({ threadId: z.string().min(1).optional() });
const putSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global'), disposition: dispositionSchema.nullable() }),
  z.object({ scope: z.literal('thread'), threadId: z.string().min(1), disposition: dispositionSchema.nullable() }),
  z.object({ scope: z.literal('onboarding'), seen: z.literal(true) }),
]);

export async function configMessageDispositionRoutes(
  app: FastifyInstance,
  opts: MessageDispositionRoutesOptions,
): Promise<void> {
  app.get('/api/config/message-disposition', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    return resolveMessageDispositionPreference(opts.projectRoot, parsed.data.threadId);
  });

  app.put('/api/config/message-disposition', async (request: FastifyRequest, reply: FastifyReply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const gateResult = resolveOwnerGate(operator, {
      errorMessage: 'Only the owner can change message disposition preferences',
    });
    if (gateResult) {
      reply.status(gateResult.status);
      return { error: gateResult.error };
    }
    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    return saveMessageDispositionPreference(opts.projectRoot, parsed.data);
  });
}
