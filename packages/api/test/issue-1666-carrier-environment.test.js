import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createCodexSocketDirectory,
  prepareCodexHostLaunch,
  removeCodexSocketDirectory,
  spawnCodexAppServerHost,
} from '../dist/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { createDirectAgentCarrierSession } from '../dist/domains/cats/services/agents/providers/DirectAgentCarrierSession.js';
import { createHarness, sessionOptions } from './helpers/codex-host-pool-harness.js';

function ambient(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test('a complete direct environment does not restore deleted ambient keys at actual spawn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'issue1666-direct-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  ambient(t, 'ISSUE1666_DELETED', 'ambient-fixture');
  const wire = await createDirectAgentCarrierSession({
    command: process.execPath,
    args: [
      '-e',
      'console.log(JSON.stringify({deleted:process.env.ISSUE1666_DELETED??null,proxy:process.env.HTTP_PROXY}))',
    ],
    cwd: root,
    env: { HTTP_PROXY: 'http://proxy.fixture.invalid:3128' },
    inheritParentEnv: false,
    invocationId: 'issue1666-direct',
  });
  t.after(() => wire.close());
  const events = [];
  for await (const event of wire.read()) events.push(event);
  assert.deepEqual(events, [{ deleted: null, proxy: 'http://proxy.fixture.invalid:3128' }]);
});

test('host identity describes the sanitized snapshot and cannot inherit later parent changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'issue1666-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { command: process.execPath, args: ['app-server', '--stdio'], cwd: root, invocationId: 'fixture' };
  ambient(t, 'HTTP_PROXY', 'http://first.fixture.invalid:3128');
  const first = await prepareCodexHostLaunch({ ...options, env: { HOME: root, CODEX_HOME: root } });
  process.env.HTTP_PROXY = 'http://second.fixture.invalid:3128';
  const second = await prepareCodexHostLaunch({ ...options, env: { HOME: root, CODEX_HOME: root } });
  assert.notEqual(first.signature, second.signature, 'ambient network changes must invalidate reuse');
  assert.equal(first.launch.env.HTTP_PROXY, 'http://first.fixture.invalid:3128');
  assert.equal(first.launch.inheritParentEnv, false);
  const complete = await prepareCodexHostLaunch({
    ...options,
    inheritParentEnv: false,
    env: {
      HOME: root,
      CODEX_HOME: root,
      CODEX_API_KEY: null,
      TYPESAFE_API_KEY: 'private',
      CAT_CAFE_CALLBACK_TOKEN: 'turn',
    },
  });
  const clean = await prepareCodexHostLaunch({
    ...options,
    inheritParentEnv: false,
    env: { HOME: root, CODEX_HOME: root },
  });
  assert.equal(complete.signature, clean.signature, 'filtered values cannot affect reuse');
  for (const key of ['HTTP_PROXY', 'CODEX_API_KEY', 'TYPESAFE_API_KEY', 'CAT_CAFE_CALLBACK_TOKEN'])
    assert.equal(complete.launch.env[key], undefined, key);
});

test('resume retires an idle owner after ambient proxy changes and then reuses the new owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'issue1666-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  ambient(t, 'HTTP_PROXY', 'http://first.fixture.invalid:3128');
  const { pool, hosts } = createHarness();
  t.after(() => pool.closeAll());
  const options = sessionOptions({ cwd: root, env: { HOME: root, CODEX_HOME: root } });
  const first = await pool.createSession(options);
  first.rememberSession('issue1666-native-session');
  await first.close();
  process.env.HTTP_PROXY = 'http://second.fixture.invalid:3128';
  const resumed = await pool.createSession({
    ...options,
    sessionId: 'issue1666-native-session',
    invocationId: 'second',
  });
  assert.equal(hosts.length, 2);
  assert.equal(hosts[0].closeCalls, 1);
  assert.equal(hosts[1].launch.env.HTTP_PROXY, 'http://second.fixture.invalid:3128');
  assert.equal(resumed.reusedSessionHost, false);
  resumed.rememberSession('issue1666-native-session');
  await resumed.close();
  const third = await pool.createSession({ ...options, sessionId: 'issue1666-native-session', invocationId: 'third' });
  assert.equal(hosts.length, 2);
  assert.equal(third.reusedSessionHost, true);
  await third.close();
});

test(
  'actual Unix host spawn uses its prepared environment after the parent changes',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = createCodexSocketDirectory();
    t.after(() => removeCodexSocketDirectory(root));
    const path = join(root, 'env.json');
    const socketPath = join(root, 'host.sock');
    ambient(t, 'HTTP_PROXY', 'http://first.fixture.invalid:3128');
    ambient(t, 'CAT_CAFE_CALLBACK_TOKEN', 'ambient-callback-fixture');
    const prepared = await prepareCodexHostLaunch({
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(path)},JSON.stringify({proxy:process.env.HTTP_PROXY,token:process.env.CAT_CAFE_CALLBACK_TOKEN??null}));require('node:net').createServer().listen(${JSON.stringify(socketPath)})`,
      ],
      cwd: root,
      env: { HOME: root, CODEX_HOME: root },
      invocationId: 'spawn-fixture',
    });
    process.env.HTTP_PROXY = 'http://second.fixture.invalid:3128';
    const host = await spawnCodexAppServerHost({ ...prepared.launch, socketDirectory: root, socketPath });
    t.after(() => host.close());
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      proxy: 'http://first.fixture.invalid:3128',
      token: null,
    });
  },
);
