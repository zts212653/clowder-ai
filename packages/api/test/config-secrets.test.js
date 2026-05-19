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

const OWNER_ID = 'owner-1';
const SESSION_HEADERS = { 'x-test-session-user': OWNER_ID };
const TRUSTED_HEADER_ONLY = { 'x-cat-cafe-user': OWNER_ID };
const ORIGINAL_OWNER_ID = process.env.DEFAULT_OWNER_USER_ID;

describe('POST /api/config/secrets', () => {
  let app;
  let tmpDir;
  let envFilePath;
  /** @type {import('../dist/config/config-event-bus.js').ConfigChangeEvent[]} */
  let captured;
  /** @type {Array<{type:string,data:Record<string, unknown>}>} */
  let auditEvents;
  let unsub;

  before(async () => {
    app = Fastify();
    app.addHook('preHandler', async (request) => {
      const sessionUser = request.headers['x-test-session-user'];
      if (typeof sessionUser === 'string' && sessionUser.trim()) {
        request.sessionUserId = sessionUser.trim();
      }
    });
    tmpDir = mkdtempSync(join(os.tmpdir(), 'secrets-test-'));
    envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'EXISTING_VAR=hello\n');
    await app.register(configSecretsRoutes, {
      envFilePath,
      auditLog: {
        append: async (input) => {
          auditEvents.push({ type: input.type, data: input.data });
          return { id: 'audit-test-id' };
        },
      },
    });
    await app.ready();
  });

  beforeEach(() => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    captured = [];
    auditEvents = [];
    unsub = configEventBus.onConfigChange((e) => captured.push(e));
    // Reset env vars that tests may set
    for (const key of [
      'TELEGRAM_BOT_TOKEN',
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'DINGTALK_APP_KEY',
      'DINGTALK_APP_SECRET',
      'VAPID_PUBLIC_KEY',
      'VAPID_PRIVATE_KEY',
      'VAPID_SUBJECT',
      'GITHUB_TOKEN',
      'GITHUB_SETUP_NOISE_BOT_LOGINS',
      'GITHUB_MCP_PAT',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (ORIGINAL_OWNER_ID === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = ORIGINAL_OWNER_ID;
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
      headers: SESSION_HEADERS,
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
      headers: SESSION_HEADERS,
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
      headers: SESSION_HEADERS,
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
      headers: SESSION_HEADERS,
      payload: { updates: [{ name: 'OPENAI_API_KEY', value: 'sk-bad' }] },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('not in connector secrets allowlist'));
  });

  it('rejects when no session identity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      payload: { updates: [{ name: 'TELEGRAM_BOT_TOKEN', value: 'x' }] },
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Identity required'));
  });

  it('rejects trusted header identity without a real session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: TRUSTED_HEADER_ONLY,
      payload: { updates: [{ name: 'FEISHU_APP_ID', value: 'cli_header_only' }] },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(process.env.FEISHU_APP_ID, undefined);
  });

  it('fails closed when DEFAULT_OWNER_USER_ID is not configured', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: SESSION_HEADERS,
      payload: { updates: [{ name: 'FEISHU_APP_ID', value: 'cli_no_owner' }] },
    });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /DEFAULT_OWNER_USER_ID/);
    assert.equal(process.env.FEISHU_APP_ID, undefined);
  });

  it('rejects non-owner sessions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: { 'x-test-session-user': 'not-owner' },
      payload: { updates: [{ name: 'FEISHU_APP_ID', value: 'cli_not_owner' }] },
    });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /configured owner/);
    assert.equal(process.env.FEISHU_APP_ID, undefined);
  });

  it('rejects redacted placeholder values', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: SESSION_HEADERS,
      payload: { updates: [{ name: 'FEISHU_APP_SECRET', value: '••••••' }] },
    });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /redacted/i);
    assert.equal(process.env.FEISHU_APP_SECRET, undefined);
  });

  it('preserves omitted secrets during partial edits', async () => {
    process.env.FEISHU_APP_SECRET = 'sec_keep';
    writeFileSync(envFilePath, 'FEISHU_APP_SECRET=sec_keep\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: SESSION_HEADERS,
      payload: { updates: [{ name: 'FEISHU_APP_ID', value: 'cli_partial' }] },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(process.env.FEISHU_APP_ID, 'cli_partial');
    assert.equal(process.env.FEISHU_APP_SECRET, 'sec_keep');
    const envContent = readFileSync(envFilePath, 'utf8');
    assert.match(envContent, /FEISHU_APP_ID=cli_partial/);
    assert.match(envContent, /FEISHU_APP_SECRET=sec_keep/);
  });

  it('writes VAPID env vars and keeps audit metadata-only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: SESSION_HEADERS,
      payload: {
        updates: [
          { name: 'VAPID_PUBLIC_KEY', value: 'vapid-public-new' },
          { name: 'VAPID_PRIVATE_KEY', value: 'vapid-private-new' },
          { name: 'VAPID_SUBJECT', value: 'mailto:owner@example.com' },
        ],
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(process.env.VAPID_PUBLIC_KEY, 'vapid-public-new');
    assert.equal(process.env.VAPID_PRIVATE_KEY, 'vapid-private-new');
    assert.equal(process.env.VAPID_SUBJECT, 'mailto:owner@example.com');

    const envContent = readFileSync(envFilePath, 'utf8');
    assert.match(envContent, /VAPID_PUBLIC_KEY=vapid-public-new/);
    assert.match(envContent, /VAPID_PRIVATE_KEY=vapid-private-new/);
    assert.match(envContent, /VAPID_SUBJECT=mailto:owner@example.com/);

    const auditJson = JSON.stringify(auditEvents);
    assert.match(auditJson, /VAPID_PUBLIC_KEY/);
    assert.doesNotMatch(auditJson, /vapid-public-new|vapid-private-new|owner@example\.com/);
  });

  it('preserves omitted VAPID private key during contact-only edits', async () => {
    process.env.VAPID_PRIVATE_KEY = 'vapid-private-keep';
    writeFileSync(envFilePath, 'VAPID_PRIVATE_KEY=vapid-private-keep\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: SESSION_HEADERS,
      payload: { updates: [{ name: 'VAPID_SUBJECT', value: 'mailto:new-owner@example.com' }] },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(process.env.VAPID_SUBJECT, 'mailto:new-owner@example.com');
    assert.equal(process.env.VAPID_PRIVATE_KEY, 'vapid-private-keep');
    const envContent = readFileSync(envFilePath, 'utf8');
    assert.match(envContent, /VAPID_SUBJECT=mailto:new-owner@example.com/);
    assert.match(envContent, /VAPID_PRIVATE_KEY=vapid-private-keep/);
  });

  it('rejects invalid VAPID_SUBJECT before writing env or audit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: SESSION_HEADERS,
      payload: { updates: [{ name: 'VAPID_SUBJECT', value: 'owner@example.com' }] },
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /VAPID_SUBJECT/i);
    assert.equal(process.env.VAPID_SUBJECT, undefined);
    assert.equal(captured.length, 0);
    assert.deepEqual(auditEvents, []);
  });

  it('rejects redacted VAPID placeholder values', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: SESSION_HEADERS,
      payload: { updates: [{ name: 'VAPID_PRIVATE_KEY', value: '••••••' }] },
    });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /redacted/i);
    assert.equal(process.env.VAPID_PRIVATE_KEY, undefined);
  });

  it('writes GitHub plugin config keys and keeps audit metadata-only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: SESSION_HEADERS,
      payload: {
        updates: [
          { name: 'GITHUB_TOKEN', value: 'ghp_new_token' },
          { name: 'GITHUB_SETUP_NOISE_BOT_LOGINS', value: 'chatgpt-codex-connector[bot]' },
          { name: 'GITHUB_MCP_PAT', value: 'ghp_mcp_token' },
        ],
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(process.env.GITHUB_TOKEN, 'ghp_new_token');
    assert.equal(process.env.GITHUB_SETUP_NOISE_BOT_LOGINS, 'chatgpt-codex-connector[bot]');
    assert.equal(process.env.GITHUB_MCP_PAT, 'ghp_mcp_token');

    const envContent = readFileSync(envFilePath, 'utf8');
    assert.match(envContent, /GITHUB_TOKEN=ghp_new_token/);
    assert.match(envContent, /GITHUB_SETUP_NOISE_BOT_LOGINS="?chatgpt-codex-connector\[bot\]"?/);
    assert.match(envContent, /GITHUB_MCP_PAT=ghp_mcp_token/);

    const auditJson = JSON.stringify(auditEvents);
    assert.match(auditJson, /GITHUB_TOKEN/);
    assert.match(auditJson, /GITHUB_SETUP_NOISE_BOT_LOGINS/);
    assert.match(auditJson, /GITHUB_MCP_PAT/);
    assert.doesNotMatch(auditJson, /ghp_new_token|ghp_mcp_token|chatgpt-codex-connector/);
  });

  it('emits ConfigChangeEvent with source=secrets', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: SESSION_HEADERS,
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
      headers: SESSION_HEADERS,
      payload: { updates: [{ name: 'DINGTALK_APP_KEY', value: 'existing-key' }] },
    });
    assert.equal(captured.length, 0, 'no event for no-op');
  });

  it('handles multiple keys in one request', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/config/secrets',
      headers: SESSION_HEADERS,
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
      headers: SESSION_HEADERS,
      payload: { updates: [{ name: 'DINGTALK_APP_SECRET', value: null }] },
    });
    assert.equal(process.env.DINGTALK_APP_SECRET, undefined);
  });
});
