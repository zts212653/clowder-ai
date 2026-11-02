import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { decodePullRequestChangesTarget } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  type PullRequestChangesDependencies,
  PullRequestChangesReadError,
  readPullRequestChanges,
} from '../domains/workspace/pull-request-changes.js';
import { getWorktreeRoot, isDenylisted } from '../domains/workspace/workspace-security.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';

const exec = promisify(execFile);

/** Explicit links are authenticated reads through the existing diff viewer, including remote PRs without a local clone. */
export function registerChatChanges(
  app: FastifyInstance,
  user: (request: FastifyRequest) => string | null,
  threads?: Pick<IThreadStore, 'get'>,
  dependencies: PullRequestChangesDependencies = {},
) {
  async function owned(request: FastifyRequest, threadId: string | null | undefined) {
    const id = workspaceDirectHuman(request, user);
    return id && threadId && (await threads?.get(threadId))?.createdBy === id;
  }
  app.get<{ Querystring: { target?: string } }>('/api/workspace/chat-pull-request-changes', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const target =
      typeof request.query.target === 'string' ? decodePullRequestChangesTarget(request.query.target) : null;
    if (!target) return reply.code(400).send({ error: { code: 'invalid_target' } });
    if (!(await owned(request, target.threadId))) return reply.code(403).send({ error: { code: 'permission_denied' } });
    try {
      return await readPullRequestChanges(target, { ...dependencies, allowForeignRepository: true });
    } catch (error) {
      return reply
        .code(error instanceof PullRequestChangesReadError ? error.statusCode : 503)
        .send({ error: { code: error instanceof PullRequestChangesReadError ? error.code : 'unavailable' } });
    }
  });
  app.get('/api/workspace/chat-commit-changes', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const input = z
      .object({
        threadId: z.string().min(1).max(256),
        worktreeId: z.string().min(1).max(256),
        sha: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .strict()
      .safeParse(request.query);
    if (!input.success) return reply.code(400).send({ error: { code: 'invalid_target' } });
    if (!(await owned(request, input.data.threadId)))
      return reply.code(403).send({ error: { code: 'permission_denied' } });
    try {
      const root = await getWorktreeRoot(input.data.worktreeId),
        sha = input.data.sha;
      const options = { timeout: 5000, maxBuffer: 2 * 1024 * 1024 };
      const top = (await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], options)).stdout.trim();
      // A linked subfolder cannot borrow its parent repository's file history.
      if ((await realpath(top)) !== (await realpath(root)))
        return reply.code(403).send({ error: { code: 'permission_denied' } });
      const result = await exec(
        'git',
        [
          '-C',
          root,
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--no-renames',
          '--first-parent',
          '--name-status',
          '-r',
          '-z',
          sha,
          '--',
        ],
        options,
      );
      const parts = result.stdout.split('\0'),
        changedFiles = [];
      for (let index = 0; index + 1 < parts.length; index += 2)
        if (parts[index + 1] && !isDenylisted(parts[index + 1]))
          changedFiles.push({ path: parts[index + 1], status: parts[index] });
      const paths = changedFiles.map((file) => file.path);
      if (paths.length > 200) return reply.code(413).send({ error: { code: 'unavailable' } });
      const diff = paths.length
        ? (
            await exec(
              'git',
              [
                '--literal-pathspecs',
                '-C',
                root,
                'show',
                '--first-parent',
                '--format=',
                '--no-renames',
                '--no-ext-diff',
                '--no-textconv',
                '--no-color',
                '--unified=3',
                sha,
                '--',
                ...paths,
              ],
              options,
            )
          ).stdout
        : '';
      return { sha, worktreeId: input.data.worktreeId, diff, changedFiles };
    } catch {
      return reply.code(404).send({ error: { code: 'not_found' } });
    }
  });
}
