import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { WorkspaceHtmlPreviews } from '../domains/workspace/workspace-html-preview.js';
import { WorkspaceSecurityError } from '../domains/workspace/workspace-security.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';

/** The parent authenticates; opaque sandbox assets receive only this directory-scoped read capability. */
export function registerWorkspaceHtmlPreviewRoutes(
  app: FastifyInstance,
  resolveUserId: (request: FastifyRequest) => string | null,
  previews = new WorkspaceHtmlPreviews(),
) {
  app.addHook('onClose', async () => previews.clear());
  const principal = (request: FastifyRequest) => workspaceDirectHuman(request, resolveUserId);
  const failure = (error: unknown) => {
    if (
      (error instanceof WorkspaceSecurityError && error.code === 'NOT_FOUND') ||
      (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    )
      return 404;
    return 403;
  };
  app.post('/api/workspace/html-preview', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const userId = principal(request);
    if (!userId) return reply.code(401).send({ error: 'identity_required' });
    const query = z
      .object({ worktreeId: z.string().min(1).max(256), path: z.string().min(1).max(4096) })
      .strict()
      .safeParse(request.body);
    if (!query.success) return reply.code(400).send({ error: 'invalid_html_target' });
    try {
      return await previews.prepare(userId, query.data.worktreeId, query.data.path, request.assertSessionCurrent);
    } catch (error) {
      return reply.code(failure(error)).send({ error: 'html_preview_unavailable' });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/workspace/html-preview/:id', async (request, reply) => {
    const userId = principal(request);
    if (!userId) return reply.code(401).send({ error: 'identity_required' });
    reply.header('Cache-Control', 'private, no-store');
    return previews.revoke(userId, request.params.id) ? reply.code(204).send() : reply.code(404).send();
  });
  app.get<{ Params: { id: string; '*': string } }>(
    '/api/workspace/html-preview/:id/*',
    {
      // Applied after global security/CORS hooks. A direct navigation to SVG or JS never gains a page principal.
      onSend: async (_request, reply, payload) => {
        reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('Cache-Control', 'private, no-store');
        reply.header('Access-Control-Allow-Origin', 'null');
        reply.removeHeader('Access-Control-Allow-Credentials');
        return payload;
      },
      logLevel: 'silent',
    },
    async (request, reply) => {
      try {
        const asset = await previews.openAsset(request.params.id, request.params['*']);
        reply.type(asset.mime).header('Content-Length', asset.size);
        if (asset.size === 0) {
          await asset.handle.close();
          return reply.send(Buffer.alloc(0));
        }
        return reply.send(asset.handle.createReadStream({ end: asset.size - 1 }));
      } catch (error) {
        return reply.code(failure(error)).send({ error: 'page_asset_unavailable' });
      }
    },
  );
}
