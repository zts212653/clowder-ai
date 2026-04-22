import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import {
  _resetCachedConfig,
  clearRuntimeDefaultCatId,
  getDefaultCatId,
  getOwnerUserId,
  hasRuntimeDefaultCatOverride,
  loadCatConfig,
  setRuntimeDefaultCatId,
  toAllCatConfigs,
} from '../dist/config/cat-config-loader.js';

const _allConfigs = toAllCatConfigs(loadCatConfig());

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

  it('skips stale catId not present in loaded config (#543 P1)', () => {
    // Set an override to a catId that doesn't exist in any breed/variant
    setRuntimeDefaultCatId('nonexistent-cat-xyz');
    // Should fall through to breeds[0] default, not return the stale catId
    const result = getDefaultCatId();
    assert.notEqual(result, 'nonexistent-cat-xyz', 'stale catId should be skipped');
    assert.equal(result, originalDefault, 'should fall back to breeds[0]');
    clearRuntimeDefaultCatId();
  });

  it('hasRuntimeDefaultCatOverride returns false for stale catId (#543 P1)', () => {
    setRuntimeDefaultCatId('nonexistent-cat-xyz');
    assert.equal(hasRuntimeDefaultCatOverride(), false, 'stale catId should not count as active override');
    clearRuntimeDefaultCatId();
  });

  it('setRuntimeDefaultCatId returns persisted status (#543 P2)', () => {
    const result = setRuntimeDefaultCatId('codex');
    assert.equal(typeof result.persisted, 'boolean', 'should return { persisted: boolean }');
    clearRuntimeDefaultCatId();
  });

  it('API-set override is trusted when config cache is unavailable (#543 degraded)', () => {
    const origPath = process.env.CAT_TEMPLATE_PATH;
    try {
      // Point to non-existent template → getCachedConfig() returns null (degraded mode)
      process.env.CAT_TEMPLATE_PATH = '/tmp/__nonexistent_cat_template__.json';
      _resetCachedConfig();
      // API sets override AFTER config is degraded (real scenario: server starts broken,
      // then owner writes override via PUT which passes catRegistry validation at route level)
      setRuntimeDefaultCatId('codex');
      // API-validated override should still be returned in degraded mode
      const result = getDefaultCatId();
      assert.equal(result, 'codex', 'API-set override should be trusted in degraded mode');
    } finally {
      if (origPath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = origPath;
      clearRuntimeDefaultCatId();
      _resetCachedConfig();
    }
  });

  it('disk-loaded override is rejected when config cache is unavailable (#543 degraded)', () => {
    const origPath = process.env.CAT_TEMPLATE_PATH;
    const overrideDir = '/tmp/.cat-cafe';
    const overrideFile = '/tmp/.cat-cafe/default-cat-override.json';
    try {
      // Create a disk override file at the degraded template root
      mkdirSync(overrideDir, { recursive: true });
      writeFileSync(overrideFile, JSON.stringify({ catId: 'codex' }) + '\n', 'utf-8');
      // Point to non-existent template → degraded mode; override file is at same root
      process.env.CAT_TEMPLATE_PATH = '/tmp/__nonexistent_cat_template__.json';
      _resetCachedConfig();
      // loadDefaultCatOverride() will find the file and set _runtimeDefaultCatId='codex',
      // but _overrideValidatedByApi remains false (disk-loaded, not API-set).
      // With config unavailable, isCatKnownAndAvailable should reject it.
      const result = getDefaultCatId();
      assert.notEqual(result, 'codex', 'disk-loaded override should not be trusted in degraded mode');
    } finally {
      if (existsSync(overrideFile)) rmSync(overrideFile);
      if (existsSync(overrideDir)) rmSync(overrideDir, { recursive: true });
      if (origPath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = origPath;
      clearRuntimeDefaultCatId();
      _resetCachedConfig();
    }
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

describe('GET/PUT /api/config/default-cat (F154 AC-A4)', () => {
  let app;
  const OWNER_ID = 'test-owner-123';

  before(async () => {
    // Register cats so catRegistry.has() validation works
    catRegistry.reset();
    catRegistry.register('opus', _allConfigs.opus);
    catRegistry.register('codex', _allConfigs.codex);
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
