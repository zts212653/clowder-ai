import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { EditorSessionError } from '../domains/collaborative-content/editor-session-service.js';
import type { NamedCatContentService } from '../domains/collaborative-content/named-cat-content-service.js';
import { SemanticMaterializationError } from '../domains/collaborative-content/patch-service.js';
import { WorkspaceEditorUnavailableError } from '../domains/collaborative-content/workspace-editor-service.js';
import { ContentOwnerNotFoundError } from '../domains/video-studio/content-owner/service.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';
import { resolvePrincipalThread } from './callback-scope-helpers.js';

export interface NamedCatContentHolder {
  current?: NamedCatContentService;
}
const target = z.object({ paragraphId: z.string().min(1).max(128), textQuote: z.string().min(1).max(8192) }).strict();
const common = { contentRef: z.string().min(1).max(1024), threadId: z.string().min(1).max(128).optional() };
const inspectSchema = z
  .object({
    ...common,
    contentRef: common.contentRef.optional(),
    workspace: z
      .object({ worktreeId: z.string().min(1).max(256), path: z.string().min(1).max(2048) })
      .strict()
      .optional(),
    expectedOwnerRevision: z.number().int().positive().optional(),
    cursor: z.number().int().min(0).max(65535).default(0),
    limit: z.number().int().min(1).max(8).default(4),
    maxChars: z.number().int().min(1000).max(12000).default(12000),
  })
  .strict()
  .refine((value) => Boolean(value.contentRef) !== Boolean(value.workspace), 'Provide exactly one document locator');
const editSchema = z
  .object({
    ...common,
    expectedOwnerRevision: z.number().int().positive(),
    operationId: z.string().min(1).max(128),
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('tracked-change'), target, replacement: z.string().max(8192) }).strict(),
      z.object({ kind: z.literal('comment'), target, body: z.string().min(1).max(8192) }).strict(),
    ]),
  })
  .strict();

export function registerCallbackContentEditorRoutes(
  app: FastifyInstance,
  options: {
    readonly holder: NamedCatContentHolder;
    readonly threadStore?: Pick<IThreadStore, 'get' | 'list'>;
  },
) {
  for (const operation of ['inspect', 'edit'] as const) {
    app.post(`/api/callbacks/content-editor/${operation}`, async (request, reply) => {
      const principal = requireCallbackPrincipal(request, reply);
      if (!principal) return;
      const schema = operation === 'inspect' ? inspectSchema : editSchema;
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid content editor request' });
      const scope = await resolvePrincipalThread(principal, parsed.data.threadId, { threadStore: options.threadStore });
      if (!scope.ok) return reply.status(scope.statusCode).send({ error: scope.error });
      if (!options.threadStore) return reply.status(503).send({ error: 'Thread authority unavailable' });
      try {
        const thread = await options.threadStore.get(scope.threadId);
        if (!thread) return reply.status(404).send({ error: 'Thread not found' });
        if (thread.deletedAt) return reply.status(410).send({ error: 'Thread is deleted', code: 'THREAD_DELETED' });
      } catch {
        return reply.status(503).send({ error: 'Thread authority unavailable' });
      }
      const service = options.holder.current;
      if (!service) return reply.status(503).send({ status: 'unavailable', reason: 'PROVIDER_UNAVAILABLE' });
      try {
        // Explicit discriminants retain schema narrowing and exclude caller-supplied actor fields.
        if ('operation' in parsed.data) return await service.edit({ ...parsed.data, principal });
        return await service.inspect({ ...parsed.data, principal });
      } catch (error) {
        if (error instanceof WorkspaceEditorUnavailableError)
          return reply.status(400).send({ error: 'Invalid Workspace document target' });
        if (error instanceof ContentOwnerNotFoundError) return reply.status(404).send({ error: 'Document not found' });
        if (error instanceof SemanticMaterializationError)
          return reply.status(409).send({ status: 'rejected', reason: error.reason });
        if (error instanceof EditorSessionError)
          return reply
            .status(error.code === 'PRINCIPAL_MISMATCH' ? 403 : 409)
            .send({ status: 'unavailable', reason: error.code });
        request.log.warn({ err: error }, 'independent document operation failed');
        return reply.status(503).send({ status: 'unavailable', reason: 'PROVIDER_UNAVAILABLE' });
      }
    });
  }
}
