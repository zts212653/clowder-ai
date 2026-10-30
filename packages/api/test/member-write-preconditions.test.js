import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { bootstrapCatCatalog } from '../dist/config/cat-catalog-store.js';
import { _resetCachedConfig, loadResolvedCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import { memberConfigurationRevision, updateMemberWithRevision } from '../dist/config/member-config-revision.js';
import { createRuntimeCat, withRuntimeCatMutationLock } from '../dist/config/runtime-cat-catalog.js';
import {
  _clearRuntimeOverrides,
  getRuntimeOverride,
  initRuntimeOverrides,
  setRuntimeOverride,
} from '../dist/config/session-strategy-overrides.js';
import { catsRoutes } from '../dist/routes/cats.js';
import { sessionStrategyConfigRoutes } from '../dist/routes/session-strategy-config.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

function memberFixture() {
  const root = mkdtempSync(join(tmpdir(), 'member-write-preconditions-'));
  const template = join(root, 'cat-template.json');
  copyFileSync(new URL('../../../cat-template.json', import.meta.url), template);
  bootstrapCatCatalog(root, template);
  createRuntimeCat(root, {
    catId: 'versioned-member',
    name: 'Member',
    displayName: 'Member',
    avatar: '/avatars/default.png',
    color: { primary: '#123456', secondary: '#abcdef' },
    mentionPatterns: ['@versioned-member'],
    roleDescription: 'review partner',
    configurationSource: 'native_tool',
    clientId: 'anthropic',
    carrier: 'cli',
    defaultModel: '',
    mcpSupport: false,
    cli: { command: 'claude', outputFormat: 'stream-json' },
  });
  return root;
}

test('the S1 owner rejects an unversioned write before changing member data', async () => {
  const root = memberFixture();
  const before = memberConfigurationRevision(root, 'versioned-member');
  await assert.rejects(updateMemberWithRevision(root, 'versioned-member', undefined, { personality: 'blind write' }), {
    statusCode: 428,
  });
  assert.equal(memberConfigurationRevision(root, 'versioned-member'), before);
});

test('availability is part of the same member revision and fences an older editor', async () => {
  const root = memberFixture();
  const before = memberConfigurationRevision(root, 'versioned-member');
  await updateMemberWithRevision(root, 'versioned-member', before, { available: false });
  assert.notEqual(memberConfigurationRevision(root, 'versioned-member'), before);
  await assert.rejects(updateMemberWithRevision(root, 'versioned-member', before, { available: true }), {
    statusCode: 409,
  });
});

test('the existing catalog lock retains ownership until an asynchronous mutation finishes', async (t) => {
  const root = memberFixture();
  const events = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = withRuntimeCatMutationLock(root, async () => {
    events.push('first:start');
    await gate;
    events.push('first:end');
  });
  await new Promise(setImmediate);
  const second = withRuntimeCatMutationLock(root, () => events.push('second'));
  t.after(async () => {
    release();
    await Promise.allSettled([first, second]);
  });
  await new Promise(setImmediate);
  assert.deepEqual(events, ['first:start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
});

async function appFixture(t) {
  const root = memberFixture();
  const keys = [
    'CAT_TEMPLATE_PATH',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CAT_CAFE_CONFIG_ROOT',
    'HOME',
    'USERPROFILE',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const restoreAuth = isolateAccountAuthEnvironment();
  const configs = catRegistry.getAllConfigs();
  keys.forEach((key) => {
    process.env[key] = key === 'CAT_TEMPLATE_PATH' ? join(root, 'cat-template.json') : root;
  });
  _resetCachedConfig();
  _clearRuntimeOverrides();
  catRegistry.reset();
  Object.entries(toAllCatConfigs(loadResolvedCatConfig(join(root, 'cat-template.json')))).forEach(([id, config]) =>
    catRegistry.register(id, config),
  );
  const app = Fastify();
  t.after(async () => {
    await app.close();
    restoreAuth();
    previous.forEach((value, key) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    _clearRuntimeOverrides();
    _resetCachedConfig();
    catRegistry.reset();
    Object.entries(configs).forEach(([id, config]) => catRegistry.register(id, config));
    console.log(`Retained isolated S1 fixture: ${root}`);
  });
  await app.register(catsRoutes);
  const read = async () => (await app.inject({ method: 'GET', url: '/api/cats' })).json().cats;
  const headers = { 'x-cat-cafe-user': 'member-version-test' };
  return { app, read, headers };
}

test('formal PATCH and DELETE reject blind member writes without removing the strategy', async (t) => {
  const { app, read, headers } = await appFixture(t);
  await setRuntimeOverride('versioned-member', { strategy: 'compress' });
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/cats/versioned-member',
    headers,
    payload: { personality: 'blind' },
  });
  const deletion = await app.inject({ method: 'DELETE', url: '/api/cats/versioned-member', headers });
  assert.equal(patch.statusCode, 428);
  assert.equal(deletion.statusCode, 428);
  assert.equal((await read())[0].personality, '');
  assert.equal(getRuntimeOverride('versioned-member').strategy, 'compress');
});

test('formal member changes reject stale deletion before its strategy side effect', async (t) => {
  const { app, read, headers } = await appFixture(t);
  const before = (await read())[0].configurationRevision;
  await setRuntimeOverride('versioned-member', { strategy: 'compress' });
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/cats/versioned-member',
    headers,
    payload: { available: false, expectedRevision: before },
  });
  assert.equal(patch.statusCode, 200, patch.payload);
  const deletion = await app.inject({
    method: 'DELETE',
    url: '/api/cats/versioned-member',
    headers,
    payload: { expectedRevision: before },
  });
  assert.equal(deletion.statusCode, 409, deletion.payload);
  assert.equal(getRuntimeOverride('versioned-member').strategy, 'compress');
  const latest = (await read())[0];
  assert.notEqual(latest.configurationRevision, before);
  const accepted = await app.inject({
    method: 'DELETE',
    url: '/api/cats/versioned-member',
    headers,
    payload: { expectedRevision: latest.configurationRevision },
  });
  assert.equal(accepted.statusCode, 200, accepted.payload);
  assert.equal(getRuntimeOverride('versioned-member'), undefined);
  assert.equal((await read()).length, 0);
});

test(
  'a strategy save waiting during member deletion cannot recreate an orphan override',
  { timeout: 10_000 },
  async (t) => {
    const { app, read, headers } = await appFixture(t);
    await app.register(sessionStrategyConfigRoutes);
    const member = (await read())[0];
    let value = null;
    let release;
    let entered;
    let blocked = false;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    await initRuntimeOverrides({
      options: {},
      scan: async () => ['0', []],
      get: async () => {
        if (!blocked) {
          blocked = true;
          entered();
          await gate;
        }
        return value;
      },
      eval: async (_script, _keys, _key, expected, next) => {
        if ((value ?? '') !== expected) return 0;
        value = next || null;
        return 1;
      },
    });
    const deletion = app.inject({
      method: 'DELETE',
      url: '/api/cats/versioned-member',
      headers,
      payload: { expectedRevision: member.configurationRevision },
    });
    await started;
    const saving = app.inject({
      method: 'PATCH',
      url: '/api/config/session-strategy/versioned-member',
      headers,
      payload: { strategy: 'compress', expectedRevision: 'none' },
    });
    await new Promise(setImmediate);
    release();
    const [deleted, saved] = await Promise.all([deletion, saving]);
    assert.equal(deleted.statusCode, 200, deleted.payload);
    assert.equal(saved.statusCode, 404, saved.payload);
    assert.equal((await read()).length, 0);
    assert.equal(getRuntimeOverride('versioned-member'), undefined);
  },
);
