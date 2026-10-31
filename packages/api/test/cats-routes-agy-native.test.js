import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { selectFakeCodexHome } from './helpers/fake-codex-home.js';

const { catsRoutes } = await import('../dist/routes/cats.js');
const { _resetCachedConfig, loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
const profile = {
  enabled: true,
  carrier: 'native',
  profileId: 'gemini38',
  homeRoot: '/isolated/profiles',
  model: 'gemini-3.8-flash-high',
  autoApprove: false,
  trustedWorkspaces: ['/approved/workspace'],
};
const headers = { 'x-cat-cafe-user': 'default-user' };

async function fixture(initialProfile) {
  const root = mkdtempSync(join(tmpdir(), 'f325-cats-native-'));
  const keys = [
    'CAT_TEMPLATE_PATH',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CAT_CAFE_CONFIG_ROOT',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
  ];
  const saved = keys.map((key) => process.env[key]);
  process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  selectFakeCodexHome(root);
  const template = {
    version: 2,
    breeds: [
      {
        id: 'siamese',
        catId: 'gemini38',
        name: 'Gemini',
        displayName: '烁烁',
        avatar: '/avatars/default.png',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@gemini38'],
        roleDescription: 'test',
        defaultVariantId: 'gemini38-default',
        variants: [
          {
            id: 'gemini38-default',
            clientId: 'google',
            accountRef: 'gemini',
            defaultModel: initialProfile ? profile.model : 'Gemini 3.8 Flash (High)',
            mcpSupport: true,
            cli: { command: 'agy', outputFormat: 'plainText' },
            ...(initialProfile ? { agyProfile: initialProfile } : {}),
          },
        ],
      },
    ],
    roster: { gemini38: { family: 'siamese', roles: ['assistant'], lead: false, available: true, evaluation: 'test' } },
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
    coCreator: { name: 'Owner', aliases: ['Owner'], mentionPatterns: ['@owner'] },
  };
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(process.env.CAT_TEMPLATE_PATH, JSON.stringify(template));
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(template));
  _resetCachedConfig();
  catRegistry.reset();
  for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig(process.env.CAT_TEMPLATE_PATH))))
    catRegistry.register(id, config);
  const app = Fastify();
  await app.register(catsRoutes);
  return {
    app,
    root,
    persisted: () => JSON.parse(readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8')).breeds[0].variants[0],
    patch: (body) => app.inject({ method: 'PATCH', url: '/api/cats/gemini38', headers, payload: body }),
    close: async () => {
      await app.close();
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      });
      _resetCachedConfig();
      catRegistry.reset();
      for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig()))) catRegistry.register(id, config);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('member PATCH persists, exposes and reconciles an explicit AGY Native profile', async () => {
  const f = await fixture();
  try {
    const response = await f.patch({ defaultModel: profile.model, agyProfile: profile });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().cat.agyProfile, profile);
    assert.equal(response.json().cat.agyProfile.carrier, 'native');
    assert.deepEqual(f.persisted().agyProfile, profile);
    assert.deepEqual(catRegistry.tryGet('gemini38').config.agyProfile, profile);
    const read = await f.app.inject({ method: 'GET', url: '/api/cats' });
    assert.deepEqual(read.json().cats.find((cat) => cat.id === 'gemini38').agyProfile, profile);
    const reverted = await f.patch({ agyProfile: null });
    assert.equal(reverted.statusCode, 200, reverted.body);
    assert.equal(reverted.json().cat.agyProfile, undefined);
    assert.equal(catRegistry.tryGet('gemini38').config.agyProfile, undefined);
  } finally {
    await f.close();
  }
});

test('member PATCH persists official ACP, returns it after refresh and preserves identity on explicit Native return', async () => {
  const f = await fixture(profile);
  const acpProfile = { ...profile, carrier: 'acp' };
  const acp = { command: '/installed/agy_acp_server.par', startupArgs: [] };
  try {
    const response = await f.patch({ carrier: 'acp', acp, defaultModel: profile.model, agyProfile: acpProfile });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(f.persisted().agyProfile, acpProfile);
    const refreshed = await f.app.inject({ method: 'GET', url: '/api/cats' });
    const cat = refreshed.json().cats.find((cat) => cat.id === 'gemini38');
    assert.equal(cat.carrier, 'acp');
    assert.deepEqual(cat.agyProfile, acpProfile);
    assert.equal(cat.id, 'gemini38');
    const returned = await f.patch({ carrier: 'cli', acp: null, defaultModel: profile.model, agyProfile: profile });
    assert.equal(returned.statusCode, 200, returned.body);
    assert.deepEqual(returned.json().cat.agyProfile, profile);
  } finally {
    await f.close();
  }
});

test('Native profile mutation rejects unsafe or conflicting settings before persistence', async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify(f.persisted());
    for (const body of [
      { agyProfile: { ...profile, nativeCodingGrant: { taskId: 'arbitrary' } } },
      { agyProfile: { ...profile, model: 'Human Model Label' } },
      { agyProfile: { ...profile, trustedWorkspaces: ['relative'] } },
      { agyProfile: { ...profile, model: 'another-model' } },
      { agyProfile: profile, cliConfigArgs: ['--unsafe'] },
      { agyProfile: profile, acp: { command: 'gemini', startupArgs: ['--acp'] } },
      { agyProfile: profile, clientId: 'openai', accountRef: 'codex' },
    ]) {
      const response = await f.patch({ defaultModel: profile.model, ...body });
      assert.equal(response.statusCode, 400, JSON.stringify(body));
      assert.equal(JSON.stringify(f.persisted()), before);
    }
  } finally {
    await f.close();
  }
});

test('retired native coding grants are stripped when member settings are saved', async () => {
  const grant = {
    threadId: 'thread-1',
    taskId: 'task-1',
    workUnitRef: 'file:docs/plans/f325-coding.md#sum',
    acceptedRevision: 'a'.repeat(40),
    workspaceRoot: '/approved/workspace',
    writableFiles: ['src/sum.ts'],
    testFile: 'test/sum.test.ts',
  };
  const f = await fixture({ ...profile, nativeCodingGrant: grant });
  try {
    const response = await f.patch({ nickname: 'Spark', agyProfile: profile });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json().cat.agyProfile);
    assert.equal(response.json().cat.agyProfile.nativeCodingGrant, undefined);
    assert.equal(f.persisted().agyProfile.nativeCodingGrant, undefined);
    const changed = await f.patch({ agyProfile: { ...profile, profileId: 'another' } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(f.persisted().agyProfile.nativeCodingGrant, undefined);
  } finally {
    await f.close();
  }
});

test('creation supports Native and client/ACP transitions mask template Native settings', async () => {
  const f = await fixture(profile);
  try {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/cats',
      headers,
      payload: {
        catId: 'new-gemini',
        name: 'New Gemini',
        displayName: 'New Gemini',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@new-gemini'],
        roleDescription: 'test',
        clientId: 'google',
        accountRef: 'gemini',
        defaultModel: profile.model,
        agyProfile: { ...profile, profileId: 'new-gemini' },
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().cat.agyProfile.profileId, 'new-gemini');
    const acp = await f.patch({ acp: { command: 'gemini', startupArgs: ['--acp'] } });
    assert.equal(acp.statusCode, 200, acp.body);
    assert.deepEqual(acp.json().cat.acp, { command: 'gemini', startupArgs: ['--acp'] });
    assert.equal(f.persisted().agyProfile, null);
    assert.equal(catRegistry.tryGet('gemini38').config.agyProfile, undefined);
    const native = await f.patch({ acp: null, agyProfile: profile });
    assert.equal(native.statusCode, 200, native.body);
    const switched = await f.patch({ clientId: 'openai', accountRef: 'codex', defaultModel: 'gpt-5.6-sol' });
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(switched.json().cat.agyProfile, undefined);
    assert.equal(f.persisted().agyProfile, null);
  } finally {
    await f.close();
  }
});

test('member PATCH explicitly opts into AGY automatic approval and reads the choice back', async () => {
  const f = await fixture();
  try {
    const automatic = { ...profile, autoApprove: true, trustedWorkspaces: [] };
    const response = await f.patch({ defaultModel: profile.model, agyProfile: automatic });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(f.persisted().agyProfile, automatic);
    const read = await f.app.inject({ method: 'GET', url: '/api/cats' });
    assert.deepEqual(read.json().cats.find((cat) => cat.id === 'gemini38').agyProfile, automatic);
    const restricted = await f.patch({ agyProfile: profile });
    assert.equal(restricted.statusCode, 200, restricted.body);
    assert.equal(f.persisted().agyProfile.autoApprove, false);
  } finally {
    await f.close();
  }
});
