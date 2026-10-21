/** Load reviewed original package bytes, not a neighbouring source checkout. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';

export async function loadTrackingPackage(t) {
  const matrixPath = process.env.F202_CANDIDATE_MATRIX;
  assert.ok(matrixPath, 'Set F202_CANDIDATE_MATRIX; this producer gate must not silently skip');
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'native-tracking-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const roots = new Map();
  const pins = {
    '@clowder-ai/plugin-contract': '785543498768f4e65fca2f1c60ff9a9c45693f45a304692a73042cc13e50a713',
    '@clowder-ai/plugin-sdk': '59fedad9d87043558b57315cc1ad0f4fb22cebdcf1329bec84825a3579d3db03',
    '@clowder-ai/github-operations': 'fee6fbfa937e11d1e3878a6a07ab7b69dbe6cc767e229cebc025826fd4440e7c',
  };
  for (const [name, sha256] of Object.entries(pins)) {
    const row = [...matrix.canonical, ...matrix.allPackages].find((item) => item.name === name);
    assert.ok(row, `missing ${name}`);
    const archive = resolve(dirname(matrixPath), row.path ?? row.archive);
    assert.equal(
      createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
      sha256,
      name,
    );
    const directory = join(root, name.split('/')[1]);
    await mkdir(directory);
    await promisify(execFile)('tar', ['-xzf', archive, '-C', directory]);
    roots.set(name, join(directory, 'package'));
  }
  const contractDependencies = resolve(await realpath('node_modules/@clowder-ai/plugin-contract'), '../..');
  for (const name of ['ajv', 'ajv-formats']) {
    const target = join(roots.get('@clowder-ai/plugin-contract'), 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(join(contractDependencies, name)), target);
  }
  for (const packageRoot of roots.values()) {
    for (const name of [...roots.keys(), '@modelcontextprotocol/sdk', 'zod', 'fastify']) {
      if (roots.get(name) === packageRoot) continue;
      const target = join(packageRoot, 'node_modules', name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(roots.get(name) ?? resolve('node_modules', name), target);
    }
  }
  const packageRoot = roots.get('@clowder-ai/github-operations');
  return {
    root,
    manifest: parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8')),
    ...(await import(pathToFileURL(join(packageRoot, 'dist/plugin-entrypoint.js')).href)),
  };
}
