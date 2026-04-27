/**
 * F136 Phase 2: POST /api/config/secrets endpoint tests
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { configEventBus } from '../dist/config/config-event-bus.js';
import { configSecretsRoutes } from '../dist/routes/config-secrets.js';

describe('POST /api/config/secrets', () => {
  let app;
  let tmpDir;
  let envFilePath;
  /** @type {import('../dist/config/config-event-bus.js').ConfigChangeEvent[]} */
  let captured;
  let unsub;

  before(async () => {
    app = Fastify();
    tmpDir = mkdtempSync(join(os.tmpdir(), 'secrets-test-'));
    envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'EXISTING_VAR=hello\n');
    await app.register(configSecretsRoutes, { envFilePath });
    await app.ready();
  });

  beforeEach(() => {
    captured = [];
    unsub = configEventBus.onConfigChange((e) => captured.push(e));
    // Reset env vars that tests may set
    for (const key of [
      'TELEGRAM_BOT_TOKEN',
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'DINGTALK_APP_KEY',
      'DINGTALK_APP_SECRET',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    unsub?.();
    unsub = undefined;
  });

  after(async () => {
    await app?.close();
  });

  it('writes allowed connector var to .env and process.env', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { updates: [{ name: 'TELEGRAM_BOT_TOKEN', value: '123456:ABCDEF_token' }] },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, '123456:ABCDEF_token');

    const envContent = readFileSync(envFilePath, 'utf8');
    assert.ok(envContent.includes('TELEGRAM_BOT_TOKEN=123456:ABCDEF_token'));
  });

  it('rejects API keys accidentally submitted as TELEGRAM_BOT_TOKEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { updates: [{ name: 'TELEGRAM_BOT_TOKEN', value: 'sk-community-openai-api-key' }] },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('TELEGRAM_BOT_TOKEN'));
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, undefined);
  });

  it('rejects too-short Telegram-looking tokens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { updates: [{ name: 'TELEGRAM_BOT_TOKEN', value: '123456:ABCDEFGH' }] },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('TELEGRAM_BOT_TOKEN'));
  });

  it('rejects non-allowlist var with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { updates: [{ name: 'OPENAI_API_KEY', value: 'sk-bad' }] },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('not in connector secrets allowlist'));
  });

  it('rejects when no identity header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      payload: { updates: [{ name: 'TELEGRAM_BOT_TOKEN', value: 'x' }] },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Identity required'));
  });

  it('emits ConfigChangeEvent with source=secrets', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { updates: [{ name: 'FEISHU_APP_ID', value: 'cli_abc' }] },
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].source, 'secrets');
    assert.equal(captured[0].scope, 'key');
    assert.deepEqual(captured[0].changedKeys, ['FEISHU_APP_ID']);
  });

  it('no-op: same value does not emit event', async () => {
    process.env.DINGTALK_APP_KEY = 'existing-key';
    await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { updates: [{ name: 'DINGTALK_APP_KEY', value: 'existing-key' }] },
    });
    assert.equal(captured.length, 0, 'no event for no-op');
  });

  it('handles multiple keys in one request', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        updates: [
          { name: 'FEISHU_APP_ID', value: 'cli_xyz' },
          { name: 'FEISHU_APP_SECRET', value: 'sec_xyz' },
        ],
      },
    });
    assert.equal(process.env.FEISHU_APP_ID, 'cli_xyz');
    assert.equal(process.env.FEISHU_APP_SECRET, 'sec_xyz');
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].changedKeys.sort(), ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  });

  it('deletes var when value is null', async () => {
    process.env.DINGTALK_APP_SECRET = 'to-delete';
    await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { updates: [{ name: 'DINGTALK_APP_SECRET', value: null }] },
    });
    assert.equal(process.env.DINGTALK_APP_SECRET, undefined);
  });
});
