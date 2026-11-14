import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { registerCodexQuotaRoutes } from '../dist/routes/accounts-codex-quota.js';
import { fetchCodexQuota } from '../dist/routes/codex-quota-fetch.js';
import { refreshOfficialQuotaViaOAuth } from '../dist/routes/quota.js';
import { quotaProxyFixture } from './helpers/quota-proxy-fixture.js';

test('default account quota route uses configured HTTPS proxy and keeps each account bearer', async () => {
  const saved = { ...process.env };
  const f = await quotaProxyFixture();
  const app = Fastify();
  Object.assign(process.env, {
    HOME: f.root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: f.root,
    CAT_CAFE_DATA_DIR: join(f.root, 'data'),
    HTTPS_PROXY: f.proxyUrl,
    https_proxy: f.proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
  });
  delete process.env.CODEX_HOME;
  delete process.env.NODE_USE_ENV_PROXY;
  for (const ref of ['codex-a', 'codex-b']) {
    const home = join(f.root, ref);
    mkdirSync(home);
    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify({ tokens: { access_token: `fixture-${ref}`, account_id: `workspace-${ref}` } }),
    );
    writeCatalogAccount(f.root, ref, { clientId: 'openai', authType: 'oauth', envVars: { CODEX_HOME: home } });
  }
  registerCodexQuotaRoutes(app);
  try {
    for (const ref of ['codex-a', 'codex-b']) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/accounts/${ref}/codex/quota`,
        headers: { 'x-cat-cafe-user': 'fixture' },
        payload: { projectPath: f.root },
      });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().quota.status, 'ok', r.body);
      assert.equal(r.json().quota.items[0].usedPercent, 23);
    }
    assert.deepEqual(f.connects, ['chatgpt.com:443', 'chatgpt.com:443']);
    assert.deepEqual(
      f.requests.map((r) => [r.method, r.url, r.headers.authorization, r.headers['chatgpt-account-id']]),
      [
        ['GET', '/backend-api/wham/usage', 'Bearer fixture-codex-a', 'workspace-codex-a'],
        ['GET', '/backend-api/wham/usage', 'Bearer fixture-codex-b', 'workspace-codex-b'],
      ],
    );
    assert.equal(process.env.NODE_USE_ENV_PROXY, undefined);

    f.state.status = 401;
    f.state.body = JSON.stringify({ error: { code: 'token_expired' } });
    const expired = await app.inject({
      method: 'POST',
      url: '/api/accounts/codex-a/codex/quota',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: f.root },
    });
    assert.equal(expired.json().quota.failure.kind, 'renewal_required');
    assert.match(expired.json().quota.failure.officialDetail, /HTTP 401/);
    assert.equal(expired.json().quota.lastSuccess.items[0].usedPercent, 23);

    f.state.status = 200;
    f.state.body = JSON.stringify({ rate_limit: { primary_window: { used_percent: 31 } } });
    const aggregate = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: null,
      codexCredentials: {
        accessToken: 'fixture-aggregate',
        refreshToken: 'never-use',
        accountId: 'workspace-aggregate',
      },
    });
    assert.equal(aggregate.codex.items, 1, JSON.stringify(aggregate));
    assert.equal(f.requests.at(-1).headers.authorization, 'Bearer fixture-aggregate');
    assert.equal(f.requests.at(-1).headers['chatgpt-account-id'], 'workspace-aggregate');
  } finally {
    await app.close();
    await f.close();
    process.env = saved;
  }
});

test('empty lowercase proxy falls back to the configured uppercase address', async () => {
  const saved = { ...process.env };
  const f = await quotaProxyFixture();
  Object.assign(process.env, { HTTPS_PROXY: ` ${f.proxyUrl} `, NO_PROXY: '', no_proxy: '' });
  try {
    for (const blank of ['', '  ']) {
      process.env.https_proxy = blank;
      const response = await fetchCodexQuota('https://chatgpt.com/backend-api/wham/usage');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).rate_limit.primary_window.used_percent, 23);
    }
    assert.deepEqual(f.connects, ['chatgpt.com:443', 'chatgpt.com:443']);
  } finally {
    await f.close();
    process.env = saved;
  }
});

test('quota transport honors NO_PROXY and does not change unrelated global fetch', async () => {
  const saved = { ...process.env };
  const f = await quotaProxyFixture();
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    HTTPS_PROXY: f.proxyUrl,
    https_proxy: f.proxyUrl,
    NO_PROXY: '',
    no_proxy: 'chatgpt.com',
  });
  try {
    await assert.rejects(
      fetchCodexQuota('https://chatgpt.com/backend-api/wham/usage'),
      /fixture blocks direct official network/,
    );
    assert.equal(f.connects.length, 0);
    assert.equal(globalThis.fetch, originalFetch);
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    await assert.rejects(fetchCodexQuota('https://chatgpt.com/backend-api/wham/usage'), /fetch failed/);
    assert.equal(f.connects.length, 0);
  } finally {
    await f.close();
    process.env = saved;
  }
});

test('quota transport rejects redirects, untrusted TLS and oversize bodies; abort closes the request', async () => {
  const saved = { ...process.env };
  const f = await quotaProxyFixture();
  Object.assign(process.env, { HTTPS_PROXY: f.proxyUrl, https_proxy: f.proxyUrl, NO_PROXY: '', no_proxy: '' });
  const url = 'https://chatgpt.com/backend-api/wham/usage';
  try {
    f.state.status = 302;
    await assert.rejects(
      fetchCodexQuota(url, { headers: { authorization: 'Bearer fixture-secret' } }),
      /redirect_not_allowed/,
    );
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.connects, ['chatgpt.com:443']);
    f.state.status = 200;
    f.state.trustCertificate = false;
    await assert.rejects(fetchCodexQuota(url), /self.signed certificate/i);
    assert.equal(f.requests.length, 1);
    f.state.trustCertificate = true;
    f.state.body = 'x'.repeat(1024 * 1024 + 1);
    await assert.rejects(fetchCodexQuota(url), /response_too_large/);
    f.state.stall = true;
    await assert.rejects(fetchCodexQuota(url, { signal: AbortSignal.timeout(100) }), /aborted/i);
    await assert.rejects(fetchCodexQuota('https://do-not-forward.invalid/token'), /request_not_allowed/);
    await assert.rejects(fetchCodexQuota(url, { method: 'POST' }), /request_not_allowed/);
    await assert.rejects(fetchCodexQuota(new Request(url, { method: 'POST' })), /request_not_allowed/);
  } finally {
    await f.close();
    process.env = saved;
  }
});
