#!/usr/bin/env node
/** The existing lifecycle sweep may finish a verified merged checkout; it never impersonates its owner. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasedNoticeKey } from './lib/worktree-merged-notices.mjs';
import { validateOrigin } from './lib/worktree-origin.mjs';
import { parsePrSource, readPrTruth } from './lib/worktree-pr.mjs';
import { isAncestor, lifecycleConfig, safeRealpath } from './lib/worktree-reaper-probes.mjs';
import { automaticReleasePaused, reconcileAutomaticReleases } from './lib/worktree-release-transactions.mjs';
import { retentionStatus } from './lib/worktree-retention.mjs';
import { finishWorktree } from './worktree-finish.mjs';
import { mainRepoFrom } from './worktree-reaper.mjs';

export function retireMergedWorktree({ repo, path, head, sourceRef, threadId, userId, owner, ...probes }) {
  if (!/^[0-9a-f]{40,64}$/.test(head ?? '')) throw new Error('exact expected HEAD required');
  const { repository } = parsePrSource(sourceRef);
  const identity = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (identity !== repository) throw new Error('PR does not belong to the checkout repository');
  path = safeRealpath(resolve(path));
  if (automaticReleasePaused(repo, path, head))
    throw new Error('automatic release paused after an interrupted or failed attempt; owner finish required');
  const lifecycle = lifecycleConfig(path, '--worktree');
  const releaseGuard = (entry) => {
    const origin = entry.lifecycle.origin;
    validateOrigin(origin);
    if (!origin || origin.threadId !== threadId || origin.userId !== userId || entry.lifecycle.owner !== owner)
      throw new Error('automatic release origin changed');
    if (origin.role === 'alpha') throw new Error('Alpha requires explicit owner finish');
    const retention = retentionStatus(entry.lifecycle, probes.now);
    if (retention && (retention !== 'retention-expired' || entry.lifecycle.retention.head !== entry.head))
      throw new Error(`automatic release protected: ${retention}`);
  };
  const receipt = finishWorktree({
    ...probes,
    repo,
    path,
    owner,
    sourceRef: lifecycle?.retention?.sourceRef ?? sourceRef,
    mergedPr: sourceRef,
    expectedHead: head,
    actor: 'worktree-lifecycle',
    authorizationRef: sourceRef,
    releaseGuard,
    readPr: (ref) => {
      const truth = (probes.readPr ?? readPrTruth)(ref);
      if (
        truth.state === 'MERGED' &&
        truth.sourceRef === ref &&
        truth.commits?.includes(head) &&
        isAncestor(repo, truth.mergedAt, 'origin/main') !== true
      ) {
        execFileSync(
          'git',
          [
            '-c',
            'maintenance.auto=false',
            '-c',
            'gc.auto=0',
            '-C',
            repo,
            'fetch',
            '--no-tags',
            '--recurse-submodules=no',
            'origin',
            'main',
          ],
          {
            timeout: 30000,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          },
        );
      }
      return truth;
    },
  });
  return {
    ...receipt,
    key: releasedNoticeKey(repo, {
      from: path,
      head,
      owner,
      mergedPr: sourceRef,
      mergedAt: receipt.mergedAt,
      archivePath: receipt.archivePath,
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--reconcile' && process.argv.length === 4) {
      console.log(JSON.stringify(reconcileAutomaticReleases(mainRepoFrom(process.argv[3]))));
    } else {
      const [repoPath, path, head, sourceRef, threadId, userId, owner, ...extra] = process.argv.slice(2);
      if (!repoPath || !path || extra.length)
        throw new Error('usage: worktree-retire-merged repo path head pr thread user owner');
      console.log(
        JSON.stringify(
          retireMergedWorktree({ repo: mainRepoFrom(repoPath), path, head, sourceRef, threadId, userId, owner }),
        ),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
