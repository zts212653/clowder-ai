import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import Fastify from 'fastify';
import { agyOAuthFile, prepareAgyAccount } from '../dist/config/agy-account.js';
import { resolveAgyQuotaExecutionOwner } from '../dist/config/agy-quota-identity.js';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { accountsRoutes } from '../dist/routes/accounts.js';
import { buildAgyUsageProcessEnv } from '../dist/routes/accounts-agy-quota.js';
import { parseAgyCliUsageOutput } from '../dist/routes/agy-cli-usage-parser.js';

function encodeGoKeyringOAuth({ acc, ref, expiryIso, email }) {
  const payload = {
    auth_method: 'consumer',
    ...(email ? { id_token_email: email } : {}),
    token: {
      access_token: acc,
      refresh_token: ref,
      token_type: 'Bearer',
      expiry: expiryIso,
    },
  };
  return `go-keyring-base64:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

function writePrivateMacKeychainItem(profileHome, secretValue) {
  const kcDir = join(profileHome, 'Library', 'Keychains');
  const prefDir = join(profileHome, 'Library', 'Preferences');
  mkdirSync(kcDir, { recursive: true, mode: 0o700 });
  mkdirSync(prefDir, { recursive: true, mode: 0o700 });
  const kcPath = join(kcDir, 'cat-cafe.keychain-db');
  const env = { HOME: profileHome, PATH: '/usr/bin:/bin' };
  try {
    execFileSync('/usr/bin/security', ['create-keychain', '-p', '', kcPath], { env, stdio: 'ignore' });
  } catch {
    // Already created
  }
  chmodSync(kcPath, 0o600);
  execFileSync('/usr/bin/security', ['unlock-keychain', '-p', '', kcPath], { env, stdio: 'ignore' });
  if (secretValue !== null) {
    execFileSync(
      '/usr/bin/security',
      ['add-generic-password', '-U', '-a', 'antigravity', '-s', 'gemini', '-w', secretValue, kcPath],
      { env, stdio: 'ignore' },
    );
  }
  return kcPath;
}

function writeAgyConsumerToken(credentialHome, { acc, ref, expiryIso }) {
  writeFileSync(
    agyOAuthFile(credentialHome),
    JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: acc,
        refresh_token: ref,
        expiry: expiryIso,
      },
    }),
    { mode: 0o600 },
  );
  chmodSync(agyOAuthFile(credentialHome), 0o600);
}

function writeCatCatalogWithAgyProfiles(projectRoot, profiles) {
  mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
  const catalog = {
    version: 2,
    breeds: [
      {
        id: 'siamese',
        catId: profiles[0]?.catId ?? 'gemini-carbon',
        name: '暹罗猫',
        displayName: '暹罗猫',
        avatar: '/avatars/gemini.png',
        color: { primary: '#2563eb', secondary: '#93c5fd' },
        mentionPatterns: profiles.map((p) => `@${p.catId}`),
        roleDescription: 'fixture',
        defaultVariantId: `${profiles[0]?.catId ?? 'gemini-carbon'}-default`,
        variants: profiles.map((p) => ({
          id: `${p.catId}-default`,
          catId: p.catId,
          carrier: 'cli',
          clientId: 'google',
          defaultModel: p.model,
          mcpSupport: true,
          accountRef: p.accountRef ?? 'gemini',
          mentionPatterns: [`@${p.catId}`],
          cli: { command: 'agy', outputFormat: 'stream-json' },
          agyProfile: {
            enabled: true,
            carrier: 'native',
            profileId: p.profileId,
            homeRoot: p.homeRoot,
            model: p.model,
            autoApprove: true,
            trustedWorkspaces: [],
          },
        })),
      },
    ],
    roster: Object.fromEntries(
      profiles.map((p) => [
        p.catId,
        {
          family: p.family ?? 'siamese',
          roles: ['assistant'],
          lead: false,
          available: p.available !== false,
          evaluation: 'fixture',
        },
      ]),
    ),
    reviewPolicy: {
      requireDifferentFamily: false,
      preferActiveInThread: false,
      preferLead: false,
      excludeUnavailable: true,
    },
    coCreator: { name: 'Owner', aliases: ['Owner'], mentionPatterns: ['@owner'] },
  };
  writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(catalog, null, 2));
  writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(catalog, null, 2));
}

describe('Official AGY CLI /usage JSON parser (parseAgyCliUsageOutput)', () => {
  it('separates Gemini Models and Claude/GPT Models into distinct poolIds and never fabricates missing or zero reset_time', () => {
    const rawJson = JSON.stringify({
      conversation_id: '',
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.4866,
                  reset_time: '2026-11-20T23:28:16Z',
                },
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 0.8298,
                  reset_time: '2026-11-17T08:52:21Z',
                },
              ],
            },
            {
              name: 'Claude and GPT models',
              buckets: [
                {
                  id: '3p-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.9797,
                  reset_time: '2026-11-20T03:25:36Z',
                },
                {
                  id: '3p-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 1,
                  // Unstarted window / Go zero time must NOT become a fake timestamp
                  reset_time: '0001-01-01T00:00:00Z',
                },
              ],
            },
          ],
        },
      },
    });

    const items = parseAgyCliUsageOutput(rawJson);
    assert.equal(items.length, 4);

    assert.deepEqual(items[0], {
      label: 'Gemini · 每周使用限额',
      usedPercent: 48.66,
      percentKind: 'remaining',
      poolId: 'agy-gemini',
      resetsAt: '2026-11-20T23:28:16Z',
    });
    assert.deepEqual(items[1], {
      label: 'Gemini · 5小时使用限额',
      usedPercent: 82.98,
      percentKind: 'remaining',
      poolId: 'agy-gemini',
      resetsAt: '2026-11-17T08:52:21Z',
    });
    assert.deepEqual(items[2], {
      label: 'Claude / GPT · 每周使用限额',
      usedPercent: 97.97,
      percentKind: 'remaining',
      poolId: 'agy-claude-gpt',
      resetsAt: '2026-11-20T03:25:36Z',
    });
    assert.deepEqual(items[3], {
      label: 'Claude / GPT · 5小时使用限额',
      usedPercent: 100,
      percentKind: 'remaining',
      poolId: 'agy-claude-gpt',
    });

    assert.deepEqual(parseAgyCliUsageOutput('{"status":"ERROR"}'), []);
    assert.deepEqual(parseAgyCliUsageOutput('not-json'), []);
  });
});

describe('Account-scoped AGY quota route (/api/accounts/:profileId/agy/quota)', () => {
  it('isolates managed account.agy observations, preserves credentialVersion across access_token auto-refresh, and rejects OAuth grant swaps in flight with 409', async (t) => {
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'f051-agy-account-quota-')));
    const configRoot = join(sandbox, 'config-root');
    mkdirSync(join(configRoot, '.cat-cafe'), { recursive: true });

    const envKeys = ['CAT_CAFE_GLOBAL_CONFIG_ROOT', 'HOME', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'];
    const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = configRoot;
    process.env.HOME = sandbox;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;

    t.after(() => {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      rmSync(sandbox, { recursive: true, force: true });
    });

    const agyRefA = 'agy-11111111-1111-4111-8111-111111111111';
    const agyRefB = 'agy-22222222-2222-4222-8222-222222222222';
    const agyRefUnlogged = 'agy-33333333-3333-4333-8333-333333333333';

    const layoutA = prepareAgyAccount(configRoot, agyRefA);
    const layoutB = prepareAgyAccount(configRoot, agyRefB);
    const layoutUnlogged = prepareAgyAccount(configRoot, agyRefUnlogged);

    const now = Date.now();
    writeAgyConsumerToken(layoutA.credentialHome, {
      acc: 'fix-a1',
      ref: 'ref-a1',
      expiryIso: new Date(now + 3_600_000).toISOString(),
    });
    // Start B with an expired access_token + valid refresh_token ('refreshable')
    writeAgyConsumerToken(layoutB.credentialHome, {
      acc: 'fix-b1-old',
      ref: 'ref-b1-keep',
      expiryIso: new Date(now - 60_000).toISOString(),
    });

    writeCatalogAccount(configRoot, agyRefA, {
      authType: 'oauth',
      clientId: 'google',
      displayName: 'AGY 一号',
      agy: layoutA,
    });
    writeCatalogAccount(configRoot, agyRefB, {
      authType: 'oauth',
      clientId: 'google',
      displayName: 'AGY 二号',
      agy: layoutB,
    });
    writeCatalogAccount(configRoot, agyRefUnlogged, {
      authType: 'oauth',
      clientId: 'google',
      displayName: 'AGY 未登录号',
      agy: layoutUnlogged,
    });

    const seenTargets = [];
    let onSampleHook = null;
    const app = Fastify();
    t.after(async () => {
      await app.close();
    });

    await app.register(accountsRoutes, {
      agyQuotaSampler: async (target) => {
        seenTargets.push(target);
        if (onSampleHook) await onSampleHook(target);
        const observedAt = Date.UTC(2026, 10, 17, 8, 0, 0);
        return {
          observedAt,
          items: [
            {
              label: 'Gemini · 每周使用限额',
              usedPercent: 49,
              percentKind: 'remaining',
              poolId: 'agy-gemini',
              resetsAt: '2026-11-20T23:28:16Z',
            },
            {
              label: 'Claude / GPT · 每周使用限额',
              usedPercent: 98,
              percentKind: 'remaining',
              poolId: 'agy-claude-gpt',
              resetsAt: '2026-11-20T03:25:36Z',
            },
          ],
        };
      },
    });

    // 1. Unlogged AGY account fails closed without invoking sampler
    const unloggedRes = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agyRefUnlogged}/agy/quota`,
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    assert.equal(unloggedRes.statusCode, 503);
    assert.equal(seenTargets.length, 0);

    // 2. Refreshing agyRefB while 'refreshable' simulates official agy renewing access_token in-place (same refresh_token) -> must succeed!
    onSampleHook = async () => {
      writeAgyConsumerToken(layoutB.credentialHome, {
        acc: 'fix-b1-new',
        ref: 'ref-b1-keep',
        expiryIso: new Date(Date.now() + 3_600_000).toISOString(),
      });
    };
    const refreshB = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agyRefB}/agy/quota`,
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    onSampleHook = null;
    assert.equal(refreshB.statusCode, 200, refreshB.body);
    assert.equal(seenTargets.length, 1);
    assert.equal(seenTargets[0].kind, 'cli_file');
    assert.equal(seenTargets[0].homePath, layoutB.credentialHome);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
      headers: { 'x-cat-cafe-user': 'dev' },
    });
    assert.equal(listRes.statusCode, 200);
    const providers = listRes.json().providers;
    const viewA = providers.find((p) => p.id === agyRefA);
    const viewB = providers.find((p) => p.id === agyRefB);
    const viewUnlogged = providers.find((p) => p.id === agyRefUnlogged);

    assert.equal(viewA?.agyQuotaReady, true);
    assert.equal(viewA?.agyQuota, undefined, 'agy-b observation must never leak onto agy-a');
    assert.equal(viewUnlogged?.agyQuotaReady, false);
    assert.equal(viewB?.agyQuotaReady, true);
    assert.equal(viewB?.agyQuota?.owner?.accountRef, agyRefB);
    assert.equal(viewB?.agyQuota?.items?.length, 2);

    // Ensure raw SQLite file never contains raw tokens
    const rawSqlite = readFileSync(join(configRoot, '.cat-cafe', 'agy-quota.sqlite'), 'latin1');
    assert.equal(rawSqlite.includes('ref-b1-keep'), false);
    assert.equal(rawSqlite.includes('fix-b1-new'), false);

    // 3. Re-logging agyRefB with a NEW refresh_token in flight rejects stale write with 409
    let releaseSwap;
    let notifyEntered;
    const swapGate = new Promise((resolve) => {
      releaseSwap = resolve;
    });
    const enteredSample = new Promise((resolve) => {
      notifyEntered = resolve;
    });
    onSampleHook = async () => {
      notifyEntered();
      await swapGate;
    };
    const inFlight = app.inject({
      method: 'POST',
      url: `/api/accounts/${agyRefB}/agy/quota`,
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    await enteredSample;
    writeAgyConsumerToken(layoutB.credentialHome, {
      acc: 'fix-b2-swap',
      ref: 'ref-b2-swap',
      expiryIso: new Date(Date.now() + 3_600_000).toISOString(),
    });
    releaseSwap();
    const swapRes = await inFlight;
    assert.equal(swapRes.statusCode, 409, swapRes.body);
    assert.equal(swapRes.json().error, 'agy_quota_credential_changed');

    const afterSwap = await app.inject({
      method: 'GET',
      url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
      headers: { 'x-cat-cafe-user': 'dev' },
    });
    const viewBAfter = afterSwap.json().providers.find((p) => p.id === agyRefB);
    assert.equal(viewBAfter?.agyQuotaReady, true);
    assert.equal(viewBAfter?.agyQuota, undefined, 'swapped OAuth grant must not inherit previous account reading');
  });

  it('supports builtin gemini OAuth account when active AGY native profiles share one verified identity, and hides reading as unknown on identity conflict', async (t) => {
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'f051-agy-native-gemini-')));
    const configRoot = join(sandbox, 'config-root');
    const profilesRoot = join(sandbox, 'agy-profiles');
    mkdirSync(profilesRoot, { recursive: true });

    const envKeys = ['CAT_CAFE_GLOBAL_CONFIG_ROOT', 'HOME', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'];
    const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = configRoot;
    process.env.HOME = sandbox;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;

    t.after(() => {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      rmSync(sandbox, { recursive: true, force: true });
    });

    for (const prof of ['gemini-argon', 'agy-opus55-native']) {
      mkdirSync(join(profilesRoot, prof, 'Library', 'Keychains'), { recursive: true, mode: 0o700 });
      writeFileSync(join(profilesRoot, prof, 'Library', 'Keychains', 'cat-cafe.keychain-db'), 'mock-keychain', {
        mode: 0o600,
      });
    }

    writeCatalogAccount(configRoot, 'gemini', {
      authType: 'oauth',
      displayName: 'Gemini (OAuth)',
    });
    writeCatCatalogWithAgyProfiles(configRoot, [
      {
        catId: 'gemini-carbon',
        profileId: 'gemini-argon',
        homeRoot: profilesRoot,
        model: 'gemini-4-carbon-high',
      },
      {
        catId: 'agy-opus55',
        profileId: 'agy-opus55-native',
        homeRoot: profilesRoot,
        model: 'claude-opus-5-5-high',
        family: 'ragdoll',
      },
    ]);

    let keychainIdentityByHome = new Map([
      [join(profilesRoot, 'gemini-argon'), 'acct-shared-owner'],
      [join(profilesRoot, 'agy-opus55-native'), 'acct-shared-owner'],
    ]);

    const app = Fastify();
    t.after(async () => {
      await app.close();
    });
    await app.register(accountsRoutes, {
      agyKeychainIdentityInspector: (profileHome) => keychainIdentityByHome.get(profileHome),
      agyQuotaSampler: async () => ({
        observedAt: Date.UTC(2026, 10, 17, 8, 5, 0),
        items: [
          {
            label: 'Gemini · 每周使用限额',
            usedPercent: 48.66,
            percentKind: 'remaining',
            poolId: 'agy-gemini',
            resetsAt: '2026-11-20T23:28:16Z',
          },
          {
            label: 'Claude / GPT · 每周使用限额',
            usedPercent: 97.97,
            percentKind: 'remaining',
            poolId: 'agy-claude-gpt',
            resetsAt: '2026-11-20T03:25:36Z',
          },
        ],
      }),
    });

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/accounts/gemini/agy/quota',
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    assert.equal(refreshRes.statusCode, 200, refreshRes.body);

    const okList = await app.inject({
      method: 'GET',
      url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
      headers: { 'x-cat-cafe-user': 'dev' },
    });
    const geminiOk = okList.json().providers.find((p) => p.id === 'gemini');
    assert.equal(geminiOk?.agyQuotaReady, true);
    assert.equal(geminiOk?.agyQuota?.owner?.accountRef, 'gemini');
    assert.equal(geminiOk?.agyQuota?.items?.length, 2);

    // Ensure raw identity string never persisted into SQLite
    const rawSqlite = readFileSync(join(configRoot, '.cat-cafe', 'agy-quota.sqlite'), 'latin1');
    assert.equal(rawSqlite.includes('acct-shared-owner'), false);

    // Now simulate conflicting accounts across the two profiles -> ownership cannot be proven -> unknown!
    keychainIdentityByHome = new Map([
      [join(profilesRoot, 'gemini-argon'), 'acct-owner-one'],
      [join(profilesRoot, 'agy-opus55-native'), 'acct-owner-two'],
    ]);

    const conflictList = await app.inject({
      method: 'GET',
      url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
      headers: { 'x-cat-cafe-user': 'dev' },
    });
    const geminiConflict = conflictList.json().providers.find((p) => p.id === 'gemini');
    assert.equal(geminiConflict?.agyQuotaReady, false);
    assert.equal(geminiConflict?.agyQuota, undefined);

    // Case B: Profile A verified, Profile B identity unknown -> cannot prove shared ownership -> must fail closed as unknown!
    keychainIdentityByHome = new Map([
      [join(profilesRoot, 'gemini-argon'), 'acct-shared-owner'],
      // agy-opus55-native intentionally missing / unknown
    ]);
    const partialUnknownList = await app.inject({
      method: 'GET',
      url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
      headers: { 'x-cat-cafe-user': 'dev' },
    });
    const geminiPartialUnknown = partialUnknownList.json().providers.find((p) => p.id === 'gemini');
    assert.equal(
      geminiPartialUnknown?.agyQuotaReady,
      false,
      'must not accept Profile A identity when active Profile B identity is unknown',
    );
    assert.equal(geminiPartialUnknown?.agyQuota, undefined);

    const partialRefreshRes = await app.inject({
      method: 'POST',
      url: '/api/accounts/gemini/agy/quota',
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    assert.equal(partialRefreshRes.statusCode, 503);
    assert.equal(partialRefreshRes.json().error, 'agy_quota_owner_unknown');

    // Case C: Profile A & B verified, plus a 3rd active cat whose profile directory does not exist -> must also fail closed!
    keychainIdentityByHome = new Map([
      [join(profilesRoot, 'gemini-argon'), 'acct-shared-owner'],
      [join(profilesRoot, 'agy-opus55-native'), 'acct-shared-owner'],
    ]);
    writeCatCatalogWithAgyProfiles(configRoot, [
      {
        catId: 'gemini-carbon',
        profileId: 'gemini-argon',
        homeRoot: profilesRoot,
        model: 'gemini-4-carbon-high',
      },
      {
        catId: 'agy-opus55',
        profileId: 'agy-opus55-native',
        homeRoot: profilesRoot,
        model: 'claude-opus-5-5-high',
        family: 'ragdoll',
      },
      {
        catId: 'gemini-hydrogen',
        profileId: 'missing-on-disk-profile',
        homeRoot: profilesRoot,
        model: 'gemini-4-hydrogen-high',
      },
    ]);
    const missingDirList = await app.inject({
      method: 'GET',
      url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
      headers: { 'x-cat-cafe-user': 'dev' },
    });
    const geminiMissingDir = missingDirList.json().providers.find((p) => p.id === 'gemini');
    assert.equal(
      geminiMissingDir?.agyQuotaReady,
      false,
      'must not accept partial ownership when an active bound profile directory is missing',
    );
    assert.equal(geminiMissingDir?.agyQuota, undefined);

    // Case D: Production split topology (CAT_CAFE_WORKSPACE_ROOT has stale empty cat-catalog.json while CAT_CAFE_RUNTIME_ROOT owns active AGY native members)
    const workspaceRoot = join(sandbox, 'split-workspace');
    const runtimeRoot = join(sandbox, 'split-runtime');
    mkdirSync(join(workspaceRoot, '.cat-cafe'), { recursive: true });
    mkdirSync(join(runtimeRoot, '.cat-cafe'), { recursive: true });
    // Stale workspace catalog with zero Google cats
    writeFileSync(
      join(workspaceRoot, '.cat-cafe', 'cat-catalog.json'),
      JSON.stringify({ version: 2, breeds: [], roster: {} }),
    );
    writeCatalogAccount(workspaceRoot, 'gemini', {
      authType: 'oauth',
      displayName: 'Gemini (OAuth)',
    });
    // Live runtime catalog with verified shared AGY native profiles
    writeCatCatalogWithAgyProfiles(runtimeRoot, [
      {
        catId: 'gemini-carbon',
        profileId: 'gemini-argon',
        homeRoot: profilesRoot,
        model: 'gemini-4-carbon-high',
      },
      {
        catId: 'agy-opus55',
        profileId: 'agy-opus55-native',
        homeRoot: profilesRoot,
        model: 'claude-opus-5-5-high',
        family: 'ragdoll',
      },
    ]);

    const prevWs = process.env.CAT_CAFE_WORKSPACE_ROOT;
    const prevRt = process.env.CAT_CAFE_RUNTIME_ROOT;
    const prevCfg = process.env.CAT_CAFE_CONFIG_ROOT;
    const prevGlobal = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_CONFIG_ROOT = runtimeRoot;
    try {
      const splitList = await app.inject({
        method: 'GET',
        url: '/api/accounts',
        headers: { 'x-cat-cafe-user': 'dev' },
      });
      assert.equal(splitList.statusCode, 200, splitList.body);
      const splitGemini = splitList.json().providers.find((p) => p.id === 'gemini');
      assert.equal(
        splitGemini?.agyQuotaReady,
        true,
        'production split topology must read active AGY members from runtime root instead of stale workspace cat-catalog.json',
      );
    } finally {
      if (prevWs === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = prevWs;
      if (prevRt === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = prevRt;
      if (prevCfg === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = prevCfg;
      if (prevGlobal === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevGlobal;
    }
  });

  it(
    'inspects real private Keychain OAuth payloads instead of fixed slot name antigravity, rejects in-flight login swaps, and ignores leftover OAuth files in native mode',
    { skip: process.platform !== 'darwin' },
    async (t) => {
      const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'f051-agy-real-kc-')));
      const configRoot = join(sandbox, 'config-root');
      const profilesRoot = join(sandbox, 'agy-profiles');
      mkdirSync(profilesRoot, { recursive: true, mode: 0o700 });

      const envKeys = [
        'CAT_CAFE_GLOBAL_CONFIG_ROOT',
        'HOME',
        'GOOGLE_API_KEY',
        'GEMINI_API_KEY',
        'SSH_TTY',
        'SSH_CLIENT',
        'SSH_CONNECTION',
      ];
      const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = configRoot;
      process.env.HOME = sandbox;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.SSH_TTY;
      delete process.env.SSH_CLIENT;
      delete process.env.SSH_CONNECTION;

      t.after(() => {
        for (const key of envKeys) {
          if (savedEnv[key] === undefined) delete process.env[key];
          else process.env[key] = savedEnv[key];
        }
        rmSync(sandbox, { recursive: true, force: true });
      });

      const homeA = join(profilesRoot, 'prof-a');
      const homeB = join(profilesRoot, 'prof-b');
      mkdirSync(join(homeA, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
      mkdirSync(join(homeB, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
      chmodSync(homeA, 0o700);
      chmodSync(homeB, 0o700);

      writeCatalogAccount(configRoot, 'gemini', {
        authType: 'oauth',
        displayName: 'Gemini (OAuth)',
      });

      // 1. P1-1a: Slot-only / non-OAuth value under acct="antigravity" must NOT count as a verified login!
      writeCatCatalogWithAgyProfiles(configRoot, [
        { catId: 'gemini-carbon', profileId: 'prof-a', homeRoot: profilesRoot, model: 'gemini-4-carbon-high' },
      ]);
      writePrivateMacKeychainItem(homeA, 'antigravity');
      const slotOnlyOwner = await resolveAgyQuotaExecutionOwner(configRoot, 'gemini');
      assert.equal(
        slotOnlyOwner?.snapshot.credentialVersion,
        undefined,
        'fixed slot name antigravity without valid OAuth grant must remain unknown',
      );

      // 2. P1-1b: Two profiles with same acct="antigravity" slot but DIFFERENT Google principals/grants must fail closed!
      writeCatCatalogWithAgyProfiles(configRoot, [
        { catId: 'gemini-carbon', profileId: 'prof-a', homeRoot: profilesRoot, model: 'gemini-4-carbon-high' },
        {
          catId: 'agy-opus55',
          profileId: 'prof-b',
          homeRoot: profilesRoot,
          model: 'claude-opus-5-5-high',
          family: 'ragdoll',
        },
      ]);
      const exp = new Date(Date.now() + 3_600_000).toISOString();
      writePrivateMacKeychainItem(
        homeA,
        encodeGoKeyringOAuth({ acc: 'fix-kc-a1', ref: 'ref-kc-a1', expiryIso: exp, email: 'one@fixture.invalid' }),
      );
      writePrivateMacKeychainItem(
        homeB,
        encodeGoKeyringOAuth({ acc: 'fix-kc-b1', ref: 'ref-kc-b1', expiryIso: exp, email: 'two@fixture.invalid' }),
      );
      const diffKeychainOwner = await resolveAgyQuotaExecutionOwner(configRoot, 'gemini');
      assert.equal(
        diffKeychainOwner?.snapshot.credentialVersion,
        undefined,
        'different Google accounts stored under identical acct="antigravity" slot must fail closed',
      );

      // 3. P1-2: Leftover OAuth file A in native profile homeA must NEVER override Keychain or satisfy missing Keychain!
      writeCatCatalogWithAgyProfiles(configRoot, [
        { catId: 'gemini-carbon', profileId: 'prof-a', homeRoot: profilesRoot, model: 'gemini-4-carbon-high' },
      ]);
      writeAgyConsumerToken(homeA, {
        acc: 'fix-leftover-file-a',
        ref: 'ref-leftover-file-a',
        expiryIso: exp,
      });
      // While Keychain in homeA holds Account B (`current-b@fixture.invalid`):
      writePrivateMacKeychainItem(
        homeA,
        encodeGoKeyringOAuth({
          acc: 'fix-current-kc-b',
          ref: 'ref-current-kc-b',
          expiryIso: exp,
          email: 'current-b@fixture.invalid',
        }),
      );
      const ownerWithLeftover = await resolveAgyQuotaExecutionOwner(configRoot, 'gemini');
      assert.equal(ownerWithLeftover?.target.kind, 'native_profile');
      assert.equal(
        ownerWithLeftover?.target.usesKeychain,
        true,
        'native profile on macOS must use Keychain rather than switching to leftover OAuth file',
      );
      assert.ok(ownerWithLeftover?.snapshot.credentialVersion);
      const cvBeforeFileMutate = ownerWithLeftover.snapshot.credentialVersion;
      // Mutating leftover file A must NOT change native profile credentialVersion!
      writeAgyConsumerToken(homeA, {
        acc: 'fix-leftover-file-a2',
        ref: 'ref-leftover-file-a2',
        expiryIso: exp,
      });
      const ownerAfterFileMutate = await resolveAgyQuotaExecutionOwner(configRoot, 'gemini');
      assert.equal(ownerAfterFileMutate?.snapshot.credentialVersion, cvBeforeFileMutate);

      // If Keychain has no gemini item while leftover OAuth file remains, native mode must still return unknown!
      rmSync(join(homeA, 'Library', 'Keychains', 'cat-cafe.keychain-db'), { force: true });
      writePrivateMacKeychainItem(homeA, null);
      const emptyKcWithFile = await resolveAgyQuotaExecutionOwner(configRoot, 'gemini');
      assert.equal(
        emptyKcWithFile?.snapshot.credentialVersion,
        undefined,
        'empty Keychain must not silently fall back to leftover OAuth file in native mode',
      );

      // 4. P1-1c: In-flight Keychain login swap during POST /api/accounts/gemini/agy/quota must reject stale sample with 409!
      writePrivateMacKeychainItem(
        homeA,
        encodeGoKeyringOAuth({
          acc: 'fix-kc-flight-1',
          ref: 'ref-kc-flight-1',
          expiryIso: exp,
          email: 'flight-1@fixture.invalid',
        }),
      );
      let onSample = null;
      const seenTargets = [];
      const app = Fastify();
      t.after(async () => {
        await app.close();
      });
      await app.register(accountsRoutes, {
        agyQuotaSampler: async (target) => {
          seenTargets.push(target);
          if (onSample) await onSample();
          return {
            observedAt: Date.UTC(2026, 10, 17, 9, 0, 0),
            items: [
              {
                label: 'Gemini · 每周使用限额',
                usedPercent: 52,
                percentKind: 'remaining',
                poolId: 'agy-gemini',
                resetsAt: '2026-11-20T23:28:16Z',
              },
            ],
          };
        },
      });

      onSample = async () => {
        writePrivateMacKeychainItem(
          homeA,
          encodeGoKeyringOAuth({
            acc: 'fix-kc-flight-2',
            ref: 'ref-kc-flight-2',
            expiryIso: exp,
            email: 'flight-2@fixture.invalid',
          }),
        );
      };
      const swapRes = await app.inject({
        method: 'POST',
        url: '/api/accounts/gemini/agy/quota',
        headers: { 'x-cat-cafe-user': 'dev' },
        payload: { projectPath: configRoot },
      });
      onSample = null;
      assert.equal(swapRes.statusCode, 409, swapRes.body);
      assert.equal(swapRes.json().error, 'agy_quota_credential_changed');
      assert.equal(seenTargets[0]?.usesKeychain, true);

      // And normal access_token renewal in Keychain (same refresh_token & email) succeeds with 200!
      onSample = async () => {
        writePrivateMacKeychainItem(
          homeA,
          encodeGoKeyringOAuth({
            acc: 'fix-kc-flight-2-renewed',
            ref: 'ref-kc-flight-2',
            expiryIso: new Date(Date.now() + 7_200_000).toISOString(),
            email: 'flight-2@fixture.invalid',
          }),
        );
      };
      const okRes = await app.inject({
        method: 'POST',
        url: '/api/accounts/gemini/agy/quota',
        headers: { 'x-cat-cafe-user': 'dev' },
        payload: { projectPath: configRoot },
      });
      assert.equal(okRes.statusCode, 200, okRes.body);
    },
  );

  it('enforces auth-source parity across darwin keychain, inherited SSH file mode, non-darwin desktop fail-closed, and buildAgyUsageProcessEnv', async (t) => {
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'f051-agy-auth-parity-')));
    const configRoot = join(sandbox, 'config-root');
    const profilesRoot = join(sandbox, 'agy-profiles');
    const homeA = join(profilesRoot, 'prof-a');
    mkdirSync(join(homeA, 'Library', 'Keychains'), { recursive: true, mode: 0o700 });
    mkdirSync(join(homeA, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
    chmodSync(homeA, 0o700);
    writeFileSync(join(homeA, 'Library', 'Keychains', 'cat-cafe.keychain-db'), 'kc-bytes', { mode: 0o600 });

    const prevGlobal = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    const prevHome = process.env.HOME;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = configRoot;
    process.env.HOME = sandbox;
    t.after(() => {
      if (prevGlobal === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevGlobal;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(sandbox, { recursive: true, force: true });
    });

    writeCatalogAccount(configRoot, 'gemini', { authType: 'oauth', displayName: 'Gemini (OAuth)' });
    writeCatCatalogWithAgyProfiles(configRoot, [
      { catId: 'gemini-carbon', profileId: 'prof-a', homeRoot: profilesRoot, model: 'gemini-4-carbon-high' },
    ]);

    const exp = new Date(Date.now() + 3_600_000).toISOString();
    writeAgyConsumerToken(homeA, { acc: 'fix-ssh-file', ref: 'ref-ssh-file', expiryIso: exp });

    // 1. Non-darwin without SSH env (e.g. Linux desktop with unmanaged D-Bus keyring) -> fails closed to unknown even if file exists!
    const linuxDesktop = await resolveAgyQuotaExecutionOwner(configRoot, 'gemini', {
      platform: 'linux',
      env: {},
    });
    assert.equal(linuxDesktop?.snapshot.credentialVersion, undefined);

    // 2. Inherited SSH session -> uses OAuth file (matching isolatedOAuthEnv inheritance in agy-native-launch) and never calls security!
    let securityCalls = 0;
    const sshOwner = await resolveAgyQuotaExecutionOwner(configRoot, 'gemini', {
      platform: 'darwin',
      env: { SSH_TTY: '/dev/pts/1' },
      securityExec: () => {
        securityCalls += 1;
        return '';
      },
    });
    assert.equal(securityCalls, 0);
    assert.equal(sshOwner?.target.usesKeychain, false);
    assert.ok(sshOwner?.snapshot.credentialVersion);

    // 3. Darwin without SSH -> uses Keychain via securityExec, ignoring leftover file, and rejects slot-only output!
    const slotOwner = await resolveAgyQuotaExecutionOwner(configRoot, 'gemini', {
      platform: 'darwin',
      env: {},
      securityExec: (_home, args) => (args[0] === 'find-generic-password' ? 'antigravity\n' : ''),
    });
    assert.equal(slotOwner?.snapshot.credentialVersion, undefined);

    const validKcPayload = encodeGoKeyringOAuth({
      acc: 'fix-kc-sim',
      ref: 'ref-kc-sim',
      expiryIso: exp,
      email: 'sim@fixture.invalid',
    });
    const kcOwner = await resolveAgyQuotaExecutionOwner(configRoot, 'gemini', {
      platform: 'darwin',
      env: {},
      securityExec: (_home, args) => (args[0] === 'find-generic-password' ? `${validKcPayload}\n` : ''),
    });
    assert.equal(kcOwner?.target.usesKeychain, true);
    assert.ok(kcOwner?.snapshot.credentialVersion);
    assert.notEqual(kcOwner?.snapshot.credentialVersion, sshOwner?.snapshot.credentialVersion);

    // 4. buildAgyUsageProcessEnv parity
    const kcEnv = buildAgyUsageProcessEnv({ kind: 'native_profile', homePath: homeA, usesKeychain: true });
    assert.equal(kcEnv.SSH_TTY, undefined);
    assert.equal(kcEnv.SSH_CLIENT, undefined);
    assert.equal(kcEnv.SSH_CONNECTION, undefined);

    const cliEnv = buildAgyUsageProcessEnv({ kind: 'cli_file', homePath: homeA, usesKeychain: false });
    assert.equal(cliEnv.SSH_TTY, 'cat-cafe-file-auth');
  });

  it(
    'keeps unrelated API requests responsive (<100ms) while GET /api/accounts awaits a slow private Keychain, without cross-request Promise sharing or stale caching',
    { skip: process.platform !== 'darwin' },
    async (t) => {
      const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'f051-agy-nonblocking-kc-')));
      const configRoot = join(sandbox, 'config-root');
      const profilesRoot = join(sandbox, 'agy-profiles');
      const homeA = join(profilesRoot, 'prof-a');
      mkdirSync(join(homeA, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
      chmodSync(homeA, 0o700);

      const envKeys = [
        'CAT_CAFE_GLOBAL_CONFIG_ROOT',
        'HOME',
        'GOOGLE_API_KEY',
        'GEMINI_API_KEY',
        'SSH_TTY',
        'SSH_CLIENT',
        'SSH_CONNECTION',
      ];
      const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = configRoot;
      process.env.HOME = sandbox;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.SSH_TTY;
      delete process.env.SSH_CLIENT;
      delete process.env.SSH_CONNECTION;

      const exp = new Date(Date.now() + 3_600_000).toISOString();
      writeCatalogAccount(configRoot, 'gemini', { authType: 'oauth', displayName: 'Gemini (OAuth)' });
      writeCatCatalogWithAgyProfiles(configRoot, [
        { catId: 'gemini-carbon', profileId: 'prof-a', homeRoot: profilesRoot, model: 'gemini-4-carbon-high' },
      ]);
      writePrivateMacKeychainItem(
        homeA,
        encodeGoKeyringOAuth({
          acc: 'fix-nb-1',
          ref: 'ref-nb-1',
          expiryIso: exp,
          email: 'nb-1@fixture.invalid',
        }),
      );

      const require = createRequire(import.meta.url);
      const cp = require('node:child_process');
      const origExecFileSync = cp.execFileSync;
      const origExecFile = cp.execFile;
      let securityInvocations = 0;
      const delayMs = 200;

      cp.execFileSync = function patchedExecFileSync(file, args, options) {
        if (file === '/usr/bin/security') {
          securityInvocations += 1;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        }
        return origExecFileSync.call(this, file, args, options);
      };
      cp.execFile = function patchedExecFile(file, ...rest) {
        if (file === '/usr/bin/security') {
          securityInvocations += 1;
          const timer = setTimeout(() => {
            origExecFile.call(this, file, ...rest);
          }, delayMs);
          return timer;
        }
        return origExecFile.call(this, file, ...rest);
      };
      syncBuiltinESMExports();

      const app = Fastify();
      app.get('/health-ping', async () => ({ status: 'ok' }));
      await app.register(accountsRoutes);
      const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

      t.after(async () => {
        cp.execFileSync = origExecFileSync;
        cp.execFile = origExecFile;
        syncBuiltinESMExports();
        await app.close();
        for (const key of envKeys) {
          if (savedEnv[key] === undefined) delete process.env[key];
          else process.env[key] = savedEnv[key];
        }
        rmSync(sandbox, { recursive: true, force: true });
      });

      const accountsUrl = `${baseUrl}/api/accounts?projectPath=${encodeURIComponent(configRoot)}`;
      const probeResult = await new Promise((resolve, reject) => {
        const worker = new Worker(
          `
          const { parentPort, workerData } = require('node:worker_threads');
          const { performance } = require('node:perf_hooks');
          (async () => {
            const accountsStart = performance.now();
            const accountsPromise = fetch(workerData.accountsUrl, { headers: { 'x-cat-cafe-user': 'dev' } });
            await new Promise((r) => setTimeout(r, 50));
            const healthStart = performance.now();
            const healthRes = await fetch(workerData.healthUrl);
            const healthMs = performance.now() - healthStart;
            const accountsRes = await accountsPromise;
            const accountsMs = performance.now() - accountsStart;
            const accountsJson = await accountsRes.json();
            parentPort.postMessage({
              healthStatus: healthRes.status,
              healthMs,
              accountsStatus: accountsRes.status,
              accountsMs,
              accountsJson,
            });
          })().catch((err) => {
            setImmediate(() => { throw err; });
          });
          `,
          { eval: true, workerData: { accountsUrl, healthUrl: `${baseUrl}/health-ping` } },
        );
        worker.once('message', resolve);
        worker.once('error', reject);
      });

      assert.equal(probeResult.healthStatus, 200);
      assert.equal(probeResult.accountsStatus, 200);
      const geminiRow = probeResult.accountsJson.providers.find((p) => p.id === 'gemini');
      assert.equal(geminiRow?.agyQuotaReady, true, 'production Keychain OAuth payload must resolve agyQuotaReady=true');
      assert.ok(
        probeResult.accountsMs >= 350,
        `expected slow Keychain accounts call >=350ms, got ${probeResult.accountsMs.toFixed(1)}ms`,
      );
      assert.ok(
        probeResult.healthMs < 100,
        `expected unrelated /health-ping <100ms during slow Keychain GET /api/accounts, got ${probeResult.healthMs.toFixed(2)}ms`,
      );
      assert.equal(
        securityInvocations,
        2,
        'single GET /api/accounts should run unlock-keychain + find-generic-password',
      );

      // Concurrent burst of 3 GET /api/accounts requests executes independently without cross-request Promise sharing (+6 security calls -> 8 total)
      const [r1, r2, r3] = await Promise.all([
        fetch(accountsUrl, { headers: { 'x-cat-cafe-user': 'dev' } }),
        fetch(accountsUrl, { headers: { 'x-cat-cafe-user': 'dev' } }),
        fetch(accountsUrl, { headers: { 'x-cat-cafe-user': 'dev' } }),
      ]);
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(r3.status, 200);
      assert.equal(
        securityInvocations,
        8,
        'concurrent GET requests must run independent fresh Keychain reads without sharing older pending promises',
      );

      // Once settled, zero cross-request cache remains: clearing Keychain item immediately yields agyQuotaReady=false
      rmSync(join(homeA, 'Library', 'Keychains', 'cat-cafe.keychain-db'), { force: true });
      writePrivateMacKeychainItem(homeA, null);
      const afterClearRes = await fetch(accountsUrl, { headers: { 'x-cat-cafe-user': 'dev' } });
      assert.equal(afterClearRes.status, 200);
      const afterClearJson = await afterClearRes.json();
      const clearedGemini = afterClearJson.providers.find((p) => p.id === 'gemini');
      assert.equal(
        clearedGemini?.agyQuotaReady,
        false,
        'no stale Keychain identity cache may persist after in-flight request settles',
      );
    },
  );

  it(
    'forces a fresh post-sample Keychain read in recordAgyQuota instead of joining an older in-flight GET read across a login swap (409)',
    { skip: process.platform !== 'darwin' },
    async (t) => {
      const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'f051-agy-coalesce-race-')));
      const configRoot = join(sandbox, 'config-root');
      const profilesRoot = join(sandbox, 'agy-profiles');
      const homeA = join(profilesRoot, 'prof-a');
      mkdirSync(join(homeA, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
      chmodSync(homeA, 0o700);

      const envKeys = [
        'CAT_CAFE_GLOBAL_CONFIG_ROOT',
        'HOME',
        'GOOGLE_API_KEY',
        'GEMINI_API_KEY',
        'SSH_TTY',
        'SSH_CLIENT',
        'SSH_CONNECTION',
      ];
      const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = configRoot;
      process.env.HOME = sandbox;
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.SSH_TTY;
      delete process.env.SSH_CLIENT;
      delete process.env.SSH_CONNECTION;

      const exp = new Date(Date.now() + 3_600_000).toISOString();
      writeCatalogAccount(configRoot, 'gemini', { authType: 'oauth', displayName: 'Gemini (OAuth)' });
      writeCatCatalogWithAgyProfiles(configRoot, [
        { catId: 'gemini-carbon', profileId: 'prof-a', homeRoot: profilesRoot, model: 'gemini-4-carbon-high' },
      ]);
      writePrivateMacKeychainItem(
        homeA,
        encodeGoKeyringOAuth({
          acc: 'fix-race-a',
          ref: 'ref-race-a',
          expiryIso: exp,
          email: 'race-a@fixture.invalid',
        }),
      );

      const require = createRequire(import.meta.url);
      const cp = require('node:child_process');
      const nodeFs = require('node:fs');
      const origExecFile = cp.execFile;
      const origLstatSync = nodeFs.lstatSync;

      let onKeychainStatReached = null;
      nodeFs.lstatSync = function patchedLstatSync(targetPath, ...rest) {
        const res = origLstatSync.call(this, targetPath, ...rest);
        if (typeof targetPath === 'string' && targetPath.endsWith('cat-cafe.keychain-db') && onKeychainStatReached) {
          const cb = onKeychainStatReached;
          onKeychainStatReached = null;
          cb();
        }
        return res;
      };

      let holdNextFindPassword = false;
      let onCapturedHeldRead = null;
      let heldCallbackGate = Promise.resolve();

      cp.execFile = function patchedRaceExecFile(file, args, options, callback) {
        if (
          file === '/usr/bin/security' &&
          Array.isArray(args) &&
          args[0] === 'find-generic-password' &&
          holdNextFindPassword &&
          typeof callback === 'function'
        ) {
          holdNextFindPassword = false;
          const gate = heldCallbackGate;
          const notify = onCapturedHeldRead;
          return origExecFile.call(this, file, args, options, (err, stdout, stderr) => {
            if (notify) notify();
            gate.then(() => callback(err, stdout, stderr));
          });
        }
        return origExecFile.call(this, file, args, options, callback);
      };
      syncBuiltinESMExports();

      let onEnteredSampler = null;
      let samplerGate = Promise.resolve();

      const app = Fastify();
      await app.register(accountsRoutes, {
        agyQuotaSampler: async () => {
          if (onEnteredSampler) onEnteredSampler();
          await samplerGate;
          return {
            observedAt: Date.UTC(2026, 10, 17, 13, 0, 0),
            items: [
              {
                label: 'Gemini · 每周使用限额',
                usedPercent: 61,
                percentKind: 'remaining',
                poolId: 'agy-gemini',
                resetsAt: '2026-11-21T00:00:00Z',
              },
            ],
          };
        },
      });

      t.after(async () => {
        cp.execFile = origExecFile;
        nodeFs.lstatSync = origLstatSync;
        syncBuiltinESMExports();
        await app.close();
        for (const key of envKeys) {
          if (savedEnv[key] === undefined) delete process.env[key];
          else process.env[key] = savedEnv[key];
        }
        rmSync(sandbox, { recursive: true, force: true });
      });

      // Case A (POST write fence): Start POST /api/accounts/gemini/agy/quota; pre-sample owner = A, parks in sampler
      let releaseSampler = null;
      samplerGate = new Promise((resolve) => {
        releaseSampler = resolve;
      });
      const enteredSampler = new Promise((resolve) => {
        onEnteredSampler = resolve;
      });
      const postPromise = app.inject({
        method: 'POST',
        url: '/api/accounts/gemini/agy/quota',
        headers: { 'x-cat-cafe-user': 'dev' },
        payload: { projectPath: configRoot },
      });
      await enteredSampler;
      onEnteredSampler = null;

      // Concurrent GET /api/accounts reads Account A from Keychain and holds its callback in flight
      let releasePreSwapCallback = null;
      heldCallbackGate = new Promise((resolve) => {
        releasePreSwapCallback = resolve;
      });
      const capturedPreSwapRead = new Promise((resolve) => {
        onCapturedHeldRead = resolve;
      });
      holdNextFindPassword = true;
      const getPromise = app.inject({
        method: 'GET',
        url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
        headers: { 'x-cat-cafe-user': 'dev' },
      });
      await capturedPreSwapRead;
      onCapturedHeldRead = null;

      // Swap Keychain login to Account B while GET's A read is still pending, then release sampler
      writePrivateMacKeychainItem(
        homeA,
        encodeGoKeyringOAuth({
          acc: 'fix-race-b',
          ref: 'ref-race-b',
          expiryIso: exp,
          email: 'race-b@fixture.invalid',
        }),
      );
      const reachedPostVerifyInspector = new Promise((resolve) => {
        onKeychainStatReached = resolve;
      });
      releaseSampler();
      await reachedPostVerifyInspector;
      releasePreSwapCallback();

      const [postRes, getRes] = await Promise.all([postPromise, getPromise]);
      assert.equal(getRes.statusCode, 200);
      assert.equal(
        postRes.statusCode,
        409,
        `expected 409 agy_quota_credential_changed when Keychain swapped to B before sample completed, got ${postRes.statusCode}: ${postRes.body}`,
      );
      assert.equal(postRes.json().error, 'agy_quota_credential_changed');

      // Verify subsequent GET sees Account B ready with NO leaked quota observation
      const afterGet = await app.inject({
        method: 'GET',
        url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
        headers: { 'x-cat-cafe-user': 'dev' },
      });
      assert.equal(afterGet.statusCode, 200);
      const geminiAfter = afterGet.json().providers.find((p) => p.id === 'gemini');
      assert.equal(geminiAfter?.agyQuotaReady, true);
      assert.equal(geminiAfter?.agyQuota, undefined);

      // Case B (pure GET linearizability): Save quota for Account B, hold GET-1 on B, swap to Account C, fire GET-2 -> GET-2 must NOT return B's quota!
      samplerGate = Promise.resolve();
      const saveBRes = await app.inject({
        method: 'POST',
        url: '/api/accounts/gemini/agy/quota',
        headers: { 'x-cat-cafe-user': 'dev' },
        payload: { projectPath: configRoot },
      });
      assert.equal(saveBRes.statusCode, 200, saveBRes.body);
      const bCredentialVersion = saveBRes.json().agyQuota?.owner?.credentialVersion;
      assert.ok(bCredentialVersion);

      let releaseGet1Callback = null;
      heldCallbackGate = new Promise((resolve) => {
        releaseGet1Callback = resolve;
      });
      const capturedGet1Read = new Promise((resolve) => {
        onCapturedHeldRead = resolve;
      });
      holdNextFindPassword = true;
      const get1Promise = app.inject({
        method: 'GET',
        url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
        headers: { 'x-cat-cafe-user': 'dev' },
      });
      await capturedGet1Read;
      onCapturedHeldRead = null;

      // Swap Keychain login to Account C (which has no stored quota), then issue new GET-2 BEFORE GET-1 settles
      writePrivateMacKeychainItem(
        homeA,
        encodeGoKeyringOAuth({
          acc: 'fix-race-c',
          ref: 'ref-race-c',
          expiryIso: exp,
          email: 'race-c@fixture.invalid',
        }),
      );
      const reachedGet2Inspector = new Promise((resolve) => {
        onKeychainStatReached = resolve;
      });
      const get2Promise = app.inject({
        method: 'GET',
        url: `/api/accounts?projectPath=${encodeURIComponent(configRoot)}`,
        headers: { 'x-cat-cafe-user': 'dev' },
      });
      await reachedGet2Inspector;
      releaseGet1Callback();

      const [get1Res, get2Res] = await Promise.all([get1Promise, get2Promise]);
      assert.equal(get1Res.statusCode, 200);
      assert.equal(get2Res.statusCode, 200);
      const geminiGet2 = get2Res.json().providers.find((p) => p.id === 'gemini');
      assert.equal(geminiGet2?.agyQuotaReady, true);
      assert.equal(
        geminiGet2?.agyQuota,
        undefined,
        `GET-2 started after login swap to C must not inherit pre-swap Account B quota (${JSON.stringify(geminiGet2?.agyQuota)})`,
      );
    },
  );

  it('does not coalesce in-flight POST /api/accounts/:profileId/agy/quota across a login swap so POST-2 never inherits pre-swap Account A quota', async (t) => {
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'f051-agy-post-singleflight-race-')));
    const configRoot = join(sandbox, 'config-root');
    const profilesRoot = join(sandbox, 'agy-profiles');
    const homeA = join(profilesRoot, 'prof-a');
    mkdirSync(join(homeA, 'Library', 'Keychains'), { recursive: true, mode: 0o700 });
    mkdirSync(join(homeA, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
    chmodSync(homeA, 0o700);
    writeFileSync(join(homeA, 'Library', 'Keychains', 'cat-cafe.keychain-db'), 'kc-bytes', { mode: 0o600 });

    const envKeys = [
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
      'CAT_CAFE_CONFIG_ROOT',
      'CAT_CAFE_WORKSPACE_ROOT',
      'CAT_CAFE_RUNTIME_ROOT',
      'HOME',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'SSH_TTY',
      'SSH_CLIENT',
      'SSH_CONNECTION',
    ];
    const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = configRoot;
    process.env.CAT_CAFE_CONFIG_ROOT = configRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = configRoot;
    process.env.CAT_CAFE_RUNTIME_ROOT = configRoot;
    process.env.HOME = sandbox;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.SSH_TTY;
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_CONNECTION;

    writeCatalogAccount(configRoot, 'gemini', { authType: 'oauth', displayName: 'Gemini (OAuth)' });
    writeCatCatalogWithAgyProfiles(configRoot, [
      { catId: 'gemini-carbon', profileId: 'prof-a', homeRoot: profilesRoot, model: 'gemini-4-carbon-high' },
    ]);

    let currentLogin = 'acct-post-login-a';
    let inspections = 0;
    let samplerCalls = 0;
    let notifyPost1PostVerify = null;
    let releasePost1PostVerify = null;
    let notifyPost2OwnInspection = null;
    const post1EnteredPostVerify = new Promise((resolve) => {
      notifyPost1PostVerify = resolve;
    });
    const post1PostVerifyGate = new Promise((resolve) => {
      releasePost1PostVerify = resolve;
    });
    const post2EnteredOwnInspection = new Promise((resolve) => {
      notifyPost2OwnInspection = resolve;
    });

    const targetPendingKey = JSON.stringify([configRoot, 'gemini']);
    const origMapGet = Map.prototype.get;
    let watchPendingLookup = false;
    let notifyPost2PendingLookup = null;
    const post2JoinedPendingLookup = new Promise((resolve) => {
      notifyPost2PendingLookup = resolve;
    });
    Map.prototype.get = function patchedPendingGet(key) {
      if (watchPendingLookup && key === targetPendingKey && notifyPost2PendingLookup) {
        watchPendingLookup = false;
        notifyPost2PendingLookup();
      }
      return origMapGet.call(this, key);
    };

    const app = Fastify();
    await app.register(accountsRoutes, {
      agyKeychainIdentityInspector: async () => {
        inspections += 1;
        const captured = currentLogin;
        if (inspections === 2) {
          notifyPost1PostVerify();
          await post1PostVerifyGate;
        } else if (inspections === 3 && notifyPost2OwnInspection) {
          notifyPost2OwnInspection();
        }
        return captured;
      },
      agyQuotaSampler: async () => {
        samplerCalls += 1;
        const isFirst = samplerCalls === 1;
        return {
          observedAt: Date.UTC(2026, 10, 17, 13, 30, samplerCalls),
          items: [
            {
              label: 'Gemini · 每周使用限额',
              usedPercent: isFirst ? 52 : 88,
              percentKind: 'remaining',
              poolId: 'agy-gemini',
              resetsAt: '2026-11-21T00:00:00Z',
            },
          ],
        };
      },
    });

    t.after(async () => {
      Map.prototype.get = origMapGet;
      await app.close();
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      rmSync(sandbox, { recursive: true, force: true });
    });

    const post1Promise = app.inject({
      method: 'POST',
      url: '/api/accounts/gemini/agy/quota',
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    await post1EnteredPostVerify;

    // Login switches from A to B while POST-1 is awaiting its post-sample verification return
    currentLogin = 'acct-post-login-b';
    watchPendingLookup = true;

    const post2Promise = app.inject({
      method: 'POST',
      url: '/api/accounts/gemini/agy/quota',
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    await Promise.race([
      post2JoinedPendingLookup,
      post2EnteredOwnInspection,
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);

    releasePost1PostVerify();

    const [post1Res, post2Res] = await Promise.all([post1Promise, post2Promise]);
    assert.equal(post1Res.statusCode, 200, post1Res.body);
    assert.equal(post2Res.statusCode, 200, post2Res.body);

    const post1Quota = post1Res.json().agyQuota;
    const post2Quota = post2Res.json().agyQuota;
    assert.equal(post1Quota?.items?.[0]?.usedPercent, 52);
    assert.notEqual(
      post2Quota?.owner?.credentialVersion,
      post1Quota?.owner?.credentialVersion,
      'POST-2 issued after switching to Account B must not inherit Account A credentialVersion',
    );
    assert.equal(
      post2Quota?.items?.[0]?.usedPercent,
      88,
      `POST-2 issued after switching to Account B must sample Account B (88%) instead of reusing Account A (got ${post2Quota?.items?.[0]?.usedPercent}%)`,
    );
    assert.equal(samplerCalls, 2, 'POST-2 must execute its own quota sample rather than sharing POST-1 query');
    assert.equal(inspections, 4, 'POST-2 must execute its own pre-sample and post-sample ownership inspections');

    // Same-login out-of-order completion: older sample (t1, 41%) parks while newer sample (t2 > t1, 61%) commits first;
    // when older sample finishes under the SAME login B, it must NOT false-report 409 and SQLite must retain newer 61%!
    let holdOlderSample = null;
    let notifyOlderSampleEntered = null;
    const olderSampleEntered = new Promise((resolve) => {
      notifyOlderSampleEntered = resolve;
    });
    const olderSampleGate = new Promise((resolve) => {
      holdOlderSample = resolve;
    });

    const appSameLogin = Fastify();
    t.after(async () => {
      await appSameLogin.close();
    });
    let sameLoginSampleCalls = 0;
    let sameLoginInspections = 0;
    let returnInvalidObservedAt = false;
    await appSameLogin.register(accountsRoutes, {
      agyKeychainIdentityInspector: async () => {
        sameLoginInspections += 1;
        return 'acct-post-login-b';
      },
      agyQuotaSampler: async () => {
        if (returnInvalidObservedAt) {
          return {
            observedAt: Number.NaN,
            items: [
              {
                label: 'Gemini · 每周使用限额',
                usedPercent: 12,
                percentKind: 'remaining',
                poolId: 'agy-gemini',
              },
            ],
          };
        }
        sameLoginSampleCalls += 1;
        const callIndex = sameLoginSampleCalls;
        if (callIndex === 1) {
          notifyOlderSampleEntered();
          await olderSampleGate;
          return {
            observedAt: Date.UTC(2026, 10, 17, 14, 0, 1),
            items: [
              {
                label: 'Gemini · 每周使用限额',
                usedPercent: 41,
                percentKind: 'remaining',
                poolId: 'agy-gemini',
                resetsAt: '2026-11-21T00:00:00Z',
              },
            ],
          };
        }
        return {
          observedAt: Date.UTC(2026, 10, 17, 14, 0, 2),
          items: [
            {
              label: 'Gemini · 每周使用限额',
              usedPercent: 61,
              percentKind: 'remaining',
              poolId: 'agy-gemini',
              resetsAt: '2026-11-21T00:00:00Z',
            },
          ],
        };
      },
    });

    const olderPostPromise = appSameLogin.inject({
      method: 'POST',
      url: '/api/accounts/gemini/agy/quota',
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    await olderSampleEntered;

    const newerPostRes = await appSameLogin.inject({
      method: 'POST',
      url: '/api/accounts/gemini/agy/quota',
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    assert.equal(newerPostRes.statusCode, 200, newerPostRes.body);
    assert.equal(newerPostRes.json().agyQuota?.items?.[0]?.usedPercent, 61);

    holdOlderSample();
    const olderPostRes = await olderPostPromise;
    assert.equal(
      olderPostRes.statusCode,
      200,
      `older same-login sample superseded by newer sample must return 200 instead of false 409, got ${olderPostRes.statusCode}: ${olderPostRes.body}`,
    );
    assert.equal(
      olderPostRes.json().agyQuota?.items?.[0]?.usedPercent,
      61,
      'older superseded POST must return the stored newer 61% observation without overwriting it with 41%',
    );
    assert.equal(sameLoginInspections, 4);

    // Validation failure (e.g. NaN observedAt) must still fail closed with 503 even when a valid 61% row already exists
    returnInvalidObservedAt = true;
    const invalidRes = await appSameLogin.inject({
      method: 'POST',
      url: '/api/accounts/gemini/agy/quota',
      headers: { 'x-cat-cafe-user': 'dev' },
      payload: { projectPath: configRoot },
    });
    assert.equal(invalidRes.statusCode, 503, invalidRes.body);
    assert.equal(invalidRes.json().error, 'agy_quota_reading_unavailable');
  });
});
