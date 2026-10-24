/**
 * Issue #1666: Environment isolation security unit tests
 *
 * Tests buildChildEnv behavior for inheritParentEnv contract.
 * These are unit tests, not end-to-end integration tests.
 *
 * TODO: Add integration tests that call:
 * - CodexAgentService.invoke → tmux factory → writeAgentCommandFile → script generation
 * - exec_json path → writeAgentCommandFile → script generation
 * Verify that deleting :2573 inheritParentEnv causes RED (credentials restored).
 */

import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { buildChildEnv } from '../src/utils/cli-spawn.js';

test('Issue #1666: buildChildEnv inheritParentEnv contract', async (t) => {
  await t.test('buildChildEnv with inheritParentEnv=false does not re-inherit deleted credentials', async () => {
    // Unit test: buildChildEnv respects inheritParentEnv=false
    const ambientCredential = 'ambient-account-fixture';
    const originalEnv = process.env.CODEX_API_KEY;
    const testCwd = resolve('/test/cwd');

    try {
      process.env.CODEX_API_KEY = ambientCredential;

      const finalEnv = buildChildEnv(
        { CODEX_API_KEY: null, USER_VAR: 'value' },
        { inheritParentEnv: false, workingDirectory: testCwd },
      );

      // finalEnv should not have the deleted credential
      assert.equal(finalEnv.CODEX_API_KEY, undefined, 'finalEnv should not restore deleted credential');

      // Second call to buildChildEnv (simulates tmux writer behavior)
      const writerOptions = {
        env: finalEnv,
        cwd: testCwd,
        inheritParentEnv: false,
      };

      const scriptEnv = buildChildEnv(writerOptions.env, {
        workingDirectory: writerOptions.cwd,
        bindExecutionOwner: false,
        inheritParentEnv: writerOptions.inheritParentEnv,
      });

      assert.equal(
        scriptEnv.CODEX_API_KEY,
        undefined,
        'Second buildChildEnv call must not re-inherit deleted ambient credential',
      );
      assert.equal(scriptEnv.USER_VAR, 'value', 'User variables should be preserved');
    } finally {
      if (originalEnv !== undefined) process.env.CODEX_API_KEY = originalEnv;
      else delete process.env.CODEX_API_KEY;
    }
  });

  await t.test('buildChildEnv with inheritParentEnv=true (default) inherits and strips forbidden vars', async () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH ?? process.env.Path;
    const testHome = '/original/home';
    const testCwd = resolve('/test/cwd');

    try {
      process.env.HOME = testHome;
      process.env.CAT_CAFE_HOOK_TOKEN = 'secret-hook-token';

      // Normal overrides: no explicit inheritParentEnv (defaults to true)
      const normalOverrides = { USER_VAR: 'value' };

      const scriptEnv = buildChildEnv(normalOverrides, {
        workingDirectory: testCwd,
        bindExecutionOwner: false,
        // inheritParentEnv: undefined → defaults to true
      });

      assert.equal(scriptEnv.HOME, testHome, 'Normal overrides should inherit HOME');
      assert.equal(scriptEnv.USER_VAR, 'value', 'User variables should be present');
      assert.equal(scriptEnv.CAT_CAFE_HOOK_TOKEN, undefined, 'Forbidden variables must be stripped');
      // Check PATH (normalized to uppercase on Windows)
      const pathKey = Object.keys(scriptEnv).find((k) => k.toUpperCase() === 'PATH');
      assert.ok(pathKey, 'PATH should be inherited');
      assert.equal(scriptEnv[pathKey], originalPath, 'PATH value should match original');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      delete process.env.CAT_CAFE_HOOK_TOKEN;
    }
  });

  await t.test('buildChildEnv corrects stale PWD/INIT_CWD', async () => {
    const stalePwd = '/old/directory';
    const actualCwd = resolve('/test/cwd');

    const overrides = {
      USER_VAR: 'value',
      PWD: stalePwd,
      INIT_CWD: stalePwd,
    };

    const scriptEnv = buildChildEnv(overrides, {
      workingDirectory: actualCwd,
      bindExecutionOwner: false,
    });

    assert.equal(scriptEnv.PWD, actualCwd, 'PWD should be corrected to actual cwd');
    assert.equal(scriptEnv.INIT_CWD, actualCwd, 'INIT_CWD should be corrected to actual cwd');
    assert.equal(scriptEnv.USER_VAR, 'value', 'User variables should be preserved');
  });

  await t.test('empty overrides preserve defaults with inheritParentEnv=true', async () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH ?? process.env.Path;
    const testHome = '/test/home';
    const testCwd = resolve('/test/cwd');

    try {
      process.env.HOME = testHome;

      // Empty overrides: was incorrectly skipping buildChildEnv in R12-R14
      const emptyOverrides = {};

      const scriptEnv = buildChildEnv(emptyOverrides, {
        workingDirectory: testCwd,
        bindExecutionOwner: false,
        // inheritParentEnv: undefined → defaults to true
      });

      assert.equal(scriptEnv.HOME, testHome, 'Empty overrides should still inherit HOME');
      // Check PATH (normalized to uppercase on Windows)
      const pathKey = Object.keys(scriptEnv).find((k) => k.toUpperCase() === 'PATH');
      assert.ok(pathKey, 'Empty overrides should still inherit PATH');
      assert.equal(scriptEnv[pathKey], originalPath, 'PATH value should match original');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });
});
