import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Fastify from 'fastify';
import { createModuleHostInvocation } from '../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';

import {
  InstalledPluginOperations,
  pluginOperationRoutes,
} from '../dist/domains/plugin/operations/plugin-operation-routes.js';

const apps = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const pluginId = 'dev.clowder.operation-fixture';
const pluginInstanceId = 'pi_operation_fixture';

function manifest() {
  return {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Operation fixture',
    configuration: [
      { key: 'account', label: 'Account', kind: 'string', required: false },
      { key: 'BOT_TOKEN', label: 'Token', kind: 'secret', required: false },
      {
        key: 'qr_login',
        label: 'QR login',
        kind: 'operation',
        required: false,
        target: ['BOT_TOKEN'],
        actions: [
          {
            id: 'generate',
            label: 'Generate',
            render: 'button',
            action: { method: 'qr.generate', params: { fixed: 'manifest' } },
            next: 'status',
          },
          {
            id: 'status',
            label: 'Status',
            render: 'polling',
            action: { method: 'qr.status' },
            rollback: 'generate',
            timeout: 30,
          },
        ],
      },
    ],
    test: { action: { method: 'self.test', params: { thorough: true } } },
    steps: [{ text: 'Generate a QR code.' }],
    features: [{ id: 'main', name: 'Main', capabilities: [], contributions: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
  };
}

function snapshot({ enabled = true, installed = true } = {}) {
  return {
    schemaVersion: 1,
    packages: installed
      ? [
          {
            packageDigest: 'sha512-fixture',
            pluginId,
            version: '1.0.0',
            contractVersion: '0.1.0',
            manifest: manifest(),
            signalSchemas: {},
            packageState: 'installed',
            verifiedAt: 1,
            updatedAt: 1,
          },
        ]
      : [],
    instances: installed
      ? [
          {
            pluginInstanceId,
            pluginId,
            packageDigest: 'sha512-fixture',
            lifecycleState: 'installed',
            configReadiness: 'ready',
            activationState: enabled ? 'enabled' : 'disabled',
            runtimeState: enabled ? 'healthy' : 'stopped',
            lifecycleRevision: 3,
            installedAt: 1,
            updatedAt: 1,
          },
        ]
      : [],
    grants: [],
  };
}

async function harness({
  enabled = true,
  installed = true,
  timeoutMs = 50,
  generate = 'valid',
  confirmation = false,
} = {}) {
  let now = 10_000;
  let operationState;
  const targetWrites = [];
  const calls = [];
  const logRecords = [];
  const configuration = {
    async readActionInput() {
      return { account: 'owner@example.com' };
    },
    async readOperationState() {
      return operationState;
    },
    async writeOperationState(_pluginId, _operationKey, state) {
      operationState = structuredClone(state);
    },
    async clearOperationState() {
      operationState = undefined;
    },
    async configureOperationTargets(_pluginId, _pluginInstanceId, _operation, values) {
      targetWrites.push(structuredClone(values));
      return Object.keys(values);
    },
  };
  const transport = {
    async invoke(instanceId, method, params) {
      calls.push({ instanceId, method, params: structuredClone(params) });
      if (method === 'qr.generate') {
        if (generate === 'invalid') return { render: 42 };
        if (generate === 'slow') return new Promise(() => undefined);
        const generatedError = { throws: 'Token rejected\n    at private-stack:42', longthrows: 'x'.repeat(240) }[
          generate
        ];
        if (generatedError) throw new Error(generatedError);
        return {
          render: 'img',
          data: { url: 'data:image/png;base64,abc' },
          targetValues: { BOT_TOKEN: 'new-secret', NOT_DECLARED: 'ignored' },
        };
      }
      if (method === 'qr.status') return { render: 'polling', data: { waiting: true }, advance: false };
      if (method === 'self.test') return { ok: true };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const actions = Object.fromEntries(
    ['qr.generate', 'qr.status', 'self.test'].map((method) => [
      method,
      (params) => transport.invoke(pluginInstanceId, method, params),
    ]),
  );
  const invocation = createModuleHostInvocation({ runtime: { actions: () => actions } });
  const operations = new InstalledPluginOperations({
    inventory: {
      snapshot: async () => {
        const value = snapshot({ enabled, installed });
        if (confirmation && value.packages[0])
          value.packages[0].manifest.configuration[2].actions[0].confirm = 'Confirm generation';
        return value;
      },
    },
    configuration,
    invocation,
    timeoutMs,
    now: () => now,
  });
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line) => logRecords.push(JSON.parse(line)) } } });
  apps.push(app);
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    const owner = request.headers['x-cat-cafe-user'];
    if (typeof owner === 'string') request.sessionUserId = owner;
  });
  await app.register(pluginOperationRoutes, { operations });
  return {
    app,
    calls,
    targetWrites,
    logRecords,
    get state() {
      return operationState;
    },
    setNow(value) {
      now = value;
    },
  };
}

const localHeaders = { host: 'localhost:3004', origin: 'http://localhost:3004' };
const auth = {
  ...localHeaders,
  'x-cat-cafe-user': process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner-user',
};

function inject(app, options) {
  return app.inject({ ...options, remoteAddress: '127.0.0.1' });
}

test('installed plugin operation routes invoke declared actions, persist state, backfill targets, reset, and test', async () => {
  const h = await harness();
  const generated = await inject(h.app, {
    method: 'POST',
    url: `/api/plugins/${pluginId}/actions/qr_login/generate`,
    headers: auth,
    payload: { requestValue: 'browser' },
  });
  assert.equal(generated.statusCode, 200, generated.payload);
  assert.deepEqual(generated.json(), {
    ok: true,
    render: 'img',
    data: { url: 'data:image/png;base64,abc' },
    currentAction: 'status',
    advance: true,
    backfilledKeys: ['BOT_TOKEN'],
  });
  assert.deepEqual(h.calls[0], {
    instanceId: pluginInstanceId,
    method: 'qr.generate',
    params: {
      fixed: 'manifest',
      input: { account: 'owner@example.com', requestValue: 'browser' },
    },
  });
  assert.equal(Object.hasOwn(h.calls[0].params.input, 'BOT_TOKEN'), false);
  assert.deepEqual(h.targetWrites, [{ BOT_TOKEN: 'new-secret' }]);
  assert.equal(h.state.currentAction, 'status');

  const polling = await inject(h.app, {
    method: 'POST',
    url: `/api/plugins/${pluginId}/actions/qr_login/status`,
    headers: auth,
  });
  assert.equal(polling.statusCode, 200, polling.payload);
  assert.equal(polling.json().currentAction, 'status');
  assert.equal(polling.json().advance, false);

  h.setNow(40_001);
  const expired = await inject(h.app, {
    method: 'POST',
    url: `/api/plugins/${pluginId}/actions/qr_login/status`,
    headers: auth,
  });
  assert.equal(expired.statusCode, 200, expired.payload);
  assert.equal(expired.json().currentAction, 'generate');
  assert.equal(expired.json().transition, 'rollback');
  assert.equal(expired.json().advance, false);

  const reset = await inject(h.app, {
    method: 'POST',
    url: `/api/plugins/${pluginId}/operations/qr_login/reset`,
    headers: auth,
  });
  assert.equal(reset.statusCode, 200, reset.payload);
  assert.equal(h.state, undefined);

  const tested = await inject(h.app, { method: 'POST', url: `/api/plugins/${pluginId}/test`, headers: auth });
  assert.equal(tested.statusCode, 200, tested.payload);
  assert.deepEqual(tested.json(), { ok: true });
  assert.deepEqual(h.calls.at(-1), {
    instanceId: pluginInstanceId,
    method: 'self.test',
    params: { thorough: true },
  });
});

test('operation routes fail closed for auth, lifecycle, declarations, invalid responses, and timeouts', async () => {
  const active = await harness();
  assert.equal(
    (
      await inject(active.app, {
        method: 'POST',
        url: `/api/plugins/${pluginId}/actions/qr_login/generate`,
        headers: localHeaders,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await inject(active.app, {
        method: 'POST',
        url: `/api/plugins/${pluginId}/actions/missing/generate`,
        headers: auth,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await inject(active.app, {
        method: 'POST',
        url: `/api/plugins/${pluginId}/actions/qr_login/missing`,
        headers: auth,
      })
    ).statusCode,
    404,
  );

  const disabled = await harness({ enabled: false });
  assert.equal(
    (
      await inject(disabled.app, {
        method: 'POST',
        url: `/api/plugins/${pluginId}/actions/qr_login/generate`,
        headers: auth,
      })
    ).statusCode,
    409,
  );
  const missing = await harness({ installed: false });
  assert.equal(
    (
      await inject(missing.app, {
        method: 'POST',
        url: `/api/plugins/${pluginId}/actions/qr_login/generate`,
        headers: auth,
      })
    ).statusCode,
    404,
  );

  const invalid = await harness({ generate: 'invalid' });
  assert.equal(
    (
      await inject(invalid.app, {
        method: 'POST',
        url: `/api/plugins/${pluginId}/actions/qr_login/generate`,
        headers: auth,
      })
    ).statusCode,
    502,
  );

  const slow = await harness({ generate: 'slow', timeoutMs: 5 });
  assert.equal(
    (
      await inject(slow.app, {
        method: 'POST',
        url: `/api/plugins/${pluginId}/actions/qr_login/generate`,
        headers: auth,
      })
    ).statusCode,
    504,
  );

  const thrown = await harness({ generate: 'throws' });
  const failure = await inject(thrown.app, {
    method: 'POST',
    url: `/api/plugins/${pluginId}/actions/qr_login/generate`,
    headers: { ...auth, 'x-private-header': 'must-not-log-header' },
    payload: { privateBody: 'must-not-log' },
  });
  assert.equal(failure.statusCode, 502);
  assert.deepEqual(failure.json(), { error: 'Action failed: Token rejected' });
  assert.equal(failure.payload.includes('private-stack'), false);
  assert.equal(
    thrown.logRecords.some((record) => record.msg === 'Plugin operation action failed'),
    true,
  );
  assert.equal(JSON.stringify(thrown.logRecords).includes('must-not-log'), false);
  assert.equal(JSON.stringify(thrown.logRecords).includes('must-not-log-header'), false);
  assert.equal(JSON.stringify(thrown.logRecords).includes('private-stack'), false);

  const longThrown = await harness({ generate: 'longthrows' });
  const bounded = await inject(longThrown.app, {
    method: 'POST',
    url: `/api/plugins/${pluginId}/actions/qr_login/generate`,
    headers: auth,
  });
  assert.equal(bounded.statusCode, 502);
  assert.equal(bounded.json().error, `Action failed: ${'x'.repeat(200)}`);
});

test('declared test route requires a direct local owner session before invoking a package', async () => {
  const h = await harness();
  const url = `/api/plugins/${pluginId}/test`;
  const anonymous = await inject(h.app, { method: 'POST', url, headers: localHeaders });
  assert.equal(anonymous.statusCode, 401, anonymous.payload);
  const remote = await h.app.inject({ method: 'POST', url, headers: auth, remoteAddress: '203.0.113.9' });
  assert.equal(remote.statusCode, 403, remote.payload);
  assert.deepEqual(h.calls, []);
});

test('declared test route retains installed and enabled checks', async () => {
  const disabled = await harness({ enabled: false });
  const stopped = await inject(disabled.app, { method: 'POST', url: `/api/plugins/${pluginId}/test`, headers: auth });
  assert.equal(stopped.statusCode, 409, stopped.payload);
  assert.deepEqual(disabled.calls, []);
  const missing = await harness({ installed: false });
  const absent = await inject(missing.app, { method: 'POST', url: `/api/plugins/${pluginId}/test`, headers: auth });
  assert.equal(absent.statusCode, 404, absent.payload);
  assert.deepEqual(missing.calls, []);
});

test('loaded settings run before enable without restoring previous action output', async () => {
  const current = snapshot({ enabled: false });
  let state;
  let started = 0;
  const calls = [];
  const completed = [];
  const operations = new InstalledPluginOperations({
    inventory: { snapshot: async () => structuredClone(current) },
    invocation: {
      invoke: async () => {
        started++;
        throw new Error('runtime must remain stopped');
      },
    },
    settingsInvocation: async ({ method, params, assertCurrent }) => {
      await assertCurrent();
      calls.push({ method, params });
      return {
        handled: true,
        result:
          method === 'qr.generate'
            ? { render: 'img', data: { url: 'data:image/png;base64,abc', qrPayload: 'persistent-challenge' } }
            : { render: 'status', data: { status: 'confirmed' }, targetValues: { BOT_TOKEN: 'new-token' } },
      };
    },
    configuration: {
      readActionInput: async () => ({}),
      readOperationState: async () => state,
      writeOperationState: async (_p, _k, next) => {
        state = structuredClone(next);
      },
      clearOperationState: async () => {},
      configureOperationTargets: async () => ['BOT_TOKEN'],
      completeOperation: async (...args) => completed.push(args),
    },
  });
  assert.equal((await operations.runAction(pluginId, 'qr_login', 'generate', {})).status, 200);
  assert.equal((await operations.runAction(pluginId, 'qr_login', 'status', {})).status, 200);
  assert.equal(calls[1].params.operationState.lastResult, undefined);
  assert.equal(JSON.stringify(state).includes('persistent-challenge'), false);
  assert.equal(started, 0);
  assert.equal(current.instances[0].activationState, 'disabled');
  assert.equal(completed.length, 1);
});

for (const confirmed of [undefined, 'false', 'true']) {
  test(`declared confirmation requires authenticated carrier marker (${confirmed})`, async () => {
    const h = await harness({ confirmation: true });
    const result = await inject(h.app, {
      method: 'POST',
      url: `/api/plugins/${pluginId}/actions/qr_login/generate`,
      headers: { ...auth, ...(confirmed ? { 'x-cat-cafe-owner-confirmed': confirmed } : {}) },
      payload: {},
    });
    assert.equal(result.statusCode, confirmed === 'true' ? 200 : 400);
    assert.equal(h.calls.length, confirmed === 'true' ? 1 : 0);
    if (confirmed !== 'true') assert.equal(h.state, undefined);
  });
}
