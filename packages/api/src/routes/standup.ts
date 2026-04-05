/**
 * Standup Routes — Q12 Bootcamp
 * GET /api/standup/today — 当日猫咖团队站会摘要
 *
 * Auth: requires X-Cat-Cafe-User identity header.
 * Data is scoped to the requesting user's invocations.
 */

import type { FastifyPluginAsync } from 'fastify';
import { aggregateStandup } from '../domains/cats/services/standup-aggregator.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface StandupRoutesOptions {
  invocationRecordStore: IInvocationRecordStore;
}

export const standupRoutes: FastifyPluginAsync<StandupRoutesOptions> = async (app, opts) => {
  app.get('/api/standup/today', async (request, reply) => {
    const store = opts.invocationRecordStore;

    if (typeof store.scanAll !== 'function') {
      return reply.status(501).send({
        error: 'Standup requires Redis-backed invocation store (scanAll not available)',
      });
    }

    const userId = resolveHeaderUserId(request);
    if (!userId) {
      return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });
    }

    const allRecords = await store.scanAll();
    const userRecords = allRecords.filter((r) => r.userId === userId);
    const report = aggregateStandup(userRecords);

    return report;
  });
};
