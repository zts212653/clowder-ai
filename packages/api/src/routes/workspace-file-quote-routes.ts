import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type WorkspaceFileQuoteDependencies,
  WorkspaceFileQuoteProjection,
} from '../domains/collaborative-content/workspace-review/file-quote-projection.js';
import { directContentHuman } from './content-modification-routes.js';
import { replyWorkspaceContentReviewError } from './workspace-content-review-error.js';

const query = z
  .object({
    worktreeId: z.string().trim().min(1).max(256),
    path: z.string().trim().min(1).max(2048),
    expectedSourceRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    before: z
      .string()
      .max(300)
      .regex(/^\d+:.+$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export function registerWorkspaceFileQuoteRoutes(app: FastifyInstance, deps: WorkspaceFileQuoteDependencies) {
  const quotes = new WorkspaceFileQuoteProjection(deps);
  app.get('/api/workspace/file-quotes', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const principal = directContentHuman(request);
    if (!principal) return reply.code(401).send({ error: { code: 'identity_required' } });
    try {
      const input = query.parse(request.query);
      const split = input.before?.indexOf(':');
      const before =
        input.before && split !== undefined
          ? {
              timestamp: z
                .number()
                .int()
                .nonnegative()
                .safe()
                .parse(Number(input.before.slice(0, split))),
              messageId: z
                .string()
                .min(1)
                .max(256)
                .parse(input.before.slice(split + 1)),
            }
          : undefined;
      return await quotes.read(
        {
          locator: { worktreeId: input.worktreeId, path: input.path },
          expectedSourceRevision: input.expectedSourceRevision,
          limit: input.limit,
          ...(before ? { before } : {}),
        },
        principal,
      );
    } catch (error) {
      return replyWorkspaceContentReviewError(reply, error);
    }
  });
}
