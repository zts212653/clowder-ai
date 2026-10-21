/** Paired Host tests use exact package bytes, never a neighbouring source checkout.
 * Missing packages skip only the ordinary Host lane; the paired gate requires them.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after as nodeAfter, before as nodeBefore, test as nodeTest } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const matrixPath = process.env.F202_CANDIDATE_MATRIX;
if (!matrixPath && process.env.F202_ARTIFACT_GATE_REQUIRED === '1') {
  throw new Error('F202_CANDIDATE_MATRIX is required for the Collective paired artifact gate');
}
export let collectivePackageRoot;
if (matrixPath) {
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'f202-collective-paired-'));
  const roots = new Map();
  for (const name of ['@clowder-ai/plugin-contract', '@clowder-ai/plugin-sdk', '@clowder-ai/collective-connector']) {
    const row = [...(matrix.canonical ?? []), ...matrix.allPackages].find((entry) => entry.name === name);
    assert.ok(row, `matrix must contain ${name}`);
    const archive = row.path ?? row.archive;
    assert.equal(
      createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
      row.sha256,
    );
    const directory = join(root, name.split('/')[1]);
    await mkdir(directory, { recursive: true });
    await promisify(execFile)('tar', ['-xzf', archive, '-C', directory]);
    roots.set(name, join(directory, 'package'));
  }
  collectivePackageRoot = roots.get('@clowder-ai/collective-connector');
  const contractDependencies = resolve(await realpath('node_modules/@clowder-ai/plugin-contract'), '../..');
  for (const name of ['ajv', 'ajv-formats']) {
    const target = join(roots.get('@clowder-ai/plugin-contract'), 'node_modules', name);
    await mkdir(join(target, '..'), { recursive: true });
    await symlink(await realpath(join(contractDependencies, name)), target);
  }
  for (const packageRoot of roots.values()) {
    for (const name of ['@clowder-ai/plugin-sdk', '@clowder-ai/plugin-contract', '@modelcontextprotocol/sdk', 'zod']) {
      if (roots.get(name) === packageRoot) continue;
      const target = join(packageRoot, 'node_modules', name);
      await mkdir(join(target, '..'), { recursive: true });
      await symlink(roots.get(name) ?? resolve('node_modules', name), target);
    }
  }
}
export async function loadCollectiveModule(path) {
  assert.ok(collectivePackageRoot, 'exact Collective package is unavailable');
  return import(pathToFileURL(join(collectivePackageRoot, 'dist', path)).href);
}
const connector = matrixPath ? await loadCollectiveModule('business/connector/index.js') : {};
const service = matrixPath ? await loadCollectiveModule('business/service/index.js') : {};
export const { CollectiveConnector, ConnectorTransportError } = connector;
export const { CollectiveServiceStore, startCollectiveServer } = service;

export function test(name, options, fn) {
  if (typeof options === 'function') [options, fn] = [{}, options];
  return nodeTest(
    name,
    {
      ...options,
      ...(!matrixPath ? { skip: 'requires the paired Collective archive; run test:collective-artifact' } : {}),
    },
    fn,
  );
}
export const before = (...args) => matrixPath && nodeBefore(...args);
export const after = (...args) => matrixPath && nodeAfter(...args);
