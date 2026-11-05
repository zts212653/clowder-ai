import { chatReferenceBatchSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { createChatGitHubReader } from '../domains/workspace/chat-github-references.js';
import { readChatReference } from '../domains/workspace/chat-reference-reader.js';
import { listWorkspaceRootEntries } from '../domains/workspace/workspace-security.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';

/** One batch spans messages/threads; project paths are resolved from the authenticated thread store. */
export function registerWorkspaceChatReferences(
  app: FastifyInstance,
  user: (request: FastifyRequest) => string | null,
  threads?: Pick<IThreadStore, 'get'>,
) {
  const github = createChatGitHubReader();
  app.post('/api/workspace/chat-references', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const userId = workspaceDirectHuman(request, user);
    if (!userId) return reply.code(401).send({ error: 'identity_required' });
    const parsed = chatReferenceBatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_reference_batch' });
    let entries: Awaited<ReturnType<typeof listWorkspaceRootEntries>>;
    try {
      entries = await listWorkspaceRootEntries();
    } catch {
      return reply.code(503).send({ error: 'workspace_unavailable' });
    }
    const groups = [];
    for (const group of parsed.data.groups) {
      const thread = await threads?.get(group.threadId);
      const readable = thread?.createdBy === userId;
      const results: Awaited<ReturnType<typeof readChatReference>>[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, group.references.length) }, async () => {
          while (next < group.references.length) {
            const index = next++;
            results[index] = readable
              ? await readChatReference(group.references[index], thread.projectPath, entries, github).catch(() => null)
              : null;
          }
        }),
      );
      groups.push({
        threadId: group.threadId,
        results: group.references.map((reference, index) => ({ reference, target: results[index] })),
      });
    }
    return { groups };
  });
}
