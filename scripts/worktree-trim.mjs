#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { trimWorktree } from './lib/worktree-trim.mjs';
import { mainRepoFrom } from './worktree-reaper.mjs';

export { trimWorktree };

function argumentsFor(argv) {
  const path = argv[0];
  if (!path || path.startsWith('--'))
    throw new Error('usage: worktree-trim <path> --source-ref <task/pr/message> [--owner <catId>]');
  const opts = { path, owner: process.env.CAT_CAFE_CAT_ID };
  const keys = { '--owner': 'owner', '--source-ref': 'sourceRef' };
  for (let i = 1; i < argv.length; i += 2) {
    if (!keys[argv[i]] || !argv[i + 1] || argv[i + 1].startsWith('--'))
      throw new Error(`invalid flag/value: ${argv[i]}`);
    opts[keys[argv[i]]] = argv[i + 1];
  }
  if (process.env.CAT_CAFE_CAT_ID && opts.owner !== process.env.CAT_CAFE_CAT_ID)
    throw new Error('owner differs from runtime identity');
  return opts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(trimWorktree({ ...argumentsFor(process.argv.slice(2)), repo: mainRepoFrom(process.cwd()) })),
    );
  } catch (error) {
    console.error(
      JSON.stringify({ state: 'blocked', reason: error.message, ...(error.receipt ? { receipt: error.receipt } : {}) }),
    );
    process.exitCode = 1;
  }
}
