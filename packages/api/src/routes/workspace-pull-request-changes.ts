import { decodePullRequestChangesTarget } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  type PullRequestChangesDependencies,
  PullRequestChangesReadError,
  readPullRequestChanges,
} from '../domains/workspace/pull-request-changes.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';

export function registerWorkspacePullRequestChangesRoutes(
  app: FastifyInstance,
  resolveUserId: (request: FastifyRequest) => string | null,
  dependencies?: PullRequestChangesDependencies,
): void {
  app.get<{ Querystring: { target?: string } }>('/api/workspace/pull-request-changes', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!workspaceDirectHuman(request, resolveUserId))
      return reply.status(401).send({ error: { code: 'identity_required' } });
    const target =
      typeof request.query.target === 'string' ? decodePullRequestChangesTarget(request.query.target) : null;
    if (!target) return reply.status(400).send({ error: { code: 'invalid_target' } });
    try {
      return await readPullRequestChanges(target, dependencies);
    } catch (error) {
      if (error instanceof PullRequestChangesReadError)
        return reply.status(error.statusCode).send({ error: { code: error.code } });
      return reply.status(503).send({ error: { code: 'unavailable' } });
    }
  });
}
