/**
 * account-store-root resolver unit tests (plan Task 2 / INV-1, INV-2, INV-10).
 */
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { resolveAccountStoreRoot } = await import('../dist/config/account-store-root.js');

const ENV_KEYS = ['CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT'];
const savedEnv = {};

describe('resolveAccountStoreRoot (single store-root resolver)', () => {
  let runtimeRoot;
  let workspaceRoot;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    runtimeRoot = join(tmpdir(), `store-root-runtime-${Date.now()}-${Math.random()}`);
    workspaceRoot = join(tmpdir(), `store-root-workspace-${Date.now()}-${Math.random()}`);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('INV-2: explicit CAT_CAFE_GLOBAL_CONFIG_ROOT always wins', () => {
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = workspaceRoot;
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
    assert.equal(resolveAccountStoreRoot({ projectRoot: runtimeRoot }), resolve(workspaceRoot));
  });

  it('split-root: runtime-root path maps to the workspace store', () => {
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
    assert.equal(resolveAccountStoreRoot({ projectRoot: runtimeRoot }), resolve(workspaceRoot));
    assert.equal(
      resolveAccountStoreRoot({ projectRoot: join(runtimeRoot, 'packages', 'api') }),
      resolve(workspaceRoot, 'packages', 'api'),
    );
  });

  it('same-root deployment is a no-op (runtime == workspace)', () => {
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = runtimeRoot;
    assert.equal(resolveAccountStoreRoot({ projectRoot: runtimeRoot }), resolve(runtimeRoot));
  });

  it('INV-10: external project path stays project-scoped (no global override)', () => {
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
    const external = join(tmpdir(), 'unrelated-project');
    assert.equal(resolveAccountStoreRoot({ projectRoot: external }), resolve(external));
  });

  it('missing workspace env → no mapping, path returned unchanged', () => {
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    assert.equal(resolveAccountStoreRoot({ projectRoot: runtimeRoot }), resolve(runtimeRoot));
  });

  it('no projectRoot → homedir default', () => {
    assert.equal(resolveAccountStoreRoot({}), resolve(homedir()));
  });

  it('accepts injected env (pure function, no process.env dependency)', () => {
    const result = resolveAccountStoreRoot({
      projectRoot: runtimeRoot,
      env: { CAT_CAFE_RUNTIME_ROOT: runtimeRoot, CAT_CAFE_WORKSPACE_ROOT: workspaceRoot },
    });
    assert.equal(result, resolve(workspaceRoot));
  });
});
