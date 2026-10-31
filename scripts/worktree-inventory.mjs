#!/usr/bin/env node
/** Read-only lifecycle receipts across every Git-registered linked path. */
import { fileURLToPath } from 'node:url';
import { associatedWorktrees, worktreeInventory } from './lib/worktree-inventory.mjs';
import { mergedWorktreeNotices, releasedWorktreeNotices } from './lib/worktree-merged-notices.mjs';
import { readPrTruth } from './lib/worktree-pr.mjs';
import { mainRepoFrom } from './worktree-reaper.mjs';

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--notices') options.notices = true;
    else if (argv[i] === '--merged') options.merged = true;
    else if (['--repo', '--pr'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--'))
      options[argv[i].slice(2)] = argv[++i];
    else throw new Error('usage: worktree-inventory [--repo path] [--pr pr:owner/repository#number | --notices]');
  }
  return options;
}

export function inventoryCommand(argv, readPr = readPrTruth) {
  const options = parseOptions(argv);
  const repo = mainRepoFrom(options.repo ?? process.cwd());
  if (options.pr && options.notices) throw new Error('choose PR receipt or notices');
  if (options.pr) {
    const truth = readPr(options.pr);
    const associated = associatedWorktrees({
      repo,
      sourceRef: options.pr,
      commits: [...truth.commits, truth.mergedAt].filter(Boolean),
    });
    const worktrees = associated.map((row) => ({
      ...row,
      disposition:
        row.retentionStatus === 'retained-until' && row.lifecycle.retention.sourceRef === options.pr
          ? 'retained'
          : 'owner-finish-required',
    }));
    return {
      version: 1,
      repo,
      pr: truth,
      worktrees,
      unresolved: worktrees.filter((row) => row.disposition !== 'retained').length,
    };
  }
  const worktrees = worktreeInventory(repo);
  if (options.merged && !options.notices) throw new Error('merged sweep requires --notices');
  const merged = options.merged ? mergedWorktreeNotices(repo, worktrees) : { notices: [], unknown: [] };
  const mergedPaths = new Set(merged.notices.map((notice) => notice.path));
  return options.notices
    ? {
        version: 1,
        repo,
        notices: [
          ...worktrees.flatMap((row) => (row.notice && !mergedPaths.has(row.path) ? [row.notice] : [])),
          ...merged.notices,
          ...(options.merged ? releasedWorktreeNotices(repo, worktrees) : []),
        ],
        unknownPrQueries: merged.unknown,
        unroutable: worktrees
          .filter((row) => row.retentionStatus && row.retentionStatus !== 'retained-until' && !row.notice)
          .map((row) => ({ path: row.path, reason: 'missing-or-invalid-origin' })),
      }
    : { version: 1, repo, worktrees };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(inventoryCommand(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
