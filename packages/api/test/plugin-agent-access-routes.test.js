import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerAgentAccessRoutes } from '../dist/routes/agent-access-routes.js';

async function fixture(t, agentAdapters) {
  const app = Fastify();
  t.after(() => app.close());
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'];
  });
  const instance = {
    pluginId: 'official.agent-access',
    pluginInstanceId: 'agent-access-instance',
    packageDigest: 'sha512-before',
    lifecycleState: 'installed',
    activationState: 'enabled',
    configReadiness: 'ready',
    runtimeState: 'healthy',
    lifecycleRevision: 8,
  };
  let authority;
  const splitAuthorities = new Map();
  const calls = [];
  let invoke = async () => ({
    candidates: [{ id: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: [] }],
  });
  registerAgentAccessRoutes(app, {
    inventory: {
      readCurrentAuthority: async (id) => (id === instance.pluginId ? authority : splitAuthorities.get(id)),
    },
    agentAdapters,
    runtime: {
      attemptInvoke: async (...args) => {
        calls.push(args);
        return { status: 'returned', value: await invoke(...args) };
      },
    },
  });
  const request = (payload = {}, authorized = true) =>
    app.inject({
      method: 'POST',
      url: '/api/agent-access/v1/detect',
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost:3004', ...(authorized ? { 'x-test-session-user': owner } : {}) },
      payload,
    });
  return {
    calls,
    request,
    setSplitAuthority: (id, value) => splitAuthorities.set(id, value),
    setState: (overrides = {}, manifest = {}) => {
      const next = { ...instance, ...overrides };
      authority = { instance: next, packageRecord: { manifest } };
    },
    setInvoke: (run) => {
      invoke = run;
    },
  };
}

test('Agent access detection distinguishes package availability from a successful empty scan', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request({}, false)).statusCode, 401);
  assert.deepEqual((await f.request()).json(), { readiness: { state: 'missing', action: 'install' }, candidates: [] });
  for (const [overrides, expected] of [
    [{ activationState: 'disabled' }, { state: 'disabled', action: 'enable' }],
    [{ runtimeState: 'stopped' }, { state: 'starting' }],
    [{ runtimeState: 'crashed' }, { state: 'failed', action: 'repair' }],
  ]) {
    f.setState(overrides);
    assert.deepEqual((await f.request()).json(), { readiness: expected, candidates: [] });
  }
  f.setState({}, null);
  assert.deepEqual((await f.request()).json(), {
    readiness: { state: 'incompatible', action: 'repair' },
    candidates: [],
  });
  assert.equal(f.calls.length, 0);
  f.setState();
  assert.equal((await f.request({ projectRoot: '/user-supplied-root' })).statusCode, 400);
  const refresh = await f.request({ refresh: true });
  assert.equal(refresh.statusCode, 200, refresh.payload);
  assert.equal(refresh.json().candidates[0].id, 'codex');
  assert.deepEqual(f.calls, [['agent-access-instance', 'detect', { refresh: true }]]);
  f.setInvoke(async () => ({ candidates: [] }));
  assert.deepEqual((await f.request()).json(), { readiness: { state: 'ready' }, candidates: [] });
});

test('Agent access refuses a detection result from a replaced package generation', async (t) => {
  const f = await fixture(t);
  f.setState();
  f.setInvoke(async () => {
    f.setState({ packageDigest: 'sha512-after', lifecycleRevision: 9 });
    return { candidates: [{ id: 'from-old-package', label: 'Old', clientId: 'openai', installed: true, models: [] }] };
  });
  assert.deepEqual((await f.request()).json(), { readiness: { state: 'starting' }, candidates: [] });
});

test('member detection keeps the legacy Desktop descriptor while listing only active split adapters', async (t) => {
  const kimiRef = 'plugin:official.agent-kimi/kimi';
  const kimi = { pluginId: 'official.agent-kimi', contributionId: 'kimi' };
  const failingRef = 'plugin:test.discovery/failing';
  const calls = [];
  let enabled = true;
  const f = await fixture(t, {
    list: async () => (enabled ? [{ ref: failingRef }, { ref: kimiRef }] : []),
    detect: async (ref, { refresh }) => {
      calls.push({ ref, refresh });
      if (ref.pluginId === 'test.discovery') throw new Error('adapter probe failed');
      assert.deepEqual(ref, kimi);
      return { candidates: [{ id: 'kimi', label: 'Kimi Code', state: { status: 'ready', version: '2.6.3' } }] };
    },
  });
  const desktop = {
    id: 'dsh-desktop',
    label: 'DSH Desktop',
    clientId: 'acp',
    installed: true,
    models: [],
    dshDesktop: true,
    dshSetupSupported: true,
    acp: { command: 'C:/DSH/resources/runtime/cli/bin/dsh.cmd', startupArgs: ['--profile', 'acp'] },
  };
  const legacyKimi = { id: 'kimi', label: 'Kimi', clientId: 'kimi', installed: true, models: [] };
  const legacyCodex = { id: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: [] };
  const legacyCandidates = [legacyKimi, legacyCodex, desktop];
  const splitAuthority = (id, provenance, activationState, lifecycleState = 'installed') => ({
    instance: { pluginId: `official.agent-${id}`, lifecycleState, activationState },
    packageRecord: { provenance },
  });
  const catalog = (id) => ({ kind: 'catalog', catalogId: `agent-${id}`, packageName: `@clowder-ai/agent-${id}` });
  f.setState();
  f.setInvoke(async () => ({ candidates: legacyCandidates, partialFailures: [{ id: 'legacy-failure' }] }));
  enabled = false;
  f.setSplitAuthority(kimi.pluginId, splitAuthority('kimi', { kind: 'local-archive' }, 'disabled'));
  assert.deepEqual((await f.request()).json().candidates, legacyCandidates);
  enabled = true;
  f.setSplitAuthority(kimi.pluginId, splitAuthority('kimi', catalog('kimi'), 'enabled'));
  f.setSplitAuthority('official.agent-codex', splitAuthority('codex', catalog('codex'), 'disabled'));
  const result = (await f.request({ refresh: true })).json();
  assert.deepEqual(result.readiness, { state: 'ready' });
  assert.deepEqual(result.candidates, [
    desktop,
    {
      id: kimiRef,
      label: 'Kimi Code',
      clientId: 'acp',
      installed: true,
      models: [],
      acp: { agentProvider: kimiRef, command: 'plugin-agent', startupArgs: [] },
    },
  ]);
  assert.deepEqual(result.partialFailures, [{ id: 'legacy-failure' }, { id: failingRef }]);
  assert.ok(calls.some((call) => call.ref.contributionId === 'kimi' && call.refresh));
  enabled = false;
  f.setSplitAuthority(kimi.pluginId, splitAuthority('kimi', catalog('kimi'), 'disabled'));
  assert.deepEqual((await f.request()).json().candidates, [desktop]);
  assert.equal(calls.filter((call) => call.ref.contributionId === 'kimi').length, 1);

  f.setSplitAuthority(kimi.pluginId, splitAuthority('kimi', catalog('kimi'), 'disabled', 'retired'));
  assert.deepEqual((await f.request()).json().candidates, [legacyKimi, desktop]);
});
