import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { _resetCachedConfig } from '../dist/config/cat-config-loader.js';
import { configEventBus } from '../dist/config/config-event-bus.js';
import { memberCreationReceipt } from '../dist/config/member-create-receipt.js';
import { catsRoutes } from '../dist/routes/cats.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { selectFakeCodexHome } from './helpers/fake-codex-home.js';

test('short names are allocated atomically and only a persisted operator/request receipt can replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-receipt-'));
  const template = JSON.parse(readFileSync(new URL('../../../cat-template.json', import.meta.url), 'utf8'));
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(join(root, 'cat-template.json'), JSON.stringify(template));
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(template));
  const saved = new Map(
    ['CAT_TEMPLATE_PATH', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CODEX_HOME', 'CODEX_SQLITE_HOME'].map((key) => [
      key,
      process.env[key],
    ]),
  );
  const cwd = process.cwd(),
    restore = isolateAccountAuthEnvironment();
  process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  selectFakeCodexHome(root);
  process.chdir(root);
  let app = Fastify();
  await app.register(catsRoutes);
  let failPublish = false,
    published = 0;
  const unsubscribe = configEventBus.onConfigChange(() => {
    published++;
    if (failPublish) {
      failPublish = false;
      return Promise.reject(new Error('fixture publish interrupted'));
    }
  });
  const payload = {
    catId: 'short-codex',
    name: 'Codex 伙伴',
    displayName: '砚砚',
    color: { primary: '#123456', secondary: '#abcdef' },
    mentionPatterns: ['@short-codex'],
    roleDescription: '协作',
    clientId: 'openai',
    configurationSource: 'native_tool',
    defaultModel: '',
    cli: { carrier: 'app_server' },
  };
  const request = (owner, key, body = payload) => ({
    method: 'POST',
    url: '/api/cats',
    headers: {
      'x-cat-cafe-user': owner,
      'x-cat-cafe-onboarding-journey': 'journey-one',
      'idempotency-key': `onboarding:journey-one:cat:${key}`,
    },
    payload: body,
  });
  try {
    const [one, two] = await Promise.all([
      app.inject(request('owner-a', 'codex')),
      app.inject(request('owner-a', 'codex')),
    ]);
    assert.equal(one.statusCode, 201, one.body);
    assert.equal(two.statusCode, 200, two.body);
    assert.equal(one.json().cat.id, two.json().cat.id);
    assert.equal(one.json().cat.carrier, 'app_server');
    assert.equal(one.json().cat.cli.carrier, undefined, 'legacy request fields are not new catalog writes');
    const other = await app.inject(request('owner-b', 'codex'));
    assert.equal(other.statusCode, 201, other.body);
    assert.equal(other.json().cat.id, 'short-codex-2');
    assert.deepEqual(other.json().cat.mentionPatterns, ['@short-codex-2']);
    assert.equal(
      (await app.inject(request('owner-a', 'codex', { ...payload, defaultModel: 'changed' }))).statusCode,
      409,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/cats', headers: { 'x-cat-cafe-user': 'owner-a' }, payload }))
        .statusCode,
      409,
    );
    await app.close();
    _resetCachedConfig();
    app = Fastify();
    await app.register(catsRoutes);
    const retry = await app.inject(request('owner-a', 'codex'));
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().cat.id, 'short-codex');
    assert.equal(retry.json().idempotent, true);
    const catalog = JSON.parse(readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8'));
    const variants = catalog.breeds.flatMap((b) => b.variants).filter((v) => v.creationReceipt);
    const originalReceipt = memberCreationReceipt(
      'owner-a',
      'journey-one',
      'onboarding:journey-one:cat:codex',
      payload,
    );
    assert.deepEqual(
      variants.find((v) => v.creationReceipt.requestHash === originalReceipt.requestHash).creationReceipt,
      originalReceipt,
    );
    assert.equal(variants.length, 2);
    assert.equal(new Set(variants.map((v) => v.creationReceipt.requestHash)).size, 2);
    assert.equal(JSON.stringify(retry.json()).includes('requestHash'), false);
    failPublish = true;
    const interrupted = await app.inject(request('owner-c', 'codex'));
    assert.equal(interrupted.statusCode, 500, interrupted.body);
    await app.close();
    _resetCachedConfig();
    app = Fastify();
    await app.register(catsRoutes);
    const recovered = await app.inject(request('owner-c', 'codex'));
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().cat.id, 'short-codex-3');
    assert.equal(published, 6, 'every valid replay must restore publication instead of returning before side effects');
  } finally {
    unsubscribe();
    await app.close();
    restore();
    process.chdir(cwd);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetCachedConfig();
  }
});
