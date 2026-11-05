#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { materializeAssets, worktreeRoot } from './lib/worktree-light.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg.startsWith('--') && arg !== '--all') || (args.includes('--all') && args.length !== 1))
      throw new Error('usage: worktree-assets [<repo-relative path> ... | --all]');
    console.log(
      JSON.stringify(
        materializeAssets(
          worktreeRoot(process.cwd()),
          args.filter((arg) => arg !== '--all'),
          { all: args.includes('--all') },
        ),
      ),
    );
  } catch (error) {
    console.error(JSON.stringify({ state: 'blocked', reason: error.message }));
    process.exitCode = 1;
  }
}
