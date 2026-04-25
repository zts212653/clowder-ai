import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
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

const _repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
let _fileDir;
let _origTemplatePath;

before(() => {
  _origTemplatePath = process.env.CAT_TEMPLATE_PATH;
  _fileDir = mkdtempSync(join(tmpdir(), 'cat-cfg-file-'));
  copyFileSync(join(_repoRoot, 'cat-template.json'), join(_fileDir, 'cat-template.json'));
  process.env.CAT_TEMPLATE_PATH = join(_fileDir, 'cat-template.json');
  _resetCachedConfig({ includeOverride: true });
});

after(() => {
  clearRuntimeDefaultCatId();
  if (_origTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
  else process.env.CAT_TEMPLATE_PATH = _origTemplatePath;
  _resetCachedConfig({ includeOverride: true });
  rmSync(_fileDir, { recursive: true, force: true });
});

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
    const degradedDir = mkdtempSync(join(tmpdir(), 'cat-cfg-degraded-'));
    try {
      process.env.CAT_TEMPLATE_PATH = join(degradedDir, '__nonexistent__.json');
      _resetCachedConfig({ includeOverride: true });
      setRuntimeDefaultCatId('codex');
      const result = getDefaultCatId();
      assert.equal(result, 'codex', 'API-set override should be trusted in degraded mode');
    } finally {
      clearRuntimeDefaultCatId();
      rmSync(degradedDir, { recursive: true, force: true });
      process.env.CAT_TEMPLATE_PATH = join(_fileDir, 'cat-template.json');
      _resetCachedConfig({ includeOverride: true });
    }
  });

  it('disk-loaded override is rejected when config cache is unavailable (#543 degraded)', () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'cat-cfg-test-'));
    const overrideDir = join(isolatedDir, '.cat-cafe');
    const overrideFile = join(overrideDir, 'default-cat-override.json');
    try {
      mkdirSync(overrideDir, { recursive: true });
      writeFileSync(overrideFile, `${JSON.stringify({ catId: 'codex' })}\n`, 'utf-8');
      process.env.CAT_TEMPLATE_PATH = join(isolatedDir, '__nonexistent__.json');
      _resetCachedConfig({ includeOverride: true });
      const result = getDefaultCatId();
      assert.notEqual(result, 'codex', 'disk-loaded override should not be trusted in degraded mode');
    } finally {
      clearRuntimeDefaultCatId();
      rmSync(isolatedDir, { recursive: true, force: true });
      process.env.CAT_TEMPLATE_PATH = join(_fileDir, 'cat-template.json');
      _resetCachedConfig({ includeOverride: true });
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
