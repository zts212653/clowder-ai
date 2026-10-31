import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { resolveRuntimeDeploymentRevision } from '../dist/config/runtime-deployment-revision.js';

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
