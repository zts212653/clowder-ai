import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tmpRoots = [];

async function createTempDir() {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-bootcamp-workspace-root-'));
  tmpRoots.push(dir);
  return realpath(dir);
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('bootcamp workspace root resolution', () => {
  it('uses CAT_CAFE_WORKSPACE_ROOT even when runtime root is set', async () => {
    const workspaceRoot = await createTempDir();
    const runtimeRoot = await createTempDir();
    const { resolveBootcampWorkspaceRoot } = await import('../dist/domains/cats/services/bootcamp/workspace-root.js');

    const resolved = await resolveBootcampWorkspaceRoot({
      CAT_CAFE_WORKSPACE_ROOT: workspaceRoot,
      CAT_CAFE_RUNTIME_ROOT: runtimeRoot,
    });

    assert.equal(resolved.ok, true);
    assert.equal(resolved.projectPath, workspaceRoot);
  });

  it('refuses to fall back to cwd in runtime mode without CAT_CAFE_WORKSPACE_ROOT', async () => {
    const runtimeRoot = await createTempDir();
    const cwd = await createTempDir();
    const { resolveBootcampWorkspaceRoot } = await import('../dist/domains/cats/services/bootcamp/workspace-root.js');

    const resolved = await resolveBootcampWorkspaceRoot({ CAT_CAFE_RUNTIME_ROOT: runtimeRoot }, cwd);

    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /workspace root is not configured/);
  });

  it('uses cwd outside runtime mode', async () => {
    const cwd = await createTempDir();
    const { resolveBootcampWorkspaceRoot } = await import('../dist/domains/cats/services/bootcamp/workspace-root.js');

    const resolved = await resolveBootcampWorkspaceRoot({}, cwd);

    assert.equal(resolved.ok, true);
    assert.equal(resolved.projectPath, cwd);
  });
});
