import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { accountsRoutes } from '../dist/routes/accounts.js';

function writeKimiOAuthHome(homeDir, oauthKey, secretMaterial) {
  mkdirSync(join(homeDir, 'credentials'), { recursive: true });
  writeFileSync(
    join(homeDir, 'config.toml'),
    [
      'default_model = "kimi-code/k3.1-pro"',
      '[providers."managed:kimi-code"]',
      'type = "kimi"',
      '[providers."managed:kimi-code".oauth]',
      'storage = "file"',
      `key = ${JSON.stringify(oauthKey)}`,
      '[models."kimi-code/k3.1-pro"]',
      'provider = "managed:kimi-code"',
      'model = "k3.1-pro"',
      '',
    ].join('\n'),
  );
  const credFile = oauthKey.startsWith('oauth/')
    ? join(homeDir, 'credentials', `${oauthKey.slice('oauth/'.length)}.json`)
    : join(homeDir, `${oauthKey}.json`);
  writeFileSync(credFile, JSON.stringify({ access_token: secretMaterial }), { mode: 0o600 });
}

describe('Account-scoped Kimi quota route (/api/accounts/:profileId/kimi/quota)', () => {
  it('probes with account-specific KIMI_CODE_HOME instead of host HOME, isolates observations per accountRef, and rejects in-flight credential rebinds with 409', async (t) => {
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'f051-kimi-account-quota-')));
    const configRoot = join(sandbox, 'config-root');
    const hostHomeA = join(sandbox, 'host-home-a');
    const customHomeB1 = join(sandbox, 'custom-home-b1');
    const customHomeB2 = join(sandbox, 'custom-home-b2');
    const emptyHome = join(sandbox, 'empty-home');
    mkdirSync(join(configRoot, '.cat-cafe'), { recursive: true });
    mkdirSync(emptyHome, { recursive: true });

    writeKimiOAuthHome(join(hostHomeA, '.kimi-code'), 'oauth/kimi-code', 'token-host-a');
    writeKimiOAuthHome(customHomeB1, 'oauth/kimi-code', 'token-account-b1');
    writeKimiOAuthHome(customHomeB2, 'oauth/kimi-code', 'token-account-b2');

    const envKeys = ['CAT_CAFE_GLOBAL_CONFIG_ROOT', 'HOME', 'KIMI_CODE_HOME', 'KIMI_SHARE_DIR', 'KIMI_CONFIG_FILE'];
    const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = configRoot;
    process.env.HOME = hostHomeA;
    process.env.KIMI_SHARE_DIR = join(hostHomeA, 'ambient-legacy-share');
    process.env.KIMI_CONFIG_FILE = join(hostHomeA, 'ambient-legacy-config.toml');
    delete process.env.KIMI_CODE_HOME;

    t.after(() => {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      rmSync(sandbox, { recursive: true, force: true });
    });

    writeCatalogAccount(configRoot, 'kimi-a', {
      authType: 'oauth',
      clientId: 'kimi',
      displayName: 'Kimi 主号 A',
    });
    writeCatalogAccount(configRoot, 'kimi-b', {
      authType: 'oauth',
      clientId: 'kimi',
      displayName: 'Kimi 二号 B',
      envVars: { KIMI_CODE_HOME: customHomeB1 },
    });
    writeCatalogAccount(configRoot, 'kimi-unlogged', {
      authType: 'oauth',
      clientId: 'kimi',
      displayName: 'Kimi 未登录号',
      envVars: { KIMI_CODE_HOME: emptyHome },
    });

    const seenEnvs = [];
    let pendingGate = null;
    const app = Fastify();
    t.after(async () => {
      await app.close();
    });
    await app.register(accountsRoutes, {
      kimiQuotaSampler: async (launchEnv) => {
        seenEnvs.push({ ...launchEnv });
        if (pendingGate) await pendingGate;
        const observedAt = Date.UTC(2026, 10, 16, 15, 0, 0);
        return {
          observedAt,
          items: [
            {
              label: '5小时使用限额',
              usedPercent: 22,
              percentKind: 'used',
              poolId: 'kimi-rate-limit',
              resetsText: 'Resets in 2h',
              resetsAt: new Date(observedAt + 2 * 3_600_000).toISOString(),
            },
            {
              label: '每周使用限额',
              usedPercent: 64,
              percentKind: 'used',
              poolId: 'kimi-weekly',
              resetsText: 'Resets in 4d',
              resetsAt: new Date(observedAt + 4 * 86_400_000).toISOString(),
            },
          ],
        };
      },
    });

    // 1. Unlogged Kimi account fails closed without invoking sampler
    const unloggedRes = await app.inject({
      method: 'POST',
      url: '/api/accounts/kimi-unlogged/kimi/quota',
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    assert.equal(unloggedRes.statusCode, 503);
    assert.equal(seenEnvs.length, 0);

    // 2. Refreshing kimi-b probes customHomeB1 (never hostHomeA) and isolates observation to kimi-b
    const refreshB = await app.inject({
      method: 'POST',
      url: '/api/accounts/kimi-b/kimi/quota',
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    assert.equal(refreshB.statusCode, 200, refreshB.body);
    assert.equal(seenEnvs.length, 1);
    assert.equal(seenEnvs[0].KIMI_CODE_HOME, customHomeB1);
    assert.equal(seenEnvs[0].KIMI_SHARE_DIR, undefined);
    assert.equal(seenEnvs[0].KIMI_CONFIG_FILE, undefined);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
      headers: { 'x-cat-cafe-user': 'dev' },
    });
    assert.equal(listRes.statusCode, 200);
    const providers = listRes.json().providers;
    const viewA = providers.find((p) => p.id === 'kimi-a');
    const viewB = providers.find((p) => p.id === 'kimi-b');
    const viewUnlogged = providers.find((p) => p.id === 'kimi-unlogged');

    assert.equal(viewA?.kimiLoginReady, true);
    assert.equal(viewA?.kimiQuota, undefined, 'kimi-b observation must never leak onto kimi-a');
    assert.equal(viewUnlogged?.kimiLoginReady, false);
    assert.equal(viewB?.kimiLoginReady, true);
    assert.equal(viewB?.kimiQuota?.owner?.accountRef, 'kimi-b');
    assert.equal(viewB?.kimiQuota?.items?.length, 2);

    // 3. Rebinding kimi-b to customHomeB2 while a refresh is in flight discards the stale observation with 409
    let releaseGate;
    pendingGate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const inFlightPromise = app.inject({
      method: 'POST',
      url: '/api/accounts/kimi-b/kimi/quota',
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    await new Promise((r) => setTimeout(r, 15));
    writeCatalogAccount(configRoot, 'kimi-b', {
      authType: 'oauth',
      clientId: 'kimi',
      displayName: 'Kimi 二号 B',
      envVars: { KIMI_CODE_HOME: customHomeB2 },
    });
    releaseGate();
    const rebindRes = await inFlightPromise;
    assert.equal(rebindRes.statusCode, 409, rebindRes.body);
    assert.equal(rebindRes.json().error, 'kimi_quota_credential_changed');

    const afterRebindList = await app.inject({
      method: 'GET',
      url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
      headers: { 'x-cat-cafe-user': 'dev' },
    });
    const viewBAfter = afterRebindList.json().providers.find((p) => p.id === 'kimi-b');
    assert.equal(viewBAfter?.kimiLoginReady, true);
    assert.equal(
      viewBAfter?.kimiQuota,
      undefined,
      'rebound kimi-b must not display old B1 reading or stale in-flight write',
    );
  });
});
