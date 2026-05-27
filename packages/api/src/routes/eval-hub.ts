import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { loadEvalHubSummary } from '../infrastructure/harness-eval/eval-hub-read-model.js';
import { ensureEvalDomainThreads } from '../infrastructure/harness-eval/eval-hub-thread-ensure.js';

export interface EvalHubRoutesOptions {
  harnessFeedbackRoot: string;
  threadStore?: IThreadStore;
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
};
