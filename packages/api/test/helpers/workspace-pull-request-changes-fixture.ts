import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { EventAuditLog } from '../../src/domains/cats/services/orchestration/EventAuditLog.js';
import { WorkspaceSecurityError } from '../../src/domains/workspace/workspace-security.js';
import { executeGitHubProcess } from '../../src/infrastructure/github/gh-process.js';
import { workspaceRoutes } from '../../src/routes/workspace.js';

export const baseSha = 'a'.repeat(40);
export const headSha = 'b'.repeat(40);
export const mergeBaseSha = 'c'.repeat(40);
export const targetKey = encodeURIComponent(
  JSON.stringify(['github-pr', 1, 'owner/repo', 7, 'registered-root', 'thread-host']),
);
export const metadata = () => ({
  number: 7,
  changed_files: 1,
  base: { sha: baseSha, repo: { full_name: 'owner/repo' } },
  head: { sha: headSha, repo: { full_name: 'fork/repo' } },
});
export const file = (filename = 'src/main.ts', extra = {}) => ({
  filename,
  status: 'modified',
  patch: '@@ -1 +1 @@\n-local\n+pull-request',
  ...extra,
});
export const comparison = (files = [file()]) => ({
  base_commit: { sha: baseSha },
  merge_base_commit: { sha: mergeBaseSha },
  files,
});

export async function fixture(
  options: {
    remote?: string;
    pull?: unknown;
    compare?: unknown;
    failure?: Error;
    missingRoot?: boolean;
    boundedComparison?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-pr-changes-'));
  const comparisonFile = join(dir, 'comparison.json');
  if (options.boundedComparison) await writeFile(comparisonFile, JSON.stringify(options.compare ?? comparison()));
  const calls: { command: string; args: string[] }[] = [];
  const app = Fastify();
  await app.register(workspaceRoutes, {
    auditLog: new EventAuditLog({ auditDir: join(dir, 'audit') }),
    pullRequestChangesDependencies: {
      resolveRoot: async (id: string) => {
        if (options.missingRoot || id !== 'registered-root') throw new WorkspaceSecurityError('missing', 'NOT_FOUND');
        return dir;
      },
      execute: async (command, args, processOptions) => {
        calls.push({ command, args });
        if (command === 'git') {
          assert.deepEqual(args, ['-C', dir, 'remote', 'get-url', 'origin']);
          return { stdout: options.remote ?? 'git@github.com:Owner/Repo.git\n' };
        }
        assert.equal(command, 'gh');
        assert.equal(args[0], 'api');
        if (options.failure) throw options.failure;
        if (args[1] === 'repos/owner/repo/pulls/7') return { stdout: JSON.stringify(options.pull ?? metadata()) };
        assert.equal(args[1], `repos/owner/repo/compare/${baseSha}...${headSha}?per_page=100&page=1`);
        if (options.boundedComparison)
          return executeGitHubProcess(
            process.execPath,
            ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', comparisonFile],
            processOptions,
          );
        return { stdout: JSON.stringify(options.compare ?? comparison()) };
      },
    },
  });
  return {
    calls,
    read: (headers: Record<string, string> = { 'x-cat-cafe-user': 'operator' }, key = targetKey) =>
      app.inject({
        method: 'GET',
        url: `/api/workspace/pull-request-changes?${new URLSearchParams({ target: key })}`,
        headers,
      }),
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
