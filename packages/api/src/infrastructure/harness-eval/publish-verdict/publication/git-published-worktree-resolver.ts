import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { promisify } from 'node:util';

import { withHiddenGhCliWindow } from '../../../github/gh-cli-env.js';
import type { ResolvePublishedOnIsolatedWorktreeOpts } from '../types.js';
import { withGitHubRepoScope } from './git-verdict-pr.js';
import type { VerdictPublishContractInput, VerdictPublishContractRunner } from './verdict-publish-contract-runner.js';

const exec = promisify(execFile);
const FULL_SHA = /^[a-f0-9]{40}$/;

interface ExistingPublication {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headRefOid: string;
  baseRefOid: string;
  baseRefName: string;
}

function exactPaths(paths: string[]): string[] {
  const normalized = paths.map((path) => {
    if (!path || posix.isAbsolute(path) || posix.normalize(path) !== path || path.startsWith('../')) {
      throw new Error(`existing publication expected an unsafe artifact path: ${path}`);
    }
    return path;
  });
  if (normalized.length === 0 || new Set(normalized).size !== normalized.length) {
    throw new Error('existing publication expected paths must be non-empty and unique');
  }
  return normalized.sort();
}

function parsePublication(raw: string): ExistingPublication | undefined {
  const parsed = JSON.parse(raw) as ExistingPublication[];
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  if (parsed.length !== 1) throw new Error('existing publication branch maps to multiple pull requests');
  const publication = parsed[0];
  if (!publication) return undefined;
  if (
    !Number.isInteger(publication.number) ||
    !publication.url ||
    !FULL_SHA.test(publication.headRefOid) ||
    !FULL_SHA.test(publication.baseRefOid) ||
    publication.baseRefName !== 'main' ||
    !['OPEN', 'MERGED', 'CLOSED'].includes(publication.state)
  ) {
    throw new Error('existing publication pull request has an invalid identity');
  }
  if (publication.state === 'CLOSED') throw new Error('existing publication pull request was closed without merge');
  return publication;
}

async function fetchPublicationCommit(repoRoot: string, branchName: string, publication: ExistingPublication) {
  let fetchedBranch = false;
  try {
    await exec(
      'git',
      ['-C', repoRoot, 'fetch', 'origin', `refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
      { timeout: 60_000 },
    );
    fetchedBranch = true;
  } catch (error) {
    if (publication.state !== 'MERGED') throw error;
    await exec('git', ['-C', repoRoot, 'fetch', 'origin', `refs/pull/${publication.number}/head`], { timeout: 60_000 });
  }
  if (fetchedBranch) {
    const branch = await exec('git', ['-C', repoRoot, 'rev-parse', `refs/remotes/origin/${branchName}^{commit}`], {
      timeout: 10_000,
    });
    if (branch.stdout.trim() !== publication.headRefOid) {
      throw new Error('existing publication remote branch does not match its pull request head');
    }
  }
  await exec('git', ['-C', repoRoot, 'cat-file', '-e', `${publication.headRefOid}^{commit}`], { timeout: 10_000 });
}

export function createGitPublishedWorktreeResolver(input: {
  repoRoot: string;
  expectedRepoFullName: string;
  contractRunner: VerdictPublishContractRunner;
}) {
  return async function resolvePublishedOnIsolatedWorktree(
    options: ResolvePublishedOnIsolatedWorktreeOpts,
  ): Promise<{ commitSha: string; prUrl: string } | undefined> {
    await exec('git', ['check-ref-format', '--branch', options.branchName], { timeout: 10_000 });
    if (!options.sourceMessageId || /[\r\n]/.test(options.sourceMessageId)) {
      throw new Error('existing publication source message id is invalid');
    }
    const expectedPaths = exactPaths(options.expectedPaths);
    const sourceContract = {
      repoRoot: input.repoRoot,
      implementationRoot: input.repoRoot,
      expectedRepoFullName: input.expectedRepoFullName,
      remoteName: 'origin',
      baseRef: 'origin/main',
      sourceRef: 'origin/main',
    } satisfies VerdictPublishContractInput;
    await input.contractRunner({ ...sourceContract, identityOnly: true });
    await exec('git', ['-C', input.repoRoot, 'fetch', 'origin', 'main'], { timeout: 60_000 });

    const probe = await exec(
      'gh',
      withGitHubRepoScope(
        [
          'pr',
          'list',
          '--head',
          options.branchName,
          '--state',
          'all',
          '--json',
          'number,url,state,headRefOid,baseRefOid,baseRefName',
          '--limit',
          '2',
        ],
        input.expectedRepoFullName,
      ),
      withHiddenGhCliWindow({ cwd: input.repoRoot, timeout: 30_000 }),
    );
    const publication = parsePublication(probe.stdout);
    if (!publication) return undefined;
    await fetchPublicationCommit(input.repoRoot, options.branchName, publication);

    await exec('git', ['-C', input.repoRoot, 'merge-base', '--is-ancestor', publication.baseRefOid, 'origin/main'], {
      timeout: 10_000,
    });
    const parent = await exec('git', ['-C', input.repoRoot, 'rev-parse', `${publication.headRefOid}^`], {
      timeout: 10_000,
    });
    if (parent.stdout.trim() !== publication.baseRefOid) {
      throw new Error('existing publication is not one commit on its recorded main base');
    }
    const message = await exec('git', ['-C', input.repoRoot, 'show', '-s', '--format=%B', publication.headRefOid], {
      timeout: 10_000,
    });
    const trailer = `Source-Message: ${options.sourceMessageId}`;
    const sourceMessageTrailers = message.stdout.split(/\r?\n/).filter((line) => /^Source-Message:/.test(line));
    if (sourceMessageTrailers.length !== 1 || sourceMessageTrailers[0] !== trailer) {
      throw new Error('existing publication source message trailer mismatch');
    }
    const changed = await exec(
      'git',
      ['-C', input.repoRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', publication.headRefOid],
      { timeout: 10_000 },
    );
    const actualPaths = changed.stdout.split(/\r?\n/).filter(Boolean).sort();
    if (
      actualPaths.length !== expectedPaths.length ||
      actualPaths.some((path, index) => path !== expectedPaths[index])
    ) {
      throw new Error('existing publication changed paths do not match the exact artifact set');
    }

    const worktreeRoot = mkdtempSync(`${tmpdir()}/cat-cafe-resolve-publication-`);
    rmSync(worktreeRoot, { recursive: true, force: true });
    try {
      await exec('git', ['-C', input.repoRoot, 'worktree', 'add', '--detach', worktreeRoot, publication.headRefOid], {
        timeout: 60_000,
      });
      await input.contractRunner({
        ...sourceContract,
        repoRoot: worktreeRoot,
        baseRef: publication.baseRefOid,
        sourceRef: publication.headRefOid,
      });
      await options.validate(worktreeRoot);
      return { commitSha: publication.headRefOid, prUrl: publication.url };
    } finally {
      try {
        await exec('git', ['-C', input.repoRoot, 'worktree', 'remove', '--force', worktreeRoot], { timeout: 30_000 });
      } catch {
        // Worktree may not have registered.
      }
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  };
}
