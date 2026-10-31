import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { beginOwnedRuntimeDeployment } from '../dist/domains/runtime-deployment/RuntimeDeploymentBootstrap.js';

const roots = [];

async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function stampBuild(root, revision) {
  const apiDist = join(root, 'packages', 'api', 'dist');
  const webBuild = join(root, 'packages', 'web', '.next');
  await Promise.all([mkdir(apiDist, { recursive: true }), mkdir(webBuild, { recursive: true })]);
  await Promise.all([
    writeFile(join(apiDist, '.build-commit'), `${revision}\n`),
    writeFile(join(webBuild, '.build-commit'), `${revision}\n`),
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('formal runtime and Alpha each begin a boot only for their physical entrypoint root', async () => {
  for (const deploymentId of ['runtime', 'alpha']) {
    const root = await tempRoot(`f323-${deploymentId}-root-`);
    const dataRoot = await tempRoot(`f323-${deploymentId}-data-`);
    const revision = deploymentId === 'runtime' ? 'a'.repeat(40) : 'b'.repeat(40);
    await stampBuild(root, revision);
    const context = await beginOwnedRuntimeDeployment({
      runtimeRoot: root,
      entrypointRoot: root,
      deploymentId,
      dataRoot,
      currentReadyServices: async () => ['api', 'web'],
    });

    assert.ok(context);
    const physicalRoot = await realpath(root);
    assert.equal(context.runtimeRoot, physicalRoot);
    assert.equal(context.deploymentId, deploymentId);
    assert.equal(context.bootSequence, 1);
    assert.equal(context.runningRevision, revision);
    assert.equal(context.installationId, createHash('sha256').update(physicalRoot).digest('hex'));
    assert.equal((await context.ledger.readCurrent(deploymentId)).bootId, context.bootId);
  }
});

test('a direct worktree entrypoint cannot overwrite a canonical ledger through inherited runtime coordinates', async () => {
  const runtimeRoot = await tempRoot('f323-formal-root-');
  const worktreeRoot = await tempRoot('f323-worktree-root-');
  const dataRoot = await tempRoot('f323-shared-data-');
  const revision = 'c'.repeat(40);
  await stampBuild(runtimeRoot, revision);
  const formal = await beginOwnedRuntimeDeployment({
    runtimeRoot,
    entrypointRoot: runtimeRoot,
    deploymentId: 'runtime',
    dataRoot,
  });
  assert.ok(formal);
  assert.equal(formal.runningRevision, revision);
  const ledgerFile = join(dataRoot, 'runtime-deployment', `${formal.installationId}.json`);
  const before = await readFile(ledgerFile, 'utf8');

  const inherited = await beginOwnedRuntimeDeployment({
    runtimeRoot,
    entrypointRoot: worktreeRoot,
    deploymentId: 'runtime',
    dataRoot,
    currentReadyServices: async () => ['api', 'web'],
  });

  assert.equal(inherited, null);
  assert.equal(await readFile(ledgerFile, 'utf8'), before, 'foreign namespace cannot replace canonical head');
});
