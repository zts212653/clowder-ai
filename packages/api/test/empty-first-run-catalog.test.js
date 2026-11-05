import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { bootstrapCatCatalog, readCatCatalogRaw, writeCatCatalog } from '../dist/config/cat-catalog-store.js';
import { loadResolvedCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import {
  createRuntimeCat,
  deleteRuntimeCat,
  readRuntimeAccountMembers,
  updateRuntimeCat,
} from '../dist/config/runtime-cat-catalog.js';
import { configOnboardingRoutes } from '../dist/routes/config-onboarding.js';

const template = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../cat-template.json'), 'utf8'));
function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'issue1651-empty-first-run-'));
  context.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), 'issue1651-empty-first-run-')));
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(root, 'cat-template.json');
  writeFileSync(path, JSON.stringify(template));
  return { root, path };
}

test('a fresh install stays empty across bootstrap and resolved reads, with owner and templates intact', (context) => {
  const { root, path } = fixture(context);
  bootstrapCatCatalog(root, path);
  for (let restart = 0; restart < 3; restart++) {
    const raw = JSON.parse(readCatCatalogRaw(root));
    assert.deepEqual(raw.breeds, [], 'no template breed or allowlisted GLM member is enrolled automatically');
    assert.equal(raw.memberInitialization, 'user_selected_v1');
    assert.deepEqual(Object.keys(raw.roster), ['owner']);
    assert.deepEqual(toAllCatConfigs(loadResolvedCatConfig(path)), {});
    bootstrapCatCatalog(root, path);
  }
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).breeds.length, template.breeds.length);
});

test('a new user-selected catalog never injects unselected breeds or variants after restart', (context) => {
  const { root, path } = fixture(context);
  const catalogPath = bootstrapCatCatalog(root, path);
  const raw = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const breed = structuredClone(template.breeds.find((item) => item.id === 'maine-coon'));
  breed.displayName = '我的伙伴';
  breed.variants = breed.variants.filter((variant) => variant.id === breed.defaultVariantId);
  raw.breeds = [breed];
  raw.roster[breed.catId] = template.roster[breed.catId];
  writeCatCatalog(root, raw);
  bootstrapCatCatalog(root, path);
  const resolved = loadResolvedCatConfig(path);
  assert.deepEqual(Object.keys(toAllCatConfigs(resolved)), ['codex']);
  assert.equal(resolved.breeds[0].displayName, '我的伙伴');
  assert.equal(JSON.parse(readCatCatalogRaw(root)).memberInitialization, 'user_selected_v1');
  writeCatCatalog(root, { ...JSON.parse(readCatCatalogRaw(root)), breeds: [], roster: { owner: raw.roster.owner } });
  bootstrapCatCatalog(root, path);
  assert.deepEqual(toAllCatConfigs(loadResolvedCatConfig(path)), {}, 'deleting all members must stay empty');
});

test('a legacy catalog retains existing members and its existing allowlisted upgrade behavior', (context) => {
  const { root, path } = fixture(context);
  const legacy = { ...structuredClone(template), breeds: [structuredClone(template.breeds[0])] };
  legacy.breeds[0].displayName = '已有的伙伴';
  writeCatCatalog(root, legacy);
  bootstrapCatCatalog(root, path);
  const raw = JSON.parse(readCatCatalogRaw(root));
  assert.equal(raw.memberInitialization, undefined, 'legacy installs must not become new first runs');
  assert.equal(raw.breeds[0].displayName, '已有的伙伴');
  assert.ok(raw.breeds.some((breed) => breed.id === 'dragon-li'));
});

test('onboarding eligibility uses explicit installation provenance and durable personal receipts', async (context) => {
  const { root, path } = fixture(context);
  bootstrapCatCatalog(root, path);
  const open = async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = 'fixture-owner';
    });
    await app.register(configOnboardingRoutes, { projectRoot: root });
    return app;
  };
  let app = await open();
  try {
    const initial = (await app.inject('/api/config/onboarding')).json();
    assert.equal(initial.autoEligible, true);
    assert.equal(initial.status, 'not_started');
    await app.inject({ method: 'PUT', url: '/api/config/onboarding', payload: { status: 'dismissed' } });
    await app.close();
    app = await open();
    assert.equal((await app.inject('/api/config/onboarding')).json().status, 'dismissed');
    const configured = { ...JSON.parse(readCatCatalogRaw(root)), breeds: [template.breeds[0]] };
    writeCatCatalog(root, configured);
    assert.equal(
      (await app.inject('/api/config/onboarding')).json().autoEligible,
      false,
      'an explicitly configured team no longer needs automatic first-run setup',
    );
    const legacy = structuredClone(template);
    legacy.breeds = [];
    writeCatCatalog(root, legacy);
    assert.equal(
      (await app.inject('/api/config/onboarding')).json().autoEligible,
      false,
      'an existing empty catalog is not proof of a new installation',
    );
  } finally {
    await app.close();
  }
});

test('ordinary member create, edit and delete retain the explicit enrollment policy', (context) => {
  const { root, path } = fixture(context);
  bootstrapCatCatalog(root, path);
  createRuntimeCat(root, {
    catId: 'chosen-member',
    name: '我的伙伴',
    displayName: '我的伙伴',
    clientId: 'anthropic',
    defaultModel: '',
    configurationSource: 'native_tool',
    avatar: '/avatars/opus.png',
    color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
    mentionPatterns: ['@chosen-member'],
    roleDescription: '用户选择的伙伴',
    mcpSupport: true,
    cli: { command: 'claude', outputFormat: 'stream-json' },
  });
  updateRuntimeCat(root, 'chosen-member', { displayName: '改过名字的伙伴' });
  bootstrapCatCatalog(root, path);
  assert.equal(toAllCatConfigs(loadResolvedCatConfig(path))['chosen-member'].displayName, '改过名字的伙伴');
  assert.equal(JSON.parse(readCatCatalogRaw(root)).memberInitialization, 'user_selected_v1');
  deleteRuntimeCat(root, 'chosen-member');
  bootstrapCatCatalog(root, path);
  assert.deepEqual(toAllCatConfigs(loadResolvedCatConfig(path)), {});
  assert.equal(JSON.parse(readCatCatalogRaw(root)).memberInitialization, 'user_selected_v1');
});

test('standard config parsing and account-binding reads retain the enrollment policy through writeback', (context) => {
  const { root, path } = fixture(context);
  bootstrapCatCatalog(root, path);
  const parsed = readRuntimeAccountMembers(root);
  assert.equal(parsed.memberInitialization, 'user_selected_v1');
  assert.equal(loadResolvedCatConfig(path).memberInitialization, 'user_selected_v1');
  writeCatCatalog(root, parsed);
  bootstrapCatCatalog(root, path);
  assert.equal(JSON.parse(readCatCatalogRaw(root)).memberInitialization, 'user_selected_v1');
  assert.deepEqual(toAllCatConfigs(loadResolvedCatConfig(path)), {});
});

test('a newer user-selected enrollment policy never falls back to legacy template enrollment', (context) => {
  const { root, path } = fixture(context);
  bootstrapCatCatalog(root, path);
  const raw = JSON.parse(readCatCatalogRaw(root));
  raw.memberInitialization = 'user_selected_v99';
  writeCatCatalog(root, raw);
  bootstrapCatCatalog(root, path);
  assert.deepEqual(JSON.parse(readCatCatalogRaw(root)).breeds, []);
  assert.deepEqual(toAllCatConfigs(loadResolvedCatConfig(path)), {});
  assert.equal(readRuntimeAccountMembers(root).memberInitialization, 'user_selected_v99');
});

test('a damaged catalog disables automatic onboarding without blocking personal guide receipts', async (context) => {
  const { root, path } = fixture(context);
  const catalogPath = bootstrapCatCatalog(root, path);
  const validCatalog = readFileSync(catalogPath, 'utf8');
  const invalidCatalog = '{invalid catalog';
  writeFileSync(catalogPath, invalidCatalog);
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'fixture-owner';
  });
  await app.register(configOnboardingRoutes, { projectRoot: root });
  try {
    const initial = await app.inject('/api/config/onboarding');
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().autoEligible, false);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/config/onboarding',
      payload: { status: 'dismissed' },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().status, 'dismissed');
    assert.equal(readFileSync(catalogPath, 'utf8'), invalidCatalog, 'guide receipts never repair catalog data');
    writeFileSync(catalogPath, validCatalog);
    assert.equal((await app.inject('/api/config/onboarding')).json().status, 'dismissed');
  } finally {
    await app.close();
  }
});
