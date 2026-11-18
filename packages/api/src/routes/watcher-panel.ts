import { blindWatcherPanelRound, type WatcherPanelRound, type WatcherPanelRoundView } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import type { WatcherPanelLedger } from '../domains/concierge/watcher/panel/watcher-panel-ledger.js';
import { reconcileWatcherPanelRound } from '../domains/concierge/watcher/panel/watcher-panel-outcomes.js';
import { watcherPanelResponses } from '../domains/concierge/watcher/panel/watcher-panel-responses.js';
import { watcherOwner } from './watcher.js';

interface WatcherPanelRouteOptions {
  ledger: WatcherPanelLedger;
  turnExecutionStore: Pick<ITurnExecutionStore, 'listSettled' | 'get'>;
}

const listQuery = z
  .object({
    threadId: z.string().min(1).max(300).optional(),
    since: z.coerce.number().int().nonnegative().optional(),
    until: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    /** Evaluator export: labels only, no member identity, invocation, session or account. */
    blind: z.enum(['1', 'true']).optional(),
  })
  .strict();

/**
 * F335 experiment ledger. Owner session only; cats cannot read who said what. The blind export is what
 * the evaluator receives.
 */
export const watcherPanelRoutes: FastifyPluginAsync<WatcherPanelRouteOptions> = async (app, deps) => {
  const view = async (round: WatcherPanelRound): Promise<WatcherPanelRoundView> => {
    const reconciled = await reconcileWatcherPanelRound(deps.turnExecutionStore, round);
    const responses = await watcherPanelResponses(deps.turnExecutionStore, reconciled);
    return responses ? { ...reconciled, responses } : reconciled;
  };

  app.get('/api/watcher/panel/rounds', async (request, reply) => {
    const userId = watcherOwner(request, reply, false);
    if (!userId) return;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid panel ledger query' });
    const { blind, limit, ...range } = parsed.data;
    const rounds = await Promise.all((await deps.ledger.list({ userId, limit, ...range })).map(view));
    return blind ? { blind: true, rounds: rounds.map(blindWatcherPanelRound) } : { blind: false, rounds };
  });

  app.get('/api/watcher/panel/rounds/:roundId', async (request, reply) => {
    const userId = watcherOwner(request, reply, false);
    if (!userId) return;
    const { roundId } = request.params as { roundId: string };
    const round = await deps.ledger.get(roundId);
    if (!round || round.userId !== userId) return reply.code(404).send({ error: 'Panel round not found' });
    return view(round);
  });
};
