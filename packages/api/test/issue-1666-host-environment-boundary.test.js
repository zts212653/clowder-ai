import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexHostLaunch } from '../dist/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';

test('final host snapshots strip execution capabilities without inheriting deleted proxy or credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'issue1666-host-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.CODEX_API_KEY;
  process.env.CODEX_API_KEY = 'ambient-fixture-only';
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previous;
  });
  const env = {
    HOME: root,
    CODEX_HOME: root,
    HTTP_PROXY: 'http://proxy.fixture.invalid:3128',
    NO_PROXY: 'internal.fixture,localhost,127.0.0.1,::1',
    CODEX_API_KEY: null,
    CAT_CAFE_PROCESS_EXECUTION_OWNER: '1',
    CAT_CAFE_EXECUTION_ID: 'outer-fixture',
    CAT_CAFE_INVOCATION_ID: 'turn-fixture',
    CAT_CAFE_CALLBACK_TOKEN: 'callback-fixture',
    TYPESAFE_API_KEY: 'private-fixture',
  };
  const options = { command: process.execPath, args: ['app-server', '--stdio'], cwd: root, inheritParentEnv: false };
  const prepared = await prepareCodexHostLaunch({ ...options, env });
  for (const key of [
    'CODEX_API_KEY',
    'CAT_CAFE_PROCESS_EXECUTION_OWNER',
    'CAT_CAFE_EXECUTION_ID',
    'CAT_CAFE_INVOCATION_ID',
    'CAT_CAFE_CALLBACK_TOKEN',
    'TYPESAFE_API_KEY',
  ])
    assert.equal(prepared.launch.env[key], undefined, `${key} must not reach the shared host`);
  assert.equal(prepared.launch.env.HTTP_PROXY, env.HTTP_PROXY);
  assert.equal(prepared.launch.env.NO_PROXY, env.NO_PROXY);
  assert.equal(prepared.launch.inheritParentEnv, false);
  const clean = { HOME: root, CODEX_HOME: root, HTTP_PROXY: env.HTTP_PROXY, NO_PROXY: env.NO_PROXY };
  const equivalent = await prepareCodexHostLaunch({ ...options, env: clean });
  assert.equal(prepared.signature, equivalent.signature, 'reuse identity must describe the actual sanitized host');
});
