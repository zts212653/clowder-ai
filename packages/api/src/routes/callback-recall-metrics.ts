import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { withRecallMetricsSignal } from './recall-metrics-request.js';

const filter = z.string().min(1).max(128);
const querySchema = z
  .object({
    days: z
      .string()
      .regex(/^\d{1,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(90))
      .default('30'),
    catId: filter.optional(),
    toolName: filter.optional(),
  })
  .strict();

// Project the existing report, never raw queries, candidates or future fields.
const number = z.number().finite();
const reportSchema = z.object({
  period: z.object({ fromMs: number, toMs: number, days: number }),
  filters: z.object({ catId: filter.optional(), toolName: filter.optional() }),
  totalEvents: number,
  core: z.object({ consumedAt3: number, consumedMRR: number, reformulationRate: number, searchAbandonRate: number }),
  extended: z.object({
    readthroughAt3: number,
    firstConsumedRankMedian: number,
    reformulationsBeforeConsumption: number,
    reformulateAfterExposure: number,
    grepFallbackRate: number,
    tokenCostPerHit: number,
    consumedAnchorNotInPoolRate: number,
    shadowConsumedMRR: number.nullable(),
    liveOnShadowSubsetMRR: number.nullable(),
  }),
  graph: z.object({ nonFirstSelectionRate: number, traversalCompletion: number }),
});

/** Invocation-authenticated, installation-wide aggregate; not user-isolated. */
export async function registerCallbackRecallMetrics(app: FastifyInstance): Promise<void> {
  app.get('/api/callbacks/get-recall-metrics', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid recall metrics query' });
    const { days, catId, toolName } = parsed.data;
    const query = new URLSearchParams({ days: String(days) });
    if (catId) query.set('catId', catId);
    if (toolName) query.set('toolName', toolName);

    try {
      // Preserve the canonical route/cache and propagate this caller's disconnect
      // through inject to its private queued/active computation process.
      const response = await withRecallMetricsSignal(request, reply, (signal) =>
        app.inject({
          method: 'GET',
          url: `/api/recall/metrics?${query}`,
          headers: { 'x-cat-cafe-user': record.userId },
          signal,
        }),
      );
      if (response.statusCode !== 200) return reply.code(502).send({ error: 'Recall metrics unavailable' });
      const report = reportSchema.safeParse(response.json());
      if (
        report.success &&
        report.data.period.days === days &&
        report.data.filters.catId === catId &&
        report.data.filters.toolName === toolName
      )
        return report.data;
    } catch {
      /* Do not forward a malformed or non-aggregate canonical response. */
    }
    return reply.code(502).send({ error: 'Invalid recall metrics report' });
  });
}
