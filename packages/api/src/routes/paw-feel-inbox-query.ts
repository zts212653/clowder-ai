import { PAW_FEEL_DISPOSITION_STATES, type PawFeelDispositionState } from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PawFeelInboxQuery } from '../infrastructure/harness-eval/paw-feel-disposition/read-model.js';
import { PawFeelInboxQuerySchema } from './paw-feel-disposition-contracts.js';

export function parsePawFeelInboxQuery(request: FastifyRequest, reply: FastifyReply): PawFeelInboxQuery | undefined {
  const parsed = PawFeelInboxQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    reply.status(400).send({ error: 'invalid paw-feel inbox query', details: parsed.error.issues });
    return undefined;
  }
  let states: PawFeelDispositionState[] | undefined;
  if (parsed.data.states) {
    const requested = parsed.data.states.split(',').filter(Boolean);
    const invalid = requested.find(
      (state): state is string => !PAW_FEEL_DISPOSITION_STATES.includes(state as PawFeelDispositionState),
    );
    if (invalid) {
      reply.status(400).send({ error: `invalid paw-feel state: ${invalid}` });
      return undefined;
    }
    states = requested as PawFeelDispositionState[];
  }
  return {
    ...(states ? { states } : {}),
    ...(parsed.data.sourceCatId ? { sourceCatId: parsed.data.sourceCatId } : {}),
    ...(parsed.data.sourceMessageId ? { sourceMessageId: parsed.data.sourceMessageId } : {}),
    ...(parsed.data.overdueOnly ? { overdueOnly: parsed.data.overdueOnly === 'true' } : {}),
    ...(parsed.data.resolution ? { resolution: parsed.data.resolution } : {}),
    ...(parsed.data.issueOverdueOnly ? { issueOverdueOnly: parsed.data.issueOverdueOnly === 'true' } : {}),
    ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
    ...(parsed.data.sort ? { sort: parsed.data.sort } : {}),
  };
}
