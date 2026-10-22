#!/usr/bin/env node
import { realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node scripts/clean-path.mjs <relative-path>...');
  process.exit(2);
}

const root = process.cwd();
const rootReal = realpathSync(root);
let failed = false;

function outsideRoot(candidate) {
  const inside = relative(rootReal, candidate);
  return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
}

function assertParentInside(targetPath, target) {
  let parent = dirname(targetPath);
  for (;;) {
    let parentReal;
    try {
      parentReal = realpathSync(parent);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) return;
      parent = next;
      continue;
    }
    if (outsideRoot(parentReal)) {
      throw new Error(`refusing path redirected outside the current directory: ${target}`);
    }
    return;
  }
}

for (const target of targets) {
  if (isAbsolute(target)) {
    console.error(`[clean-path] refusing absolute path: ${target}`);
    failed = true;
    continue;
  }
  const resolved = resolve(root, target);
  const inside = relative(root, resolved);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    console.error(`[clean-path] refusing path outside the current directory: ${target}`);
    failed = true;
    continue;
  }
  try {
    // Lexical containment is not enough: an intermediate symlink or Windows
    // junction can redirect a nested target outside this package.
    assertParentInside(resolved, target);
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.error(`[clean-path] failed to remove ${target}: ${error.message}`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
