import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { readAccountStoreSnapshot } from '../src/config/account-store-snapshot.js';
import { writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../src/config/codex-managed-layout.js';
import { accountsRoutes } from '../src/routes/accounts.js';
import { accountToView } from '../src/routes/accounts-view.js';
import { parseCodexWhamUsageResponse } from '../src/routes/quota.js';

const reset = '2030-01-02T03:04:05.000Z';
const epoch = Date.parse(reset) / 1000;
test('native quota header fallback preserves pool, percentage kind and reset epoch', () => {
  const items = parseCodexWhamUsageResponse(
    {},
    new Headers({
      'x-codex-primary-used-percent': '30',
      'x-codex-primary-reset-at': String(epoch),
      'x-codex-credits-balance': '20',
    }),
  );
  assert.deepEqual(items[0], {
    label: '5小时使用限额',
    usedPercent: 30,
    percentKind: 'used',
    poolId: 'codex-main',
    resetsAt: reset,
  });
  assert.deepEqual(items[1], {
    label: '溢出额度',
    usedPercent: 20,
    percentKind: 'remaining',
    poolId: 'codex-overflow',
  });
});
test('body quota value stays authoritative while missing reset can use native headers', () => {
  const items = parseCodexWhamUsageResponse(
    { rate_limit: { primary_window: { used_percent: 30 } } },
    new Headers({ 'x-codex-primary-used-percent': '90', 'x-codex-primary-reset-at': String(epoch) }),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].usedPercent, 30);
  assert.equal(items[0].resetsAt, reset);
});
test('account quota route and reloaded store retain body reset, credits and pool semantics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f320-quota-'));
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: root, CAT_CAFE_GLOBAL_CONFIG_ROOT: root, CAT_CAFE_DATA_DIR: join(root, 'data') });
  delete process.env.CODEX_HOME;
  const home = join(root, 'selected');
  mkdirSync(home);
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'fixture-access', account_id: 'fixture-workspace' } }),
  );
  writeCatalogAccount(root, 'codex', { clientId: 'openai', authType: 'oauth', envVars: { CODEX_HOME: home } });
  const app = Fastify();
  await app.register(accountsRoutes, {
    quotaFetcher: (async () =>
      Response.json({
        credits_balance: 20,
        rate_limit: { primary_window: { used_percent: 30, reset_at: epoch } },
      })) as typeof fetch,
  });
  try {
    const result = await app.inject({
      method: 'POST',
      url: '/api/accounts/codex/codex/quota',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().quota.items[0].resetsAt, reset);
    const observation = readAccountStoreSnapshot(root).resolve('codex').account!.quota!;
    assert.equal(observation.items[0].poolId, 'codex-main');
    assert.equal(observation.items[0].resetsAt, reset);
    assert.equal(observation.items[1].percentKind, 'remaining');
    assert.equal(observation.items[1].usedPercent, 20);
  } finally {
    await app.close();
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const transition of ['account-and-auth', 'auth-only', 'logout'] as const)
  test(`late quota rejects ${transition} while preserving the account`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'f320-quota-owner-'));
    const saved = { ...process.env };
    Object.assign(process.env, {
      HOME: root,
      CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
      CAT_CAFE_DATA_DIR: join(root, 'data'),
    });
    delete process.env.CODEX_HOME;
    delete process.env.CODEX_SQLITE_HOME;
    const ref = `codex-${randomUUID()}`;
    const layout = prepareCodexManagedLayout(describeCodexManagedLayout(root, ref));
    const identity = (suffix: string) => ({ userId: `user-${suffix}`, workspaceId: `workspace-${suffix}` });
    const auth = (suffix: string) => {
      const current = identity(suffix);
      const idToken = `x.${Buffer.from(
        JSON.stringify({
          'https://api.openai.com/auth': {
            chatgpt_user_id: current.userId,
            chatgpt_account_id: current.workspaceId,
          },
        }),
      ).toString('base64url')}.x`;
      writeFileSync(
        join(layout.credentialHome, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: idToken,
            access_token: `fixture-${suffix}`,
            account_id: current.workspaceId,
          },
        }),
      );
    };
    const account = { authType: 'oauth' as const, clientId: 'openai', codex: { ...layout, identity: identity('a') } };
    auth('a');
    writeCatalogAccount(root, ref, account);
    let started: () => void = () => {};
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const app = Fastify();
    await app.register(accountsRoutes, {
      quotaFetcher: (async () => {
        started();
        return (await pending).clone();
      }) as typeof fetch,
    });
    try {
      const request = app.inject({
        method: 'POST',
        url: `/api/accounts/${ref}/codex/quota`,
        headers: { 'x-cat-cafe-user': 'fixture' },
        payload: { projectPath: root },
      });
      await requested;
      if (transition === 'logout') rmSync(join(layout.credentialHome, 'auth.json'));
      else auth('b');
      if (transition === 'account-and-auth')
        writeCatalogAccount(root, ref, { ...account, codex: { ...layout, identity: identity('b') } });
      finish(Response.json({ rate_limit: { primary_window: { used_percent: 91 } } }));
      const response = await request;
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(readAccountStoreSnapshot(root).resolve(ref).account?.quota, undefined);
      if (transition !== 'account-and-auth') {
        auth('a');
        const retry = await app.inject({
          method: 'POST',
          url: `/api/accounts/${ref}/codex/quota`,
          headers: { 'x-cat-cafe-user': 'fixture' },
          payload: { projectPath: root },
        });
        assert.equal(retry.statusCode, 200, retry.body);
        const stored = readAccountStoreSnapshot(root).resolve(ref).account!;
        assert.deepEqual(stored.quota?.owner, { accountRef: ref, ...identity('a') });
        assert.equal(accountToView(ref, stored, false).quota?.status, 'ok');
        rmSync(join(layout.credentialHome, 'auth.json'));
        const loggedOut = accountToView(ref, stored, false);
        assert.equal(loggedOut.codex?.status, 'identity_changed');
        assert.equal(loggedOut.quota?.status, 'unavailable');
        assert.deepEqual(loggedOut.quota?.items, []);
      }
    } finally {
      await app.close();
      process.env = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
