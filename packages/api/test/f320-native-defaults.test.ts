import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { inspectAccountCatalog } from '../src/config/account-store-snapshot.js';
import { inspectNativeAccountDefaults } from '../src/routes/accounts-native-view.js';

let root: string;
let saved: NodeJS.ProcessEnv;
const catalog = {
  version: 2,
  breeds: ['anthropic', 'openai', 'kimi'].map((clientId) => ({
    id: clientId,
    catId: clientId,
    name: clientId,
    displayName: clientId,
    avatar: '/fixture.png',
    color: { primary: '#123456', secondary: '#abcdef' },
    mentionPatterns: [`@${clientId}`],
    roleDescription: 'fixture',
    defaultVariantId: 'default',
    variants: [
      {
        id: 'default',
        clientId,
        defaultModel: 'fixture',
        mcpSupport: true,
        cli: { command: clientId, outputFormat: 'json' },
      },
    ],
  })),
  roster: {},
  reviewPolicy: {
    requireDifferentFamily: false,
    preferActiveInThread: false,
    preferLead: false,
    excludeUnavailable: true,
  },
  coCreator: { name: 'Owner', aliases: ['Owner'], mentionPatterns: ['@owner'] },
};
beforeEach(() => {
  saved = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-native-defaults-')));
  mkdirSync(join(root, '.cat-cafe'));
  Object.assign(process.env, { HOME: root, CAT_CAFE_CONFIG_ROOT: root, CAT_CAFE_GLOBAL_CONFIG_ROOT: root });
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_SQLITE_HOME;
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
});
afterEach(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

test('one torn default ref remains rejected without losing other native defaults or rewriting the store', () => {
  const path = join(root, '.cat-cafe/credentials.json');
  writeFileSync(path, JSON.stringify({ kimi: { apiKey: 'fake-fixture-key' } }));
  const before = readFileSync(path, 'utf8');
  const result = inspectNativeAccountDefaults(root);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.defaults.map(([id]) => id),
    ['claude', 'codex'],
  );
  const snapshot = inspectAccountCatalog(root);
  assert.deepEqual(
    snapshot.unavailableAccounts.map((entry) => entry.accountRef),
    ['kimi'],
  );
  assert.match(snapshot.unavailableAccounts[0].reason, /torn credential/);
  assert.equal(readFileSync(path, 'utf8'), before);
});
test('an API-key default is not synthesized as an OAuth login', () => {
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({ kimi: { authType: 'api_key', clientId: 'kimi' } }),
  );
  assert.deepEqual(
    inspectNativeAccountDefaults(root).defaults.map(([id]) => id),
    ['claude', 'codex'],
  );
});
test('a genuinely unreadable catalog stays unknown and recovers on the next read', () => {
  const path = join(root, '.cat-cafe/cat-catalog.json');
  writeFileSync(path, '{broken');
  assert.deepEqual(inspectNativeAccountDefaults(root).defaults, []);
  assert.ok(inspectNativeAccountDefaults(root).error);
  writeFileSync(path, JSON.stringify(catalog));
  assert.equal(inspectNativeAccountDefaults(root).defaults.length, 3);
});

test('the real account GET lists healthy defaults and the rejected ref separately', async () => {
  const { default: Fastify } = await import('fastify');
  const { accountsRoutes } = await import('../src/routes/accounts.js');
  process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
  process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
  process.env.AUDIT_LOG_DIR = join(root, 'audit');
  process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
  const path = join(root, '.cat-cafe/credentials.json');
  writeFileSync(path, JSON.stringify({ kimi: { apiKey: 'fake-fixture-key' } }));
  const before = readFileSync(path, 'utf8');
  const app = Fastify();
  try {
    await app.register(accountsRoutes);
    const response = await app.inject({
      method: 'GET',
      url: `/api/accounts?projectPath=${encodeURIComponent(root)}`,
      headers: { 'x-cat-cafe-user': 'fixture' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.nativeDefaultsError, undefined);
    assert.deepEqual(
      body.providers.map((p: { id: string }) => p.id),
      ['claude', 'codex'],
    );
    assert.deepEqual(
      body.unavailableAccounts.map((p: { accountRef: string }) => p.accountRef),
      ['kimi'],
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    await app.close();
  }
});
