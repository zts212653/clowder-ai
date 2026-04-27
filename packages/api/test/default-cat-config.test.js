import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import {
  clearRuntimeDefaultCatId,
  getDefaultCatId,
  getOwnerUserId,
  hasRuntimeDefaultCatOverride,
  loadCatConfig,
  setRuntimeDefaultCatId,
  toAllCatConfigs,
} from '../dist/config/cat-config-loader.js';

const REPO_TEMPLATE_PATH = fileURLToPath(new URL('../../../cat-template.json', import.meta.url));
const _allConfigs = toAllCatConfigs(loadCatConfig(REPO_TEMPLATE_PATH));

describe('getDefaultCatId runtime override (F154 AC-A4)', () => {
  let originalDefault;
  before(() => {
    originalDefault = getDefaultCatId();
  });
  after(() => {
    clearRuntimeDefaultCatId();
  });

  it('returns breeds[0] by default', () => {
    const id = getDefaultCatId();
    assert.ok(id, 'should return a catId');
    assert.equal(id, originalDefault);
  });

  it('returns runtime override when set', () => {
    setRuntimeDefaultCatId('codex');
    assert.equal(getDefaultCatId(), 'codex');
  });

  it('falls back to breeds[0] after clear', () => {
    setRuntimeDefaultCatId('codex');
    clearRuntimeDefaultCatId();
    assert.equal(getDefaultCatId(), originalDefault);
  });

  it('setRuntimeDefaultCatId overwrites previous override', () => {
    setRuntimeDefaultCatId('codex');
    setRuntimeDefaultCatId('gemini');
    assert.equal(getDefaultCatId(), 'gemini');
    clearRuntimeDefaultCatId();
  });

  it('ignores runtime override when the cat is unavailable', () => {
    catRegistry.reset();
    catRegistry.register('opus', _allConfigs.opus);
    catRegistry.register('antigravity', _allConfigs.antigravity);
    setRuntimeDefaultCatId('antigravity');

    assert.notEqual(getDefaultCatId(), 'antigravity', 'should not use unavailable runtime override');
    assert.equal(hasRuntimeDefaultCatOverride(), false, 'unavailable runtime override should not be reported active');

    clearRuntimeDefaultCatId();
    catRegistry.reset();
  });
});

describe('getOwnerUserId fallback', () => {
  it('returns DEFAULT_OWNER_USER_ID when set', () => {
    const orig = process.env.DEFAULT_OWNER_USER_ID;
    try {
      process.env.DEFAULT_OWNER_USER_ID = 'you';
      assert.equal(getOwnerUserId(), 'you');
    } finally {
      if (orig === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = orig;
    }
  });

  it('falls back to default-user when env not set', () => {
    const orig = process.env.DEFAULT_OWNER_USER_ID;
    try {
      delete process.env.DEFAULT_OWNER_USER_ID;
      assert.equal(getOwnerUserId(), 'default-user');
    } finally {
      if (orig !== undefined) process.env.DEFAULT_OWNER_USER_ID = orig;
    }
  });
});

describe('PUT /api/config/default-cat works without DEFAULT_OWNER_USER_ID', () => {
  let app;

  before(async () => {
    catRegistry.reset();
    catRegistry.register('opus', _allConfigs.opus);
    catRegistry.register('codex', _allConfigs.codex);
    delete process.env.DEFAULT_OWNER_USER_ID;
    clearRuntimeDefaultCatId();
    const { configRoutes } = await import('../dist/routes/config.js');
    app = Fastify();
    await app.register(configRoutes);
    await app.ready();
  });

  after(async () => {
    clearRuntimeDefaultCatId();
    catRegistry.reset();
    await app?.close();
  });

  it('default-user can change default cat when env not configured', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { catId: 'codex' },
    });
    assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}: ${res.payload}`);
    assert.equal(getDefaultCatId(), 'codex');
    clearRuntimeDefaultCatId();
  });
});

describe('getDefaultCatId reads DEFAULT_CAT_ID env (clowder-ai#543)', () => {
  after(() => {
    clearRuntimeDefaultCatId();
    delete process.env.DEFAULT_CAT_ID;
  });

  it('returns DEFAULT_CAT_ID when set and no runtime override', () => {
    clearRuntimeDefaultCatId();
    process.env.DEFAULT_CAT_ID = 'gemini';
    assert.equal(getDefaultCatId(), 'gemini');
    delete process.env.DEFAULT_CAT_ID;
  });

  it('runtime override takes priority over DEFAULT_CAT_ID env', () => {
    process.env.DEFAULT_CAT_ID = 'gemini';
    setRuntimeDefaultCatId('codex');
    assert.equal(getDefaultCatId(), 'codex');
    clearRuntimeDefaultCatId();
    delete process.env.DEFAULT_CAT_ID;
  });

  it('ignores DEFAULT_CAT_ID when it references an unknown cat', () => {
    clearRuntimeDefaultCatId();
    catRegistry.reset();
    catRegistry.register('opus', _allConfigs.opus);
    catRegistry.register('codex', _allConfigs.codex);
    process.env.DEFAULT_CAT_ID = 'not-a-cat';
    const result = getDefaultCatId();
    assert.notEqual(result, 'not-a-cat', 'should not return unknown catId from env');
    delete process.env.DEFAULT_CAT_ID;
    catRegistry.reset();
  });

  it('ignores DEFAULT_CAT_ID when the cat is unavailable', () => {
    clearRuntimeDefaultCatId();
    catRegistry.reset();
    catRegistry.register('opus', _allConfigs.opus);
    catRegistry.register('antigravity', _allConfigs.antigravity);
    process.env.DEFAULT_CAT_ID = 'antigravity';

    assert.notEqual(getDefaultCatId(), 'antigravity', 'should not use unavailable env default');

    delete process.env.DEFAULT_CAT_ID;
    catRegistry.reset();
  });
});

describe('PUT /api/config/default-cat persists to .env (clowder-ai#543)', () => {
  let app;
  const OWNER_ID = 'persist-test-owner';
  let tmpEnvPath;

  before(async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const tmpDir = mkdtempSync(join(await import('node:os').then((m) => m.tmpdir()), 'cat-env-'));
    tmpEnvPath = join(tmpDir, '.env');
    writeFileSync(tmpEnvPath, '', 'utf8');

    catRegistry.reset();
    catRegistry.register('opus', _allConfigs.opus);
    catRegistry.register('codex', _allConfigs.codex);
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    clearRuntimeDefaultCatId();
    const { configRoutes } = await import('../dist/routes/config.js');
    app = Fastify();
    await app.register(configRoutes, { envFilePath: tmpEnvPath });
    await app.ready();
  });

  after(async () => {
    clearRuntimeDefaultCatId();
    catRegistry.reset();
    delete process.env.DEFAULT_OWNER_USER_ID;
    delete process.env.DEFAULT_CAT_ID;
    await app?.close();
  });

  it('PUT writes DEFAULT_CAT_ID to .env file', async () => {
    const { readFileSync } = await import('node:fs');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'codex' },
    });
    assert.equal(res.statusCode, 200);
    const envContent = readFileSync(tmpEnvPath, 'utf8');
    assert.ok(envContent.includes('DEFAULT_CAT_ID=codex'), `expected DEFAULT_CAT_ID=codex in .env, got: ${envContent}`);
  });

  it('PUT with null removes DEFAULT_CAT_ID from .env', async () => {
    const { readFileSync } = await import('node:fs');
    await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'codex' },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: null },
    });
    assert.equal(res.statusCode, 200);
    const envContent = readFileSync(tmpEnvPath, 'utf8');
    assert.ok(!envContent.includes('DEFAULT_CAT_ID'), `expected no DEFAULT_CAT_ID in .env, got: ${envContent}`);
  });
});

describe('PUT /api/config/default-cat atomicity (cloud review P1)', () => {
  let app;
  const OWNER_ID = 'atomicity-test-owner';

  before(async () => {
    catRegistry.reset();
    catRegistry.register('opus', _allConfigs.opus);
    catRegistry.register('codex', _allConfigs.codex);
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    clearRuntimeDefaultCatId();
    const { configRoutes } = await import('../dist/routes/config.js');
    app = Fastify();
    // Point envFilePath to a non-existent directory → writeFileSync will throw
    await app.register(configRoutes, { envFilePath: '/nonexistent-dir/no-such/.env' });
    await app.ready();
  });

  after(async () => {
    clearRuntimeDefaultCatId();
    catRegistry.reset();
    delete process.env.DEFAULT_OWNER_USER_ID;
    await app?.close();
  });

  it('does not mutate runtime state when persist fails', async () => {
    const before = getDefaultCatId();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'codex' },
    });
    assert.ok(res.statusCode >= 500, `expected 5xx but got ${res.statusCode}`);
    assert.equal(getDefaultCatId(), before, 'runtime default should not change when persist fails');
  });

  it('does not mutate runtime state when clearing with persist failure', async () => {
    setRuntimeDefaultCatId('codex');
    const before = getDefaultCatId();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: null },
    });
    assert.ok(res.statusCode >= 500, `expected 5xx but got ${res.statusCode}`);
    assert.equal(getDefaultCatId(), before, 'runtime default should not change when persist fails');
    clearRuntimeDefaultCatId();
  });
});

describe('GET/PUT /api/config/default-cat (F154 AC-A4)', () => {
  let app;
  const OWNER_ID = 'test-owner-123';

  before(async () => {
    // Register cats so catRegistry.has() validation works
    catRegistry.reset();
    catRegistry.register('opus', _allConfigs.opus);
    catRegistry.register('codex', _allConfigs.codex);
    catRegistry.register('antigravity', _allConfigs.antigravity);
    // Set DEFAULT_OWNER_USER_ID for owner gate
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    clearRuntimeDefaultCatId();
    const { configRoutes } = await import('../dist/routes/config.js');
    app = Fastify();
    await app.register(configRoutes);
    await app.ready();
  });

  after(async () => {
    clearRuntimeDefaultCatId();
    catRegistry.reset();
    delete process.env.DEFAULT_OWNER_USER_ID;
    await app?.close();
  });

  it('GET returns current default cat', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/default-cat' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.catId, 'should return catId');
    assert.equal(body.isOverride, false);
  });

  it('PUT by owner sets default cat → 200', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'codex' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(getDefaultCatId(), 'codex');
  });

  it('GET reflects override after PUT', async () => {
    setRuntimeDefaultCatId('codex');
    const res = await app.inject({ method: 'GET', url: '/api/config/default-cat' });
    const body = JSON.parse(res.payload);
    assert.equal(body.catId, 'codex');
    assert.equal(body.isOverride, true);
    clearRuntimeDefaultCatId();
  });

  it('PUT by non-owner → 403', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      headers: { 'x-cat-cafe-user': 'guest-user' },
      payload: { catId: 'codex' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('PUT without user header → 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      payload: { catId: 'codex' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('PUT rejects unavailable catId → 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: 'antigravity' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.payload, /unavailable/i);
    assert.notEqual(getDefaultCatId(), 'antigravity');
  });

  it('PUT with empty catId → clears override', async () => {
    setRuntimeDefaultCatId('codex');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/default-cat',
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { catId: null },
    });
    assert.equal(res.statusCode, 200);
    // Should fall back to breeds[0]
    assert.notEqual(getDefaultCatId(), 'codex');
  });
});
