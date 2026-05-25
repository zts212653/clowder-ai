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
    if (!requireSession(request, reply)) return;

    try {
      const summary = loadEvalHubSummary({ harnessFeedbackRoot: opts.harnessFeedbackRoot });

      // Ensure domain system threads exist with proper titles (fix: domain thread 404 bug).
      // Best-effort: thread store failures must not block the read-only summary response.
      if (opts.threadStore) {
        try {
          const domains = summary.items.map((item) => ({
            domainId: item.domainId,
            systemThreadId: item.systemWorkspace.threadId,
            displayName: item.systemWorkspace.label,
          }));
          // Deduplicate by threadId (multiple verdicts may share the same domain)
          const uniqueDomains = [...new Map(domains.map((d) => [d.systemThreadId, d])).values()];
          await ensureEvalDomainThreads(opts.threadStore, uniqueDomains);
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
