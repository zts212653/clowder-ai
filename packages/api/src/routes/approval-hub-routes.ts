/**
 * F246: Approval Hub aggregation routes.
 *
 * GET /api/approval-hub/pending — query all registered adapters for pending
 * proposals, merge + sort by createdAt desc, return unified ApprovalItem[].
 *
 * GET /api/approval-hub/settled — query all adapters that implement listSettled,
 * merge + sort by decidedAt desc, return SettledApprovalItem[].
 * F246 Phase F: Approval history view (AC-F5).
 *
 * No side effects. No cache. Fresh read-through every call (KD-3 v1).
 */

import { performance } from 'node:perf_hooks';
import type { ApprovalProducerId } from '@cat-cafe/shared';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { ApprovalProducerRegistry } from '../domains/approval-hub/ApprovalProducerRegistry.js';
import { resolveUserId } from '../utils/request-identity.js';

const MAX_SETTLED_LIMIT = 200;
const DEFAULT_SETTLED_LIMIT = 50;

export interface ApprovalHubRoutesOptions {
  registry: ApprovalProducerRegistry;
}

type ApprovalHubQuery = 'pending' | 'settled';

interface MeasuredAdapterCall<T> {
  producerId: ApprovalProducerId;
  run: () => T[] | Promise<T[]>;
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}

async function measuredFanOut<T>(
  log: FastifyBaseLogger,
  query: ApprovalHubQuery,
  calls: Array<MeasuredAdapterCall<T>>,
): Promise<T[]> {
  const totalStartedAt = performance.now();
  const outcomes = await Promise.all(
    calls.map(async ({ producerId, run }) => {
      const adapterStartedAt = performance.now();
      try {
        const items = await run();
        log.info(
          {
            feature: 'F246',
            measurement: 'approval_hub_fanout',
            query,
            scope: 'adapter',
            producerId,
            durationMs: elapsedMs(adapterStartedAt),
            itemCount: items.length,
            outcome: 'success',
          },
          '[F246] approval hub adapter query completed',
        );
        return { ok: true as const, items };
      } catch (err) {
        log.error(
          {
            err,
            feature: 'F246',
            measurement: 'approval_hub_fanout',
            query,
            scope: 'adapter',
            producerId,
            durationMs: elapsedMs(adapterStartedAt),
            itemCount: 0,
            outcome: 'error',
          },
          '[F246] approval hub adapter query failed',
        );
        return { ok: false as const, error: err };
      }
    }),
  );

  const items = outcomes.flatMap((outcome) => (outcome.ok ? outcome.items : []));
  const failure = outcomes.find((outcome) => !outcome.ok);
  log[failure ? 'error' : 'info'](
    {
      ...(failure && !failure.ok ? { err: failure.error } : {}),
      feature: 'F246',
      measurement: 'approval_hub_fanout',
      query,
      scope: 'total',
      producerId: 'all',
      durationMs: elapsedMs(totalStartedAt),
      itemCount: items.length,
      outcome: failure ? 'error' : 'success',
    },
    failure ? '[F246] approval hub fan-out failed closed' : '[F246] approval hub fan-out completed',
  );
  if (failure && !failure.ok) throw failure.error;
  return items;
}

export const approvalHubRoutes: FastifyPluginAsync<ApprovalHubRoutesOptions> = async (app, opts) => {
  const { registry } = opts;

  app.get('/api/approval-hub/pending', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const items = (
      await measuredFanOut(
        request.log,
        'pending',
        registry.listAdapters().map((adapter) => ({
          producerId: adapter.featureId,
          run: () => adapter.listPending(userId),
        })),
      )
    ).sort((a, b) => b.createdAt - a.createdAt);

    return { items, count: items.length, manifest: registry.manifest() };
  });

  // F246 Phase F: approval history
  app.get('/api/approval-hub/settled', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const query = request.query as Record<string, string>;
    // Cloud P2 fix: floor() before fan-out — non-integer limits sent to Redis ZREVRANGE fail with 500.
    const parsedLimit = Math.floor(Number(query.limit ?? DEFAULT_SETTLED_LIMIT));
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_SETTLED_LIMIT)
        : DEFAULT_SETTLED_LIMIT;

    // Only fan-out to adapters that implement listSettled (AC-F2: optional method)
    const capableAdapters = registry.listAdapters().filter((adapter) => typeof adapter.listSettled === 'function');
    const items = (
      await measuredFanOut(
        request.log,
        'settled',
        capableAdapters.map((adapter) => ({
          producerId: adapter.featureId,
          run: () => {
            const { listSettled } = adapter;
            if (!listSettled) throw new Error(`Approval adapter ${adapter.featureId} lost settled capability`);
            return listSettled.call(adapter, userId, { limit });
          },
        })),
      )
    )
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .slice(0, limit);

    return { items, count: items.length, manifest: registry.manifest() };
  });
};
