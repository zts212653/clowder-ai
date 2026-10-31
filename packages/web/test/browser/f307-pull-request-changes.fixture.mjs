import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { WORKTREE_ID, worktreeAliasFor } from './f307-real-surface-fixtures.mjs';

/** Real HTTP handler + admission/filtering/version producer; only git/gh transport is controlled. */
export async function createPullRequestReadFixture() {
  const apiURL = new URL('../../../api/src/routes/workspace-pull-request-changes.ts', import.meta.url).href;
  const [{ default: Fastify }, { registerWorkspacePullRequestChangesRoutes }] = await Promise.all([
    tsImport('fastify', apiURL),
    tsImport(apiURL, import.meta.url),
  ]);
  const dir = await mkdtemp(path.join(tmpdir(), 'f307-native-pr-'));
  const calls = [];
  const app = Fastify();
  let unavailable = false;
  registerWorkspacePullRequestChangesRoutes(
    app,
    (req) => (req.headers['x-cat-cafe-user'] === 'operator' ? 'operator' : null),
    {
      resolveRoot: async (id) => {
        // The host selects the registered UI alias; file admission can return its
        // canonical identity. Both name this one registered root, never a new root.
        assert.equal(worktreeAliasFor(id, [WORKTREE_ID]), WORKTREE_ID);
        return dir;
      },
      execute: async (command, args) => {
        calls.push({ command, args });
        if (command === 'git') {
          assert.deepEqual(args, ['-C', dir, 'remote', 'get-url', 'origin']);
          return { stdout: 'git@github.com:owner/repo.git' };
        }
        assert.equal(command, 'gh');
        assert.equal(args[0], 'api');
        if (unavailable)
          throw Object.assign(new Error('process failed'), { stderr: 'gh: rate limit exceeded (HTTP 429)', code: 1 });
        const baseSha = 'a'.repeat(40);
        if (args[1].includes('/pulls/')) {
          const number = Number(args[1].split('/').at(-1));
          assert.ok([7, 8].includes(number));
          return {
            stdout: JSON.stringify({
              number,
              changed_files: 3,
              base: { sha: baseSha, repo: { full_name: 'owner/repo' } },
              head: { sha: String(number).repeat(40), repo: { full_name: 'fork/repo' } },
            }),
          };
        }
        const match = new RegExp(`^repos/owner/repo/compare/${baseSha}\\.\\.\\.([78]{40})\\?per_page=100&page=1$`).exec(
          args[1],
        );
        assert.ok(match, 'the comparison must use the exact captured PR head');
        const number = match[1][0];
        return {
          stdout: JSON.stringify({
            base_commit: { sha: baseSha },
            merge_base_commit: { sha: 'c'.repeat(40) },
            files: [
              {
                filename: `src/pr-${number}.ts`,
                status: 'modified',
                patch: `@@ -1 +1 @@\n-local-only\n+exact-pr-${number}`,
              },
              { filename: 'src/foo b/bar.ts', status: 'removed', patch: `@@ -1 +0,0 @@\n-space-path-delete-${number}` },
              { filename: 'binary.png', status: 'modified' },
            ],
          }),
        };
      },
    },
  );
  return {
    calls,
    setUnavailable: (next) => {
      unavailable = next;
    },
    read: async (url) => {
      const response = await app.inject({
        method: 'GET',
        url: new URL(url).pathname + new URL(url).search,
        headers: { 'x-cat-cafe-user': 'operator' },
      });
      return { status: response.statusCode, contentType: 'application/json', body: response.body };
    },
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
