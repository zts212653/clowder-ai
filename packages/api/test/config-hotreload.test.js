/**
 * Config Hot-Reload Tests (F4)
 * PATCH /api/config — hot-update configuration
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { configStore } from '../dist/config/ConfigStore.js';
import { configRoutes } from '../dist/routes/config.js';

describe('PATCH /api/config (F4 hot-reload)', () => {
  let app;

  afterEach(async () => {
    configStore.reset();
    if (app) await app.close();
  });

  async function setup(routeOptions = {}, options = {}) {
    app = Fastify();
    const warnSink = Array.isArray(options.warnSink) ? options.warnSink : null;
    if (warnSink) {
      app.addHook('onRequest', (request, _reply, done) => {
        const originalWarn = request.log.warn.bind(request.log);
        request.log.warn = (...args) => {
          warnSink.push(args);
          return originalWarn(...args);
        };
        done();
      });
    }
    await app.register(configRoutes, routeOptions);
    await app.ready();
    return app;
  }

  async function patchConfig(payload, headers = {}) {
    return app.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: { 'x-cat-cafe-user': 'config-admin', ...headers },
      payload,
    });
  }

  it('sets an updatable key and returns updated config', async () => {
    const _app = await setup();

    const res = await patchConfig({ key: 'cli.timeoutMs', value: 60000 });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.config);
    assert.equal(body.config.cli.timeoutMs, 60000);
  });

  it('verifies PATCH value is reflected in GET', async () => {
    const app = await setup();

    await patchConfig({ key: 'a2a.maxDepth', value: '5' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
    });
    const body = res.json();
    assert.equal(body.config.a2a.maxDepth, 5);
  });

  it('supports hot-updating codex sandbox/approval policy keys', async () => {
    const app = await setup();

    await patchConfig({ key: 'cli.codexSandboxMode', value: 'workspace-write' });
    await patchConfig({ key: 'cli.codexApprovalPolicy', value: 'never' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
    });
    const body = res.json();
    assert.equal(body.config.cli.codexSandboxMode, 'workspace-write');
    assert.equal(body.config.cli.codexApprovalPolicy, 'never');
  });

  it('supports hot-updating codex execution model alignment keys', async () => {
    const app = await setup();

    const patchModel = await patchConfig({ key: 'codex.execution.model', value: 'gpt-5.3-codex' });
    assert.equal(patchModel.statusCode, 200);

    const patchPassModelArg = await patchConfig({ key: 'codex.execution.passModelArg', value: false });
    assert.equal(patchPassModelArg.statusCode, 200);

    const patchAuthMode = await patchConfig({ key: 'codex.execution.authMode', value: 'oauth' });
    assert.equal(patchAuthMode.statusCode, 200);

    const res = await app.inject({ method: 'GET', url: '/api/config' });
    const body = res.json();
    assert.equal(body.config.codexExecution.model, 'gpt-5.3-codex');
    assert.equal(body.config.codexExecution.passModelArg, false);
    assert.equal(body.config.codexExecution.authMode, 'oauth');
  });

  it('writes config patch audit event with old/new/operator', async () => {
    const auditCalls = [];
    const _app = await setup({
      auditLog: {
        append: async (input) => {
          auditCalls.push(input);
          return { id: 'evt-1', timestamp: Date.now(), ...input };
        },
      },
    });

    const res = await patchConfig({ key: 'cli.timeoutMs', value: 60000 }, { 'x-cat-cafe-user': 'user-1' });

    assert.equal(res.statusCode, 200);
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].type, 'config_updated');
    assert.equal(auditCalls[0].data.key, 'cli.timeoutMs');
    assert.equal(auditCalls[0].data.operator, 'user-1');
    assert.equal(auditCalls[0].data.oldValue, 1800000);
    assert.equal(auditCalls[0].data.newValue, 60000);
  });

  it('rejects patch without x-cat-cafe-user header', async () => {
    const app = await setup();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { key: 'cli.timeoutMs', value: 60000 },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, 'Identity required (X-Cat-Cafe-User header)');

    const configRes = await app.inject({
      method: 'GET',
      url: '/api/config',
    });
    assert.equal(configRes.statusCode, 200);
    const configBody = configRes.json();
    assert.equal(configBody.config.cli.timeoutMs, 1800000);
  });

  it('logs warn for high-risk key updates', async () => {
    const warnSink = [];
    const _app = await setup({}, { warnSink });

    const res = await patchConfig({ key: 'codex.execution.model', value: 'gpt-5.3-codex' });
    assert.equal(res.statusCode, 200);
    assert.equal(warnSink.length > 0, true);
    const [firstWarnArg] = warnSink[0];
    assert.equal(firstWarnArg.key, 'codex.execution.model');
  });

  it('rejects non-updatable key with 400', async () => {
    const _app = await setup();

    const res = await patchConfig({ key: 'server.port', value: 9999 });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error.includes('not hot-updatable'));
  });

  it('rejects missing key with 400', async () => {
    const _app = await setup();

    const res = await patchConfig({ value: 123 });
    assert.equal(res.statusCode, 400);
  });

  it('rejects missing value with 400', async () => {
    const _app = await setup();

    const res = await patchConfig({ key: 'cli.timeoutMs' });
    assert.equal(res.statusCode, 400);
  });

  it('keeps updatable keys and snapshot paths in sync', async () => {
    const keys = Object.keys(configStore.listUpdatable());
    assert.equal(keys.length > 0, true);
    for (const key of keys) {
      assert.ok(configStore.getSnapshotPath(key), `missing snapshot path for ${key}`);
    }
  });
});
