import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { AccountConfig } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { resolveForClient } from '../src/config/account-resolver.js';
import { canonicalizeAccount } from '../src/config/account-store-format.js';
import { readAccountStoreSnapshot } from '../src/config/account-store-snapshot.js';
import { writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../src/config/codex-managed-layout.js';
import { accountsRoutes } from '../src/routes/accounts.js';
import { ACCOUNT_AUTH_ENV_KEYS } from './helpers/account-auth-environment.js';

test('CLI-owned synthetic accounts retain auto authentication while explicit accounts retain their selected mode', () => {
  const cli = { id: 'codex', authType: 'oauth' as const, syntheticNative: true };
  assert.equal(resolveCodexAccountLaunch(cli).authMode, 'auto');
  assert.equal(resolveCodexAccountLaunch({ id: 'codex', authType: 'oauth' }).authMode, 'oauth');
  assert.equal(resolveCodexAccountLaunch({ id: 'provider', authType: 'api_key' }).authMode, 'api_key');
  assert.equal(resolveCodexAccountLaunch(cli, { authMode: 'oauth' }).authMode, 'oauth');
});

let root: string;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'f320-managed-'));
  saved = { ...process.env };
  for (const key of ACCOUNT_AUTH_ENV_KEYS) delete process.env[key];
  process.env.HOME = root;
  process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  delete process.env.CODEX_HOME;
});
afterEach(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
async function create(name?: string) {
  const app = Fastify();
  await app.register(accountsRoutes);
  const response = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: { 'x-cat-cafe-user': 'fixture' },
    payload: {
      projectPath: root,
      authType: 'oauth',
      clientId: 'openai',
      ...(name !== undefined ? { displayName: name } : {}),
    },
  });
  await app.close();
  return response;
}
test('Codex OAuth can be created with default note and is independent, not builtin', async () => {
  const response = await create();
  assert.equal(response.statusCode, 200, response.body);
  const view = response.json().profile;
  assert.equal(view.builtin, false);
  assert.equal(view.displayName, 'Codex 账号');
  assert.equal(view.codex.status, 'not_logged_in');
  const stored = readAccountStoreSnapshot(root).resolve(view.id).account!;
  assert.equal(stored.codex?.kind, 'managed');
  assert.equal(stored.codex?.prepared, true);
  assert.notEqual(stored.codex?.credentialHome, join(root, '.codex'));
  assert.ok(readFileSync(join(root, '.cat-cafe', 'accounts.json'), 'utf8').includes(view.id));
});
test('same notes never merge accounts; rename survives reload and does not change launch identity', async () => {
  const a = (await create('公司')).json().profile;
  const b = (await create('公司')).json().profile;
  assert.notEqual(a.id, b.id);
  assert.equal(a.builtin, false);
  assert.ok(readAccountStoreSnapshot(root).resolve(a.id).account?.codex);
  const before = resolveCodexAccountLaunch(resolveForClient(root, 'openai', a.id)!);
  const app = Fastify();
  await app.register(accountsRoutes);
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/accounts/${a.id}`,
    headers: { 'x-cat-cafe-user': 'fixture' },
    payload: { projectPath: root, displayName: '工作' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const after = resolveCodexAccountLaunch(resolveForClient(root, 'openai', a.id)!);
  assert.deepEqual(after, before);
  const stored = readAccountStoreSnapshot(root).resolve(a.id).account!;
  assert.equal(stored.displayName, '工作');
  assert.deepEqual(canonicalizeAccount(stored).codex, stored.codex);
  await app.close();
});

for (const field of ['apiKey', 'baseUrl', 'envVars'] as const) {
  test(`managed create rejects ${field} before writing accounts, credentials or layout`, async () => {
    const app = Fastify();
    await app.register(accountsRoutes);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { 'x-cat-cafe-user': 'fixture' },
        payload: {
          projectPath: root,
          authType: 'oauth',
          clientId: 'openai',
          [field]: field === 'envVars' ? { CODEX_HOME: '/foreign' } : 'fixture',
        },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(existsSync(join(root, '.cat-cafe', 'accounts.json')), false);
      assert.equal(existsSync(join(root, '.cat-cafe', 'credentials.json')), false);
      assert.equal(existsSync(join(root, '.cat-cafe', 'codex-accounts')), false);
    } finally {
      await app.close();
    }
  });
}
test('first managed account shares the persisted default home, not ambient home', () => {
  const selected = join(root, 'selected');
  const ambient = join(root, 'ambient');
  mkdirSync(selected);
  mkdirSync(ambient);
  process.env.CODEX_HOME = ambient;
  writeCatalogAccount(root, 'codex', { authType: 'oauth', clientId: 'openai', envVars: { CODEX_HOME: selected } });
  const ref = 'codex-00000000-0000-0000-0000-000000000001';
  const layout = describeCodexManagedLayout(root, ref);
  assert.equal(layout.stateRoot, realpathSync(selected));
  assert.equal(layout.sqliteHome, realpathSync(selected));
});
test('divergent established state roots are rejected without choosing the first account', () => {
  const accounts: Record<string, AccountConfig> = {};
  for (const suffix of ['1', '2']) {
    const ref = `codex-00000000-0000-0000-0000-00000000000${suffix}`;
    const stateRoot = join(root, `state-${suffix}`);
    accounts[ref] = {
      authType: 'oauth',
      clientId: 'openai',
      codex: prepareCodexManagedLayout({
        kind: 'managed',
        layoutVersion: 1,
        prepared: false,
        credentialHome: join(root, `private-${suffix}`),
        stateRoot,
        sqliteHome: stateRoot,
      }),
    };
  }
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  writeFileSync(join(root, '.cat-cafe/accounts.json'), JSON.stringify(accounts));
  assert.throws(
    () => describeCodexManagedLayout(root, 'codex-00000000-0000-0000-0000-000000000003'),
    /state_roots_divergent/,
  );
});
