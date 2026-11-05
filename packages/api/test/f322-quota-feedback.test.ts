import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { readAccountStoreSnapshot } from '../src/config/account-store-snapshot.js';
import { writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { accountsRoutes } from '../src/routes/accounts.js';
import { accountToView } from '../src/routes/accounts-view.js';

test('quota failures retain their time and cause, detect rotation, and persist the last successful reading', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f322-quota-feedback-'));
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: root, CAT_CAFE_GLOBAL_CONFIG_ROOT: root, CAT_CAFE_DATA_DIR: join(root, 'data') });
  delete process.env.CODEX_HOME;
  const home = join(root, 'selected');
  mkdirSync(home);
  const auth = (token: string) =>
    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: token,
          account_id: 'fixture-workspace',
          id_token: `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-workspace' } })).toString('base64url')}.x`,
        },
      }),
    );
  auth('fixture-secret-old');
  writeCatalogAccount(root, 'codex', { clientId: 'openai', authType: 'oauth', envVars: { CODEX_HOME: home } });
  let response = () => Response.json({ rate_limit: { primary_window: { used_percent: 100 } } });
  const app = Fastify();
  let calls = 0;
  await app.register(accountsRoutes, {
    quotaFetcher: (async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response();
    }) as typeof fetch,
  });
  const query = (renewedCredentialVersion?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/accounts/codex/codex/quota',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root, ...(renewedCredentialVersion ? { renewedCredentialVersion } : {}) },
    });
  const view = () => accountToView('codex', readAccountStoreSnapshot(root).resolve('codex').account!, false, root);
  try {
    const ok = await query();
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().quota.items[0].usedPercent, 100);
    response = () =>
      Response.json({ error: { message: 'expired fixture-secret-old', code: 'token_expired' } }, { status: 401 });
    const first = (await query()).json().quota;
    assert.equal(first.failure?.kind, 'renewal_required');
    assert.equal(first.lastSuccess?.items[0].usedPercent, 100);
    assert.ok(first.failure.officialDetail.includes('expired'));
    assert.ok(!JSON.stringify(first).includes('fixture-secret-old'));
    assert.ok(first.credentialVersion);
    assert.equal(view().quota?.renewedCredentialVersion, undefined);
    const noQuery = calls;
    assert.equal((await query('a'.repeat(64))).statusCode, 409);
    assert.equal(calls, noQuery);
    auth('fixture-secret-new');
    assert.ok(view().quota?.renewedCredentialVersion, JSON.stringify(view()));
    const version = view().quota?.renewedCredentialVersion;
    const before = calls;
    const [autoA, autoB] = await Promise.all([query(version), query(version)]);
    assert.equal(autoA.statusCode, 200, autoA.body);
    assert.equal(autoB.statusCode, 200, autoB.body);
    assert.equal(calls, before + 1, 'simultaneous clients must share one official query');
    const repeated = autoA.json().quota;
    await query(version);
    assert.equal(calls, before + 1, 'the same credential is not automatically queried again after reload');
    assert.equal(repeated.failure.kind, 'renewal_required');
    assert.equal(view().quota?.renewedCredentialVersion, undefined);
    assert.equal(repeated.lastSuccess.observedAt, first.lastSuccess.observedAt);
    response = () => {
      throw Error('network offline');
    };
    const offline = (await query()).json().quota;
    assert.equal(offline.failure.kind, 'service_unreachable');
    assert.equal(offline.lastSuccess.items[0].usedPercent, 100);
    response = () => Response.json({ error: { code: 'token_revoked', message: 'Session revoked' } }, { status: 401 });
    assert.equal((await query()).json().quota.failure.kind, 'signin_required');
    response = () => new Response('broken upstream JSON', { status: 200 });
    assert.equal((await query()).json().quota.failure.kind, 'service_unreachable');
    writeFileSync(join(home, 'auth.json'), '{broken local JSON');
    assert.equal((await query()).json().quota.failure.kind, 'signin_required');
    rmSync(join(home, 'auth.json'));
    assert.equal((await query()).json().quota.failure.kind, 'signin_required');
  } finally {
    await app.close();
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('only an explicit expired-sign-in retry renews before querying; passive and automatic reads never renew', async () => {
  const { registerCodexQuotaRoutes } = await import('../src/routes/accounts-codex-quota.js');
  const root = mkdtempSync(join(tmpdir(), 'f322-renew-click-'));
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: root, CAT_CAFE_GLOBAL_CONFIG_ROOT: root, CAT_CAFE_DATA_DIR: join(root, 'data') });
  delete process.env.CODEX_HOME;
  const home = join(root, 'selected');
  mkdirSync(home);
  const auth = (token: string) =>
    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify({ tokens: { access_token: token, account_id: 'fixture-workspace' } }),
    );
  auth('old');
  writeCatalogAccount(root, 'codex', { clientId: 'openai', authType: 'oauth', envVars: { CODEX_HOME: home } });
  let renewals = 0;
  const order: string[] = [];
  const app = Fastify();
  registerCodexQuotaRoutes(
    app,
    (async (_url, options) => {
      const token = (options?.headers as Record<string, string>).Authorization;
      order.push(token === 'Bearer new' ? 'query-new' : 'query-old');
      return token === 'Bearer new'
        ? Response.json({ rate_limit: { primary_window: { used_percent: 10 } } })
        : Response.json({ error: { code: 'token_expired' } }, { status: 401 });
    }) as typeof fetch,
    async () => {
      renewals++;
      order.push('renew');
      auth('new');
    },
  );
  const query = (body = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/accounts/codex/codex/quota',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root, ...body },
    });
  try {
    assert.equal((await query()).statusCode, 200);
    assert.equal(renewals, 0);
    const renewed = await query({ renewExpired: true });
    assert.equal(renewed.statusCode, 200, renewed.body);
    assert.equal(renewed.json().quota.status, 'ok');
    assert.equal(renewals, 1);
    assert.deepEqual(order, ['query-old', 'renew', 'query-new']);
    await query({ renewExpired: true });
    assert.equal(renewals, 1, 'healthy queries do not renew');
  } finally {
    await app.close();
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('official diagnostic adapter stops after credential rotation and never starts a model or a binding change', async () => {
  const { chmodSync } = await import('node:fs');
  const { renewCodexQuotaLogin } = await import('../src/config/codex-quota-renewal.js');
  const { resolveByAccountRef } = await import('../src/config/account-resolver.js');
  const root = mkdtempSync(join(tmpdir(), 'f322-renew-driver-')),
    saved = { ...process.env };
  Object.assign(process.env, { HOME: root, CAT_CAFE_GLOBAL_CONFIG_ROOT: root, CAT_CAFE_DATA_DIR: join(root, 'data') });
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_SQLITE_HOME;
  const home = join(root, 'login');
  mkdirSync(home);
  writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store="file"\n');
  const claims = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-workspace' },
    }),
  ).toString('base64url');
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({ tokens: { id_token: `x.${claims}.x`, access_token: 'old', account_id: 'fixture-workspace' } }),
  );
  const marker = join(root, 'called.json'),
    command = join(root, 'official-diagnostic');
  writeFileSync(
    command,
    `#!/usr/bin/env node\nconst fs=require('node:fs'),p=require('node:path');const file=p.join(process.env.CODEX_HOME,'auth.json');const auth=JSON.parse(fs.readFileSync(file));auth.tokens.access_token='new';auth.last_refresh=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(auth));fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),pid:process.pid}));setInterval(()=>{},1000);\n`,
  );
  chmodSync(command, 0o700);
  writeCatalogAccount(root, 'codex', { clientId: 'openai', authType: 'oauth', envVars: { CODEX_HOME: home } });
  const profile = resolveByAccountRef(root, 'codex')!;
  const before = Date.now();
  try {
    await Promise.all([renewCodexQuotaLogin(profile, root, command), renewCodexQuotaLogin(profile, root, command)]);
    assert.ok(Date.now() - before < 3000);
    const { readFileSync } = await import('node:fs');
    const report = JSON.parse(readFileSync(marker, 'utf8'));
    assert.deepEqual(report.args, ['-c', 'cli_auth_credentials_store="file"', 'doctor', '--json']);
    assert.equal(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')).tokens.access_token, 'new');
    assert.throws(() => process.kill(report.pid, 0));
  } finally {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
