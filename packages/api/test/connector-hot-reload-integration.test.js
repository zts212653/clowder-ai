/**
 * F136 Phase 2: End-to-end hot reload integration test
 *
 * POST /api/config/secrets → ConfigChangeEvent → subscriber → onRestart callback.
 * Validates the full wiring without real adapters.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { restartConnectorGateway } from '../dist/infrastructure/connectors/connector-gateway-lifecycle.js';
import { createConnectorReloadSubscriber } from '../dist/infrastructure/connectors/connector-reload-subscriber.js';
import { configSecretsRoutes } from '../dist/routes/config-secrets.js';

const VALID_TELEGRAM_TOKEN = '123456:hot_reload_token';

describe('F136 Phase 2 integration: secrets → event → reload', () => {
  let app;
  let tmpDir;
  let envFilePath;
  let restartCalls;
  let subscriber;

  before(async () => {
    app = Fastify();
    tmpDir = mkdtempSync(join(os.tmpdir(), 'hotreload-int-'));
    envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, '');
    await app.register(configSecretsRoutes, { envFilePath });
    await app.ready();

    restartCalls = [];
    subscriber = createConnectorReloadSubscriber({
      onRestart: async () => {
        restartCalls.push(Date.now());
      },
      debounceMs: 30,
      log: { info() {}, warn() {} },
    });
  });

  afterEach(() => {
    restartCalls.length = 0;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.FEISHU_APP_ID;
  });

  after(async () => {
    subscriber?.unsubscribe();
    await app?.close();
  });

  it('single secret write triggers exactly one restart', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'integrator' },
      payload: { updates: [{ name: 'TELEGRAM_BOT_TOKEN', value: VALID_TELEGRAM_TOKEN }] },
    });
    assert.equal(res.statusCode, 200);

    // Wait for debounce + execution
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(restartCalls.length, 1);
  });

  it('batch write (2 keys) triggers exactly one restart', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'integrator' },
      payload: {
        updates: [
          { name: 'FEISHU_APP_ID', value: 'cli_int' },
          { name: 'TELEGRAM_BOT_TOKEN', value: VALID_TELEGRAM_TOKEN },
        ],
      },
    });
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(restartCalls.length, 1);
  });

  it('self-healing: restart works when initial gateway handle was null (P1-2)', async () => {
    // Simulates the scenario where initial startup failed (handle = null)
    // but user fixes config via secrets endpoint → subscriber triggers restart
    let healedHandle = null;
    let currentHandle = null; // null = initial startup failed
    const healingSub = createConnectorReloadSubscriber({
      onRestart: async () => {
        const newHandle = await restartConnectorGateway(currentHandle, async () => ({
          stop: async () => {},
          outboundHook: () => {},
          streamingHook: () => {},
          webhookHandlers: new Map(),
        }));
        if (newHandle) {
          currentHandle = newHandle;
          healedHandle = newHandle;
        }
      },
      debounceMs: 10,
      log: { info() {}, warn() {} },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'integrator' },
      payload: { updates: [{ name: 'DINGTALK_APP_KEY', value: 'healed-key' }] },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 80));
    assert.ok(healedHandle, 'gateway self-healed from null initial handle');
    assert.ok(currentHandle === healedHandle, 'handle was updated');

    healingSub.unsubscribe();
    delete process.env.DINGTALK_APP_KEY;
  });

  it('no-op write does not trigger restart', async () => {
    process.env.TELEGRAM_BOT_TOKEN = VALID_TELEGRAM_TOKEN;
    // Write same value into .env so file also matches
    writeFileSync(envFilePath, `TELEGRAM_BOT_TOKEN=${VALID_TELEGRAM_TOKEN}\n`);

    await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'integrator' },
      payload: { updates: [{ name: 'TELEGRAM_BOT_TOKEN', value: VALID_TELEGRAM_TOKEN }] },
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(restartCalls.length, 0, 'no restart for no-op');
  });
});
