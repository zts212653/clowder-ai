import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { getRoster } from '../config/cat-config-loader.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { getEvalCatOverride, setEvalCatOverride } from '../infrastructure/harness-eval/domain/eval-domain-override.js';
import { loadDomains, loadEvalHubSummary } from '../infrastructure/harness-eval/hub/eval-hub-read-model.js';
import { ensureEvalDomainThreads } from '../infrastructure/harness-eval/hub/eval-hub-thread-ensure.js';

export interface EvalHubRoutesOptions {
  harnessFeedbackRoot: string;
  threadStore?: IThreadStore;
  redis?: Redis;
}

function requireSession(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

export const evalHubRoutes: FastifyPluginAsync<EvalHubRoutesOptions> = async (app, opts) => {
  app.get('/api/eval-hub/summary', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    try {
      const summary = loadEvalHubSummary({ harnessFeedbackRoot: opts.harnessFeedbackRoot });

      // OQ-20: Apply Redis evalCat overrides to domain summaries
      if (opts.redis) {
        for (const domain of summary.domains) {
          const override = await getEvalCatOverride(opts.redis, domain.domainId);
          if (override) {
            domain.evalCatId = override.catId;
            domain.evalCatHandle = override.handle;
          }
        }
      }

      // F192 livefix: Ensure domain system threads exist for ALL registered domains,
      // not just those with verdicts. This makes eval:memory threads visible before first eval.
      // Best-effort: thread store failures must not block the read-only summary response.
      // Cloud P1: pass userId so threads are indexed into user's sidebar list.
      if (opts.threadStore) {
        try {
          const allDomains = summary.domains.map((d) => ({
            domainId: d.domainId,
            systemThreadId: d.systemThreadId,
            displayName: d.displayName,
          }));
          await ensureEvalDomainThreads(opts.threadStore, allDomains, userId);
        } catch (threadErr) {
          request.log.warn({ err: threadErr }, 'eval-hub: thread ensure failed (best-effort, continuing)');
        }
      }

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Eval Hub summary unavailable', detail: message });
    }
  });

  // OQ-20: List available cats for the eval cat selector (P1-1 fix: roster-backed)
  app.get('/api/eval-hub/available-cats', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    const roster = getRoster();
    const cats = Object.entries(roster)
      .filter(([, entry]) => entry.available !== false)
      .map(([catId, entry]) => ({
        catId,
        handle: `@${catId}`,
        family: entry.family,
      }));
    return { cats };
  });

  // OQ-20: Edit eval cat assignment per domain (P1-1 fix: validates against roster)
  app.patch('/api/eval-domains/:domainId/eval-cat', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    if (!opts.redis) {
      return reply.status(503).send({ error: 'Redis not available for eval domain overrides' });
    }

    const { domainId } = request.params as { domainId: string };
    const body = request.body as { catId?: string } | null;
    if (!body?.catId) {
      return reply.status(400).send({ error: 'catId is required' });
    }

    // R2 P2 + R3 P2: validate domainId via registry-only lookup (not summary —
    // summary reads verdict bundles and would fail-closed on unrelated bundle corruption)
    const registeredDomains = loadDomains(opts.harnessFeedbackRoot);
    if (!registeredDomains.has(domainId as Parameters<typeof registeredDomains.has>[0])) {
      return reply.status(400).send({
        error: `Domain '${domainId}' not found in eval domain registry`,
      });
    }

    // P1-1 fix: validate catId exists in current roster
    const roster = getRoster();
    const rosterEntry = roster[body.catId];
    if (!rosterEntry) {
      const available = Object.keys(roster).join(', ');
      return reply.status(400).send({
        error: `Cat '${body.catId}' not found in roster. Available: ${available}`,
      });
    }

    // R2 P1: reject unavailable cats
    if (rosterEntry.available === false) {
      return reply.status(400).send({
        error: `Cat '${body.catId}' is not available (available=false in roster)`,
      });
    }

    const override = await setEvalCatOverride(opts.redis, domainId, {
      catId: body.catId,
      handle: `@${body.catId}`,
      model: rosterEntry.family,
    });

    return { ok: true, domainId, evalCat: override };
  });
};
