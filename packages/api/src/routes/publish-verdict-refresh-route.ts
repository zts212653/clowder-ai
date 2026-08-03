import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { GitPublisher } from '../infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { handleRefreshPublishedVerdict } from '../infrastructure/harness-eval/publish-verdict/refresh-published-verdict.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';

export function registerPublishVerdictRefreshRoute(
  app: FastifyInstance,
  opts: { harnessFeedbackRoot: string; gitPublisher?: GitPublisher; redis?: Redis },
): void {
  app.post('/api/eval-domains/:domainId/publish-verdict/refresh', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'invocation' && principal.kind !== 'agent_key') {
      return reply.status(403).send({ error: 'invocation_or_agent_key_principal_required' });
    }

    const { domainId } = request.params as { domainId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = await handleRefreshPublishedVerdict(
      {
        harnessFeedbackRoot: opts.harnessFeedbackRoot,
        gitPublisher: opts.gitPublisher,
        redis: opts.redis,
      },
      {
        domain: domainId,
        catId: principal.catId,
        verdictId: typeof body.verdictId === 'string' ? body.verdictId : '',
        expectedHeadSha: typeof body.expectedHeadSha === 'string' ? body.expectedHeadSha : '',
      },
    );
    if ('error' in result) {
      return reply.status(result.status).send({ error: result.error, detail: result.detail });
    }
    return result;
  });
}
