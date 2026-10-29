import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  resolveInitialBuildRevision,
  resolveRuntimeDeploymentRevision,
} from '../dist/config/runtime-deployment-revision.js';

const roots = [];

async function makeRuntimeRoot(apiRevision, webRevision) {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-runtime-revision-'));
  roots.push(root);
  await mkdir(join(root, 'packages/api/dist'), { recursive: true });
  await mkdir(join(root, 'packages/web/.next'), { recursive: true });
  if (apiRevision !== null) {
    await writeFile(join(root, 'packages/api/dist/.build-commit'), `${apiRevision}\n`, 'utf8');
  }
  if (webRevision !== null) {
    await writeFile(join(root, 'packages/web/.next/.build-commit'), `${webRevision}\n`, 'utf8');
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runtime deployment revision', () => {
  it('returns the shared exact commit only when API and Web were built from the same revision', async () => {
    const revision = 'a'.repeat(40);
    const root = await makeRuntimeRoot(revision, revision);
    assert.equal(resolveRuntimeDeploymentRevision(root), revision);
  });

  it('fails closed when either build stamp is missing, malformed, or split-brain', async () => {
    const revision = 'b'.repeat(40);
    assert.equal(resolveRuntimeDeploymentRevision(await makeRuntimeRoot(revision, null)), null);
    assert.equal(resolveRuntimeDeploymentRevision(await makeRuntimeRoot(revision, 'not-a-commit')), null);
    assert.equal(resolveRuntimeDeploymentRevision(await makeRuntimeRoot(revision, 'c'.repeat(40))), null);
  });
});

describe('initial process build revision', () => {
  it('identifies a direct build without deployment coordinates', async () => {
    const revision = 'd'.repeat(40);
    const entrypointRoot = await makeRuntimeRoot(revision, revision);
    assert.equal(resolveInitialBuildRevision({ entrypointRoot }), revision);
  });

  it('uses the loaded entrypoint, not an inherited runtime root without deployment ownership', async () => {
    const revision = 'd'.repeat(40);
    const entrypointRoot = await makeRuntimeRoot(revision, revision);
    const inheritedRoot = await makeRuntimeRoot('e'.repeat(40), 'e'.repeat(40));
    assert.equal(resolveInitialBuildRevision({ entrypointRoot, declaredRuntimeRoot: inheritedRoot }), revision);
  });

  it('keeps managed launches unverified until the owned boot context is available', async () => {
    const revision = 'e'.repeat(40);
    const entrypointRoot = await makeRuntimeRoot(revision, revision);
    for (const declaredRuntimeRoot of [entrypointRoot, await makeRuntimeRoot(revision, revision)]) {
      assert.equal(
        resolveInitialBuildRevision({ entrypointRoot, declaredRuntimeRoot, declaredDeploymentId: 'runtime' }),
        null,
      );
    }
  });

  it('does not bless missing or mismatched direct build stamps', async () => {
    const revision = 'f'.repeat(40);
    for (const webRevision of [null, 'a'.repeat(40)]) {
      assert.equal(resolveInitialBuildRevision({ entrypointRoot: await makeRuntimeRoot(revision, webRevision) }), null);
    }
  });
});
