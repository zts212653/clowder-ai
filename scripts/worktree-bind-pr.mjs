#!/usr/bin/env node
/** Link a declared checkout to an exact PR without rewriting its original birth provenance. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrTruth } from './lib/worktree-pr.mjs';
import { git, safeRealpath } from './lib/worktree-reaper-probes.mjs';
import { ownedWorktreeFacts } from './worktree-finish.mjs';
import { mainRepoFrom } from './worktree-reaper.mjs';
export function bindWorktreePr({ repo, path, owner, sourceRef, readPr = readPrTruth }) {
  const entry = ownedWorktreeFacts({ repo: safeRealpath(repo), path: safeRealpath(resolve(path)), owner });
  const truth = readPr(sourceRef);
  if (truth.sourceRef !== sourceRef || !truth.commits.includes(entry.head))
    throw new Error('PR must include the exact checkout HEAD');
  if (entry.lifecycle.prSource && entry.lifecycle.prSource !== sourceRef)
    throw new Error('checkout already belongs to another PR');
  const result = git(entry.path, ['config', '--worktree', 'catcafe.lifecycle.prSource', sourceRef]);
  if (!result.ok) throw new Error('could not bind PR source');
  return { path: entry.path, owner, head: entry.head, sourceRef, origin: entry.lifecycle.origin };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [path, sourceRef, ...rest] = process.argv.slice(2);
    if (rest.length && !(rest.length === 2 && rest[0] === '--owner'))
      throw new Error('usage: worktree-bind-pr path pr:owner/repo#number [--owner catId]');
    const owner = rest[1] ?? process.env.CAT_CAFE_CAT_ID;
    if (process.env.CAT_CAFE_CAT_ID && owner !== process.env.CAT_CAFE_CAT_ID)
      throw new Error('owner differs from runtime identity');
    console.log(JSON.stringify(bindWorktreePr({ repo: mainRepoFrom(process.cwd()), path, sourceRef, owner }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
