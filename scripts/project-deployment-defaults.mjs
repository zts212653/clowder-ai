#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDictionary } from './brand-dictionary-helper.mjs';
import { assertDeploymentBrands, refreshDeploymentBrands } from './deployment-brand-config.mjs';

const [file, action, ...extra] = process.argv.slice(2);
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const checking = action === '--check-brands';
const refreshing = action === '--refresh-brands';
const fromIndex = checking && extra.includes('--from-index');
if (
  !file ||
  !action ||
  (checking ? ![1, 2].includes(extra.length) || (extra.length === 2 && extra[1] !== '--from-index') : extra.length)
) {
  throw new Error(
    'Usage: project-deployment-defaults <config.json> <profile|--refresh-brands|--check-brands edition [--from-index]>',
  );
}
// Resolve aliases of the repository root, never worktree links inside it:
// staged paths remain authoritative even when their directories are replaced.
const indexKey = (path) => {
  const absolute = resolve(path);
  const key = relative(root, absolute);
  if (!isAbsolute(key) && !key.split(/[\\/]/).includes('..')) return key.split(sep).join('/');
  let directory = dirname(absolute);
  let suffix = basename(absolute);
  let aliasKey;
  while (true) {
    try {
      if (realpathSync(directory) === root) aliasKey = suffix;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    suffix = join(basename(directory), suffix);
    directory = parent;
  }
  if (aliasKey === undefined) throw new Error('Index input must be inside the repository');
  return aliasKey.split(sep).join('/');
};
const read = (path) => {
  if (!fromIndex) return readFileSync(path, 'utf8');
  return execFileSync('git', ['-C', root, 'show', `:${indexKey(path)}`], { encoding: 'utf8' });
};
const input = JSON.parse(read(file));
if (checking || refreshing) {
  const dictionary = parseDictionary(read(resolve(root, 'assets/brand-dictionary.yaml')));
  if (checking) {
    try {
      assertDeploymentBrands(input, dictionary, extra[0]);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2; // Validation failure; input/CLI/Git errors retain exit 1.
    }
  } else {
    writeFileSync(file, `${JSON.stringify(refreshDeploymentBrands(input, dictionary), null, 2)}\n`);
  }
} else {
  const { projectDeploymentProfiles } = await import('../packages/shared/src/deployment-defaults.ts');
  writeFileSync(file, `${JSON.stringify(projectDeploymentProfiles(input, action), null, 2)}\n`);
}
