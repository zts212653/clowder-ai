/**
 * F051 — Real Quota Dashboard API tests
 *
 * Tests the /api/quota endpoint that returns cached quota data
 * from official sources (ccusage for Claude, browser for Codex).
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

async function buildApp() {
  const Fastify = (await import('fastify')).default;
  const quotaModule = await import('../dist/routes/quota.js');
  quotaModule.resetQuotaCachesForTests?.();
  const { quotaRoutes } = quotaModule;
  const app = Fastify();
  await app.register(quotaRoutes);
  await app.ready();
  return app;
}

describe('GET /api/quota', () => {
  it('returns quota structure for all three platforms', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/quota' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.claude.platform, 'claude');
      assert.equal(body.codex.platform, 'codex');
      assert.equal(body.kimi.platform, 'kimi');
      assert.equal(body.antigravity.platform, 'antigravity');
      assert.ok(body.fetchedAt);
    } finally {
      await app.close();
    }
  });

  it('antigravity starts with empty usageItems (no placeholder status)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/quota' });
      const body = res.json();
      assert.equal(body.antigravity.platform, 'antigravity');
      assert.deepEqual(body.antigravity.usageItems, []);
      assert.equal(body.antigravity.status, undefined);
    } finally {
      await app.close();
    }
  });

  it('claude starts with lastChecked=null before any refresh', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/quota' });
      const body = res.json();
      assert.equal(body.claude.lastChecked, null);
    } finally {
      await app.close();
    }
  });

  it('codex starts with empty usageItems before any data push', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/quota' });
      const body = res.json();
      assert.deepEqual(body.codex.usageItems, []);
      assert.equal(body.codex.lastChecked, null);
    } finally {
      await app.close();
    }
  });

  it('returns Kimi as unavailable before any official refresh', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/quota' });
      const body = res.json();
      assert.equal(body.kimi.status, 'unavailable');
      assert.deepEqual(body.kimi.usageItems, []);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/quota/probes', () => {
  it('returns probe registry with official-browser disabled by default', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const app = await buildApp();
    try {
      const quotaModule = await import('../dist/routes/quota.js');
      quotaModule.setKimiCliProbeOverrideForTests?.(async () => []);
      const res = await app.inject({ method: 'GET', url: '/api/quota/probes' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(Array.isArray(body.probes), true);
      const official = body.probes.find((probe) => probe.id === 'official-browser');
      const kimi = body.probes.find((probe) => probe.id === 'kimi-cli');
      assert.equal(official?.enabled, false);
      assert.equal(official?.status, 'disabled');
      assert.ok(kimi, 'should expose kimi probe');
      assert.deepEqual(kimi?.targets, ['kimi']);
      assert.deepEqual(official?.targets, ['codex', 'claude']);
      assert.equal(official?.actions?.[0]?.path, '/api/quota/refresh/official');
      assert.equal(official?.actions?.[0]?.requiresInteractive, false);
      assert.match(official?.reason ?? '', /disabled by default/i);
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      await app.close();
    }
  });

  it('exposes a manual refresh action for Kimi official quota', async () => {
    const app = await buildApp();
    try {
      const quotaModule = await import('../dist/routes/quota.js');
      quotaModule.setKimiCliProbeOverrideForTests?.(async () => []);
      const res = await app.inject({ method: 'GET', url: '/api/quota/probes' });
      const body = res.json();
      const kimi = body.probes.find((probe) => probe.id === 'kimi-cli');
      assert.equal(kimi?.actions?.[0]?.path, '/api/quota/refresh/kimi');
      assert.equal(kimi?.actions?.[0]?.requiresInteractive, false);
    } finally {
      await app.close();
    }
  });

  it('marks official-browser probe enabled when env toggle is set', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/quota/probes' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      const official = body.probes.find((probe) => probe.id === 'official-browser');
      assert.equal(official?.enabled, true);
      assert.equal(official?.status, 'ok');
      assert.match(official?.reason ?? '', /OAuth/i);
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      await app.close();
    }
  });

  it('marks kimi-cli status=error when Kimi is refreshable but no quota data has been loaded yet', async () => {
    const app = await buildApp();
    try {
      const quotaModule = await import('../dist/routes/quota.js');
      quotaModule.setKimiCliProbeOverrideForTests?.(async () => []);
      const res = await app.inject({ method: 'GET', url: '/api/quota/probes' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      const kimi = body.probes.find((probe) => probe.id === 'kimi-cli');
      assert.equal(kimi?.enabled, true);
      assert.equal(kimi?.status, 'error');
      assert.match(kimi?.reason ?? '', /暂无 Kimi CLI 额度数据|Kimi/i);
    } finally {
      await app.close();
    }
  });

  it('marks official-browser probe status=error after official refresh failure', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const oldClaudeCredentialsPath = process.env.CLAUDE_CREDENTIALS_PATH;
    const oldCodexCredentialsPath = process.env.CODEX_CREDENTIALS_PATH;
    const oldCodexHome = process.env.CODEX_HOME;
    const isolatedCodexHome = await mkdtemp(join(tmpdir(), 'quota-empty-codex-home-'));
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    process.env.CLAUDE_CREDENTIALS_PATH = join(isolatedCodexHome, 'missing-claude-credentials.json');
    delete process.env.CODEX_CREDENTIALS_PATH;
    process.env.CODEX_HOME = isolatedCodexHome;
    const app = await buildApp();
    try {
      // No credentials files → 400 with "No OAuth credentials" error
      const refreshRes = await app.inject({ method: 'POST', url: '/api/quota/refresh/official' });
      assert.equal(refreshRes.statusCode, 400);
      const refreshBody = refreshRes.json();
      assert.match(refreshBody.error, /CODEX_CREDENTIALS_PATH/);
      assert.match(refreshBody.error, /CODEX_HOME\/auth\.json/);
      assert.match(refreshBody.error, /~\/\.codex\/auth\.json/);

      const probeRes = await app.inject({ method: 'GET', url: '/api/quota/probes' });
      assert.equal(probeRes.statusCode, 200);
      const body = probeRes.json();
      const official = body.probes.find((probe) => probe.id === 'official-browser');
      assert.equal(official?.enabled, true);
      assert.equal(official?.status, 'error');
      assert.match(official?.reason ?? '', /credentials/i);
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      if (oldClaudeCredentialsPath != null) process.env.CLAUDE_CREDENTIALS_PATH = oldClaudeCredentialsPath;
      else delete process.env.CLAUDE_CREDENTIALS_PATH;
      if (oldCodexCredentialsPath != null) process.env.CODEX_CREDENTIALS_PATH = oldCodexCredentialsPath;
      else delete process.env.CODEX_CREDENTIALS_PATH;
      if (oldCodexHome != null) process.env.CODEX_HOME = oldCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(isolatedCodexHome, { recursive: true, force: true });
      await app.close();
    }
  });
});

describe('GET /api/quota/summary', () => {
  it('returns compact summary payload for menu-bar/widget consumers', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    const app = await buildApp();
    try {
      await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: {
          usageItems: [{ label: '每周使用限额', usedPercent: 91, percentKind: 'remaining' }],
        },
      });

      const res = await app.inject({ method: 'GET', url: '/api/quota/summary' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(typeof body.fetchedAt, 'string');
      assert.equal(typeof body.risk.level, 'string');
      assert.equal(Array.isArray(body.risk.reasons), true);
      assert.equal(body.platforms.codex.label, '缅因猫 (Codex + GPT-5.2)');
      assert.equal(typeof body.platforms.codex.displayPercent, 'number');
      assert.equal(typeof body.probes.official.status, 'string');
      assert.equal(typeof body.probes.kimi.status, 'string');
      assert.equal(typeof body.actions.refreshOfficialPath, 'string');
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      await app.close();
    }
  });

  it('surfaces the same non-ok Kimi probe status through /api/quota/summary', async () => {
    const app = await buildApp();
    try {
      const quotaModule = await import('../dist/routes/quota.js');
      quotaModule.setKimiCliProbeOverrideForTests?.(async () => []);
      const res = await app.inject({ method: 'GET', url: '/api/quota/summary' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.probes.kimi.enabled, true);
      assert.equal(body.probes.kimi.status, 'error');
      assert.match(body.probes.kimi.reason ?? '', /暂无 Kimi CLI 额度数据|Kimi/i);
    } finally {
      await app.close();
    }
  });

  it('includes Kimi utilization in summary risk calculations', async () => {
    const app = await buildApp();
    try {
      const quotaModule = await import('../dist/routes/quota.js');
      quotaModule.setKimiCliProbeOverrideForTests?.(async () => [
        { label: '每周使用限额', usedPercent: 97, percentKind: 'used', poolId: 'kimi-weekly' },
      ]);
      await app.inject({ method: 'POST', url: '/api/quota/refresh/kimi' });
      const res = await app.inject({ method: 'GET', url: '/api/quota/summary' });
      const body = res.json();
      assert.equal(body.platforms.kimi.status, 'error');
      assert.equal(body.risk.level, 'high');
      assert.equal(
        body.risk.reasons.some((reason) => /97%/.test(String(reason))),
        true,
      );
      assert.equal(body.actions.refreshKimiPath, '/api/quota/refresh/kimi');
    } finally {
      await app.close();
    }
  });

  it('flags high risk when utilization crosses threshold', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    const app = await buildApp();
    try {
      await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: {
          usageItems: [{ label: '每周使用限额', usedPercent: 95, percentKind: 'used' }],
        },
      });
      const res = await app.inject({ method: 'GET', url: '/api/quota/summary' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.risk.level, 'high');
      assert.equal(
        body.risk.reasons.some((reason) => /95%/.test(String(reason))),
        true,
      );
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      await app.close();
    }
  });

  it('summary risk text does not reference CDP or browser terminology (v3)', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    const app = await buildApp();
    try {
      // Trigger error state to get risk reasons populated
      await app.inject({ method: 'POST', url: '/api/quota/refresh/official' });
      const res = await app.inject({ method: 'GET', url: '/api/quota/summary' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      const allReasons = body.risk.reasons.join(' ');
      assert.equal(allReasons.includes('CDP'), false, `risk reasons should not mention CDP: ${allReasons}`);
      assert.equal(allReasons.includes('网页探针'), false, `risk reasons should not mention 网页探针: ${allReasons}`);
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      await app.close();
    }
  });

  it('flags warn when official browser probe is disabled', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const app = await buildApp();
    try {
      await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: {
          usageItems: [{ label: '每周使用限额', usedPercent: 20, percentKind: 'used' }],
        },
      });

      const res = await app.inject({ method: 'GET', url: '/api/quota/summary' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.risk.level, 'warn');
      assert.equal(body.probes.official.status, 'disabled');
      assert.equal(
        body.risk.reasons.some((reason) => /已禁用/.test(String(reason))),
        true,
      );
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      await app.close();
    }
  });
});

describe('POST /api/quota/refresh/official — provider selection', () => {
  it('refreshes only the requested configured provider', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const oldClaudeCredentialsPath = process.env.CLAUDE_CREDENTIALS_PATH;
    const oldCodexCredentialsPath = process.env.CODEX_CREDENTIALS_PATH;
    const oldCodexHome = process.env.CODEX_HOME;
    const oldFetch = globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'quota-selected-provider-'));
    const codexHome = join(dir, 'codex-home');
    await mkdir(codexHome);
    await writeFile(
      join(dir, 'claude.json'),
      JSON.stringify({ accessToken: 'claude-access', refreshToken: 'claude-refresh' }),
      'utf-8',
    );
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'codex-access',
          refresh_token: 'codex-refresh',
          account_id: 'codex-account',
        },
      }),
      'utf-8',
    );
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    process.env.CLAUDE_CREDENTIALS_PATH = join(dir, 'claude.json');
    delete process.env.CODEX_CREDENTIALS_PATH;
    process.env.CODEX_HOME = codexHome;
    const requestedUrls = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 3, reset_at: '2026-07-18T07:00:00.000Z' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/quota/refresh/official',
        payload: { providers: ['codex'] },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(requestedUrls, ['https://chatgpt.com/backend-api/wham/usage']);
      assert.equal(res.json().codexItems, 1);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      if (oldClaudeCredentialsPath != null) process.env.CLAUDE_CREDENTIALS_PATH = oldClaudeCredentialsPath;
      else delete process.env.CLAUDE_CREDENTIALS_PATH;
      if (oldCodexCredentialsPath != null) process.env.CODEX_CREDENTIALS_PATH = oldCodexCredentialsPath;
      else delete process.env.CODEX_CREDENTIALS_PATH;
      if (oldCodexHome != null) process.env.CODEX_HOME = oldCodexHome;
      else delete process.env.CODEX_HOME;
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a missing requested provider while refreshing the available provider', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const oldClaudeCredentialsPath = process.env.CLAUDE_CREDENTIALS_PATH;
    const oldCodexCredentialsPath = process.env.CODEX_CREDENTIALS_PATH;
    const oldCodexHome = process.env.CODEX_HOME;
    const oldFetch = globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'quota-partial-credentials-'));
    const codexHome = join(dir, 'codex-home');
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'codex-access',
          refresh_token: 'codex-refresh',
          account_id: 'codex-account',
        },
      }),
      'utf-8',
    );
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    process.env.CLAUDE_CREDENTIALS_PATH = join(dir, 'missing-claude.json');
    delete process.env.CODEX_CREDENTIALS_PATH;
    process.env.CODEX_HOME = codexHome;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 3, reset_at: '2026-07-18T07:00:00.000Z' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/quota/refresh/official',
        payload: { providers: ['claude', 'codex'] },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.codexItems, 1);
      assert.deepEqual(body.skipped, ['claude']);
      assert.equal(body.warnings?.length, 1);
      assert.match(body.warnings?.[0] ?? '', /Claude.*credentials/i);

      const quota = (await app.inject({ method: 'GET', url: '/api/quota' })).json();
      assert.match(quota.claude.officialError ?? '', /Claude.*credentials/i);
      assert.match(quota.claude.error ?? '', /Claude.*credentials/i);
      assert.equal(quota.codex.error, undefined);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      if (oldClaudeCredentialsPath != null) process.env.CLAUDE_CREDENTIALS_PATH = oldClaudeCredentialsPath;
      else delete process.env.CLAUDE_CREDENTIALS_PATH;
      if (oldCodexCredentialsPath != null) process.env.CODEX_CREDENTIALS_PATH = oldCodexCredentialsPath;
      else delete process.env.CODEX_CREDENTIALS_PATH;
      if (oldCodexHome != null) process.env.CODEX_HOME = oldCodexHome;
      else delete process.env.CODEX_HOME;
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a missing Codex credential while Claude refresh still succeeds', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const oldClaudeCredentialsPath = process.env.CLAUDE_CREDENTIALS_PATH;
    const oldCodexCredentialsPath = process.env.CODEX_CREDENTIALS_PATH;
    const oldCodexHome = process.env.CODEX_HOME;
    const oldFetch = globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'quota-partial-codex-credentials-'));
    await writeFile(
      join(dir, 'claude.json'),
      JSON.stringify({ accessToken: 'claude-access', refreshToken: 'claude-refresh' }),
      'utf-8',
    );
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    process.env.CLAUDE_CREDENTIALS_PATH = join(dir, 'claude.json');
    process.env.CODEX_CREDENTIALS_PATH = join(dir, 'missing-codex.json');
    process.env.CODEX_HOME = join(dir, 'unused-codex-home');
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          five_hour: { used_percent: 7, reset_at: '2026-07-18T10:00:00.000Z' },
          seven_day: { used_percent: 21, reset_at: '2026-07-25T10:00:00.000Z' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/quota/refresh/official',
        payload: { providers: ['claude', 'codex'] },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.claudeItems, 2);
      assert.deepEqual(body.skipped, ['codex']);
      assert.equal(body.warnings?.length, 1);
      assert.match(body.warnings?.[0] ?? '', /Codex.*credentials/i);

      const quota = (await app.inject({ method: 'GET', url: '/api/quota' })).json();
      assert.match(quota.codex.error ?? '', /Codex.*credentials/i);
      assert.equal(quota.claude.officialError, undefined);
      assert.equal(quota.claude.error, undefined);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      if (oldClaudeCredentialsPath != null) process.env.CLAUDE_CREDENTIALS_PATH = oldClaudeCredentialsPath;
      else delete process.env.CLAUDE_CREDENTIALS_PATH;
      if (oldCodexCredentialsPath != null) process.env.CODEX_CREDENTIALS_PATH = oldCodexCredentialsPath;
      else delete process.env.CODEX_CREDENTIALS_PATH;
      if (oldCodexHome != null) process.env.CODEX_HOME = oldCodexHome;
      else delete process.env.CODEX_HOME;
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps Claude cache unchanged when a Codex-only refresh has no credentials', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const oldClaudeCredentialsPath = process.env.CLAUDE_CREDENTIALS_PATH;
    const oldCodexCredentialsPath = process.env.CODEX_CREDENTIALS_PATH;
    const oldCodexHome = process.env.CODEX_HOME;
    const oldFetch = globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'quota-codex-isolation-'));
    const codexHome = join(dir, 'empty-codex-home');
    await mkdir(codexHome);
    await writeFile(
      join(dir, 'claude.json'),
      JSON.stringify({ accessToken: 'claude-access', refreshToken: 'claude-refresh' }),
      'utf-8',
    );
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    process.env.CLAUDE_CREDENTIALS_PATH = join(dir, 'claude.json');
    delete process.env.CODEX_CREDENTIALS_PATH;
    process.env.CODEX_HOME = codexHome;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          five_hour: { used_percent: 7, reset_at: '2026-07-18T10:00:00.000Z' },
          seven_day: { used_percent: 21, reset_at: '2026-07-25T10:00:00.000Z' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const app = await buildApp();
    try {
      const seed = await app.inject({
        method: 'POST',
        url: '/api/quota/refresh/official',
        payload: { providers: ['claude'] },
      });
      assert.equal(seed.statusCode, 200);
      const before = (await app.inject({ method: 'GET', url: '/api/quota' })).json().claude;

      const failed = await app.inject({
        method: 'POST',
        url: '/api/quota/refresh/official',
        payload: { providers: ['codex'] },
      });
      assert.equal(failed.statusCode, 400);
      assert.doesNotMatch(failed.json().error, /Claude/);
      const after = (await app.inject({ method: 'GET', url: '/api/quota' })).json().claude;
      assert.deepEqual(after, before);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      if (oldClaudeCredentialsPath != null) process.env.CLAUDE_CREDENTIALS_PATH = oldClaudeCredentialsPath;
      else delete process.env.CLAUDE_CREDENTIALS_PATH;
      if (oldCodexCredentialsPath != null) process.env.CODEX_CREDENTIALS_PATH = oldCodexCredentialsPath;
      else delete process.env.CODEX_CREDENTIALS_PATH;
      if (oldCodexHome != null) process.env.CODEX_HOME = oldCodexHome;
      else delete process.env.CODEX_HOME;
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps Codex cache unchanged when a Claude-only refresh has no credentials', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const oldClaudeCredentialsPath = process.env.CLAUDE_CREDENTIALS_PATH;
    const oldCodexCredentialsPath = process.env.CODEX_CREDENTIALS_PATH;
    const dir = await mkdtemp(join(tmpdir(), 'quota-claude-isolation-'));
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    process.env.CLAUDE_CREDENTIALS_PATH = join(dir, 'missing-claude.json');
    delete process.env.CODEX_CREDENTIALS_PATH;

    const app = await buildApp();
    try {
      const seed = await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: {
          usageItems: [
            {
              label: '每周使用限额',
              usedPercent: 27,
              percentKind: 'used',
              poolId: 'codex-main',
            },
          ],
        },
      });
      assert.equal(seed.statusCode, 200);
      const before = (await app.inject({ method: 'GET', url: '/api/quota' })).json().codex;

      const failed = await app.inject({
        method: 'POST',
        url: '/api/quota/refresh/official',
        payload: { providers: ['claude'] },
      });
      assert.equal(failed.statusCode, 400);
      assert.doesNotMatch(failed.json().error, /Codex/);
      const after = (await app.inject({ method: 'GET', url: '/api/quota' })).json().codex;
      assert.deepEqual(after, before);
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      if (oldClaudeCredentialsPath != null) process.env.CLAUDE_CREDENTIALS_PATH = oldClaudeCredentialsPath;
      else delete process.env.CLAUDE_CREDENTIALS_PATH;
      if (oldCodexCredentialsPath != null) process.env.CODEX_CREDENTIALS_PATH = oldCodexCredentialsPath;
      else delete process.env.CODEX_CREDENTIALS_PATH;
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps omitted provider caches unchanged when official refresh is disabled', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '0';
    const app = await buildApp();
    try {
      const seed = await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: { usageItems: [{ label: '每周使用限额', usedPercent: 27 }] },
      });
      assert.equal(seed.statusCode, 200);
      const before = (await app.inject({ method: 'GET', url: '/api/quota' })).json().codex;

      const failed = await app.inject({
        method: 'POST',
        url: '/api/quota/refresh/official',
        payload: { providers: ['claude'] },
      });
      assert.equal(failed.statusCode, 503);
      const after = (await app.inject({ method: 'GET', url: '/api/quota' })).json().codex;
      assert.deepEqual(after, before);
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      await app.close();
    }
  });
});

describe('PATCH /api/quota/codex — validation', () => {
  it('rejects payload without usageItems array', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: { garbage: true },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('rejects usageItems with out-of-range percent', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: {
          usageItems: [{ label: 'Week', usedPercent: 200 }],
        },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  it('rejects usageItems with empty label', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: {
          usageItems: [{ label: '', usedPercent: 50 }],
        },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

describe('PATCH /api/quota/codex — scrape failure reporting', () => {
  it('accepts error-only payload (no usageItems) and stores error', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: {
          error: 'Browser scrape failed: page not loaded',
        },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.codex.error, 'Browser scrape failed: page not loaded');
      assert.deepEqual(body.codex.usageItems, []);
    } finally {
      await app.close();
    }
  });

  it('codex error is visible on subsequent GET', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: {
          error: 'Timeout waiting for usage table',
        },
      });
      const getRes = await app.inject({ method: 'GET', url: '/api/quota' });
      const body = getRes.json();
      assert.equal(body.codex.error, 'Timeout waiting for usage table');
    } finally {
      await app.close();
    }
  });
});

describe('PATCH /api/quota/codex — happy path', () => {
  it('stores pushed codex usage data and returns it on GET', async () => {
    const app = await buildApp();
    try {
      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: {
          usageItems: [{ label: 'Current week', usedPercent: 100, resetsAt: '2026-03-05T19:00:00Z' }],
        },
      });
      assert.equal(patchRes.statusCode, 200);

      const getRes = await app.inject({ method: 'GET', url: '/api/quota' });
      const body = getRes.json();
      assert.equal(body.codex.usageItems.length, 1);
      assert.equal(body.codex.usageItems[0].usedPercent, 100);
      assert.equal(body.codex.usageItems[0].label, 'Current week');
      assert.ok(body.codex.lastChecked);
    } finally {
      await app.close();
    }
  });

  it('preserves poolId when pushed via PATCH', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: {
          usageItems: [
            { label: '5小时使用限额', usedPercent: 97, percentKind: 'remaining', poolId: 'codex-main' },
            { label: '代码审查', usedPercent: 56, percentKind: 'remaining', poolId: 'codex-review' },
          ],
        },
      });
      const getRes = await app.inject({ method: 'GET', url: '/api/quota' });
      const body = getRes.json();
      assert.equal(body.codex.usageItems[0].poolId, 'codex-main');
      assert.equal(body.codex.usageItems[1].poolId, 'codex-review');
    } finally {
      await app.close();
    }
  });
});

describe('PATCH /api/quota/gemini', () => {
  it('stores pushed Gemini quota data', async () => {
    const app = await buildApp();
    try {
      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/api/quota/gemini',
        payload: {
          usageItems: [
            { label: 'Gemini 2.5 Pro', usedPercent: 10, percentKind: 'used', poolId: 'gemini-pro' },
            { label: 'Gemini 2.5 Flash', usedPercent: 40, percentKind: 'used', poolId: 'gemini-flash' },
          ],
        },
      });
      assert.equal(patchRes.statusCode, 200);
      const body = patchRes.json();
      assert.equal(body.gemini.usageItems.length, 2);
      assert.equal(body.gemini.usageItems[0].poolId, 'gemini-pro');
    } finally {
      await app.close();
    }
  });

  it('Gemini data appears in GET /api/quota', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'PATCH',
        url: '/api/quota/gemini',
        payload: {
          usageItems: [{ label: 'Gemini 2.5 Pro', usedPercent: 90, percentKind: 'remaining', poolId: 'gemini-pro' }],
        },
      });
      const getRes = await app.inject({ method: 'GET', url: '/api/quota' });
      const body = getRes.json();
      assert.ok(body.gemini);
      assert.equal(body.gemini.platform, 'gemini');
      assert.equal(body.gemini.usageItems.length, 1);
    } finally {
      await app.close();
    }
  });

  it('accepts error-only payload for Gemini', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/quota/gemini',
        payload: { error: 'OAuth token expired' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.gemini.error, 'OAuth token expired');
    } finally {
      await app.close();
    }
  });
});

describe('PATCH /api/quota/antigravity', () => {
  it('stores pushed Antigravity quota data', async () => {
    const app = await buildApp();
    try {
      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/api/quota/antigravity',
        payload: {
          usageItems: [{ label: 'Codeium', usedPercent: 98, percentKind: 'remaining', poolId: 'codeium-main' }],
        },
      });
      assert.equal(patchRes.statusCode, 200);
      const body = patchRes.json();
      assert.equal(body.antigravity.platform, 'antigravity');
      assert.equal(body.antigravity.usageItems.length, 1);
      assert.equal(body.antigravity.usageItems[0].poolId, 'codeium-main');
    } finally {
      await app.close();
    }
  });

  it('Antigravity data replaces placeholder in GET /api/quota', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'PATCH',
        url: '/api/quota/antigravity',
        payload: {
          usageItems: [{ label: 'Codeium', usedPercent: 98, percentKind: 'remaining', poolId: 'codeium-main' }],
        },
      });
      const getRes = await app.inject({ method: 'GET', url: '/api/quota' });
      const body = getRes.json();
      assert.equal(body.antigravity.platform, 'antigravity');
      assert.ok(Array.isArray(body.antigravity.usageItems));
      assert.equal(body.antigravity.usageItems.length, 1);
      assert.ok(body.antigravity.lastChecked);
      // Should NOT have the old placeholder status
      assert.equal(body.antigravity.status, undefined);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/quota/refresh/kimi', () => {
  it('refreshes Kimi quota through the CLI by default', async () => {
    const app = await buildApp();
    try {
      const quotaModule = await import('../dist/routes/quota.js');
      quotaModule.setKimiCliProbeOverrideForTests?.(async () => [
        { label: '每周使用限额', usedPercent: 97, percentKind: 'remaining', poolId: 'kimi-weekly' },
        { label: '5小时使用限额', usedPercent: 76, percentKind: 'remaining', poolId: 'kimi-rate-limit' },
      ]);
      const res = await app.inject({ method: 'POST', url: '/api/quota/refresh/kimi' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.kimi.status, 'ok');
      assert.equal(body.source, 'cli');
      assert.equal(body.fallbackUsed, false);
      assert.equal(body.kimi.usageItems[0].label, '每周使用限额');
      assert.equal(body.kimi.usageItems[0].usedPercent, 97);
    } finally {
      await app.close();
    }
  });

  it('falls back to the Kimi API only when env-gated fallback is enabled', async () => {
    const oldToken = process.env.KIMI_AUTH_TOKEN;
    const oldFallback = process.env.KIMI_QUOTA_API_FALLBACK_ENABLED;
    const previousFetch = globalThis.fetch;
    process.env.KIMI_AUTH_TOKEN = 'header.payload.signature';
    process.env.KIMI_QUOTA_API_FALLBACK_ENABLED = '1';
    globalThis.fetch = async (url) => {
      if (String(url).includes('kimi.gateway.billing')) {
        return new Response(JSON.stringify(MOCK_KIMI_USAGE_RESPONSE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    };
    const app = await buildApp();
    try {
      const quotaModule = await import('../dist/routes/quota.js');
      quotaModule.setKimiCliProbeOverrideForTests?.(async () => {
        throw new Error('mock kimi cli failure');
      });
      const res = await app.inject({ method: 'POST', url: '/api/quota/refresh/kimi' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.source, 'api');
      assert.equal(body.fallbackUsed, true);
      assert.equal(body.kimi.status, 'ok');
      assert.match(body.kimi.note ?? '', /降级到 Kimi API/);
    } finally {
      if (oldToken != null) process.env.KIMI_AUTH_TOKEN = oldToken;
      else delete process.env.KIMI_AUTH_TOKEN;
      if (oldFallback != null) process.env.KIMI_QUOTA_API_FALLBACK_ENABLED = oldFallback;
      else delete process.env.KIMI_QUOTA_API_FALLBACK_ENABLED;
      globalThis.fetch = previousFetch;
      await app.close();
    }
  });
});

describe('POST /api/quota/refresh/official', () => {
  it('returns 503 when official refresh is disabled by default', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/quota/refresh/official' });
      assert.equal(res.statusCode, 503);
      const body = res.json();
      assert.match(body.error, /QUOTA_OFFICIAL_REFRESH_ENABLED/);
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      await app.close();
    }
  });
});

describe('Claude local usage merge', () => {
  it('preserves official OAuth quota pools when ccusage refreshes local billing blocks', async () => {
    const { mergeClaudeCliUsage } = await import('../dist/routes/quota.js');
    const usageItems = [{ label: 'Session 5h', usedPercent: 12, poolId: 'claude-session' }];
    const activeBlock = {
      id: 'block-1',
      startTime: '2026-07-18T00:00:00.000Z',
      endTime: '2026-07-18T05:00:00.000Z',
      isActive: true,
      isGap: false,
      entries: 1,
      totalTokens: 100,
      costUSD: 0,
      models: ['claude'],
      burnRate: null,
      projection: null,
    };
    const merged = mergeClaudeCliUsage(
      {
        platform: 'claude',
        activeBlock: null,
        recentBlocks: [],
        usageItems,
        error: 'stale error',
        lastChecked: null,
      },
      [activeBlock],
      '2026-07-18T01:00:00.000Z',
    );
    assert.deepEqual(merged.usageItems, usageItems);
    assert.equal(merged.activeBlock?.id, 'block-1');
    assert.equal(merged.error, undefined);
    assert.equal(merged.lastChecked, '2026-07-18T01:00:00.000Z');
  });

  it('preserves an official failure when ccusage success completes later', async () => {
    const { mergeClaudeCliUsage, mergeClaudeOfficialFailure } = await import('../dist/routes/quota.js');
    const officialError = 'Claude OAuth failed: upstream unavailable';
    const initial = {
      platform: 'claude',
      activeBlock: null,
      recentBlocks: [],
      lastChecked: null,
    };

    const afterOfficialFailure = mergeClaudeOfficialFailure(initial, officialError, '2026-07-18T01:00:00.000Z');
    const afterCliSuccess = mergeClaudeCliUsage(afterOfficialFailure, [], '2026-07-18T01:00:01.000Z');

    assert.equal(afterCliSuccess.officialError, officialError);
    assert.equal(afterCliSuccess.cliError, undefined);
    assert.equal(afterCliSuccess.error, officialError);
  });

  it('records the same official failure when it completes after ccusage success', async () => {
    const { mergeClaudeCliUsage, mergeClaudeOfficialFailure } = await import('../dist/routes/quota.js');
    const officialError = 'Claude OAuth failed: upstream unavailable';
    const initial = {
      platform: 'claude',
      activeBlock: null,
      recentBlocks: [],
      lastChecked: null,
    };

    const afterCliSuccess = mergeClaudeCliUsage(initial, [], '2026-07-18T01:00:00.000Z');
    const afterOfficialFailure = mergeClaudeOfficialFailure(afterCliSuccess, officialError, '2026-07-18T01:00:01.000Z');

    assert.equal(afterOfficialFailure.officialError, officialError);
    assert.equal(afterOfficialFailure.cliError, undefined);
    assert.equal(afterOfficialFailure.error, officialError);
  });

  it('preserves a ccusage failure when official success completes later', async () => {
    const { mergeClaudeCliFailure, mergeClaudeOfficialUsage } = await import('../dist/routes/quota.js');
    const cliError = 'ccusage failed: command unavailable';
    const initial = {
      platform: 'claude',
      activeBlock: null,
      recentBlocks: [],
      lastChecked: null,
    };

    const afterCliFailure = mergeClaudeCliFailure(initial, cliError, '2026-07-18T01:00:00.000Z');
    const afterOfficialSuccess = mergeClaudeOfficialUsage(
      afterCliFailure,
      [{ label: 'Weekly all models', usedPercent: 21, poolId: 'claude-weekly-all' }],
      '2026-07-18T01:00:01.000Z',
    );

    assert.equal(afterOfficialSuccess.officialError, undefined);
    assert.equal(afterOfficialSuccess.cliError, cliError);
    assert.equal(afterOfficialSuccess.error, cliError);
  });

  it('records the same ccusage failure when it completes after official success', async () => {
    const { mergeClaudeCliFailure, mergeClaudeOfficialUsage } = await import('../dist/routes/quota.js');
    const cliError = 'ccusage failed: command unavailable';
    const initial = {
      platform: 'claude',
      activeBlock: null,
      recentBlocks: [],
      lastChecked: null,
    };

    const afterOfficialSuccess = mergeClaudeOfficialUsage(
      initial,
      [{ label: 'Weekly all models', usedPercent: 21, poolId: 'claude-weekly-all' }],
      '2026-07-18T01:00:00.000Z',
    );
    const afterCliFailure = mergeClaudeCliFailure(afterOfficialSuccess, cliError, '2026-07-18T01:00:01.000Z');

    assert.equal(afterCliFailure.officialError, undefined);
    assert.equal(afterCliFailure.cliError, cliError);
    assert.equal(afterCliFailure.error, cliError);
  });
});

describe('Codex OAuth credentials loader', () => {
  const nativeCodexAuth = {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'native-access-token',
      refresh_token: 'native-refresh-token',
      account_id: 'native-account-id',
    },
  };

  async function withTempDir(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'quota-codex-auth-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('reads native Codex CLI auth.json from CODEX_HOME when CODEX_CREDENTIALS_PATH is unset', async () => {
    const { loadCodexCredentialsForTests } = await import('../dist/routes/quota.js');
    await withTempDir(async (dir) => {
      const oldCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = dir;
      await writeFile(join(dir, 'auth.json'), JSON.stringify(nativeCodexAuth), 'utf-8');
      try {
        assert.deepEqual(loadCodexCredentialsForTests(), {
          accessToken: 'native-access-token',
          refreshToken: 'native-refresh-token',
          accountId: 'native-account-id',
        });
      } finally {
        if (oldCodexHome != null) process.env.CODEX_HOME = oldCodexHome;
        else delete process.env.CODEX_HOME;
      }
    });
  });

  it('reads native Codex CLI auth.json from explicit CODEX_CREDENTIALS_PATH', async () => {
    const { loadCodexCredentialsForTests } = await import('../dist/routes/quota.js');
    await withTempDir(async (dir) => {
      const authPath = join(dir, 'codex-auth.json');
      await writeFile(authPath, JSON.stringify(nativeCodexAuth), 'utf-8');
      assert.deepEqual(loadCodexCredentialsForTests(authPath), {
        accessToken: 'native-access-token',
        refreshToken: 'native-refresh-token',
        accountId: 'native-account-id',
      });
    });
  });

  it('keeps supporting the legacy flat Codex credential format', async () => {
    const { loadCodexCredentialsForTests } = await import('../dist/routes/quota.js');
    await withTempDir(async (dir) => {
      const oldCodexHome = process.env.CODEX_HOME;
      const isolatedCodexHome = join(dir, 'codex-home');
      const authPath = join(dir, 'flat-auth.json');
      await mkdir(isolatedCodexHome);
      await writeFile(
        authPath,
        JSON.stringify({
          accessToken: 'flat-access-token',
          refreshToken: 'flat-refresh-token',
          accountId: 'flat-account-id',
        }),
        'utf-8',
      );
      process.env.CODEX_HOME = isolatedCodexHome;
      try {
        assert.deepEqual(loadCodexCredentialsForTests(authPath), {
          accessToken: 'flat-access-token',
          refreshToken: 'flat-refresh-token',
          accountId: 'flat-account-id',
        });
      } finally {
        if (oldCodexHome != null) process.env.CODEX_HOME = oldCodexHome;
        else delete process.env.CODEX_HOME;
      }
    });
  });

  it('keeps an explicit legacy credential path authoritative over CODEX_HOME auth.json', async () => {
    const { loadCodexCredentialsForTests } = await import('../dist/routes/quota.js');
    await withTempDir(async (dir) => {
      const oldCodexHome = process.env.CODEX_HOME;
      const legacyPath = join(dir, 'stale-flat-auth.json');
      const codexHome = join(dir, 'codex-home');
      await mkdir(codexHome);
      await writeFile(
        legacyPath,
        JSON.stringify({
          accessToken: 'stale-flat-access-token',
          refreshToken: 'stale-flat-refresh-token',
          accountId: 'stale-flat-account-id',
        }),
        'utf-8',
      );
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify(nativeCodexAuth), 'utf-8');
      process.env.CODEX_HOME = codexHome;
      try {
        assert.deepEqual(loadCodexCredentialsForTests(legacyPath), {
          accessToken: 'stale-flat-access-token',
          refreshToken: 'stale-flat-refresh-token',
          accountId: 'stale-flat-account-id',
        });
      } finally {
        if (oldCodexHome != null) process.env.CODEX_HOME = oldCodexHome;
        else delete process.env.CODEX_HOME;
      }
    });
  });

  it('fails closed when an explicit credential path is malformed even if CODEX_HOME is valid', async () => {
    const { loadCodexCredentialsForTests } = await import('../dist/routes/quota.js');
    await withTempDir(async (dir) => {
      const oldCodexHome = process.env.CODEX_HOME;
      const malformedPath = join(dir, 'malformed-auth.json');
      const codexHome = join(dir, 'codex-home');
      await mkdir(codexHome);
      await writeFile(malformedPath, '{not-json', 'utf-8');
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify(nativeCodexAuth), 'utf-8');
      process.env.CODEX_HOME = codexHome;
      try {
        assert.equal(loadCodexCredentialsForTests(malformedPath), null);
      } finally {
        if (oldCodexHome != null) process.env.CODEX_HOME = oldCodexHome;
        else delete process.env.CODEX_HOME;
      }
    });
  });

  it('returns null for incomplete native Codex auth without throwing', async () => {
    const { loadCodexCredentialsForTests } = await import('../dist/routes/quota.js');
    await withTempDir(async (dir) => {
      const authPath = join(dir, 'incomplete-auth.json');
      await writeFile(authPath, JSON.stringify({ tokens: { access_token: 'missing-refresh' } }), 'utf-8');
      assert.equal(loadCodexCredentialsForTests(authPath), null);
    });
  });
});

// ============================================================
// v3 OAuth API parsers (replaces browser scraping)
// ============================================================

/** Mock Anthropic OAuth API response (GET /api/oauth/usage) */
const MOCK_CLAUDE_OAUTH_RESPONSE = {
  five_hour: { used_percent: 7, reset_at: '2026-03-05T18:00:00Z' },
  seven_day: { used_percent: 54, reset_at: '2026-03-06T03:00:00Z' },
  seven_day_sonnet: { used_percent: 3, reset_at: '2026-03-06T03:00:00Z' },
  seven_day_opus: { used_percent: 12, reset_at: '2026-03-06T03:00:00Z' },
  extra_usage: { used_cents: 0, limit_cents: 0 },
};

/** Mock OpenAI Wham API response (GET /backend-api/wham/usage) */
const MOCK_CODEX_WHAM_RESPONSE = {
  rate_limit: {
    primary_window: {
      used_percent: 3,
      reset_at: '2026-03-05T07:10:00Z',
      label: '5小时使用限额',
    },
    secondary_window: {
      used_percent: 1,
      reset_at: '2026-03-09T19:10:00Z',
      label: '每周使用限额',
    },
    spark_primary: {
      used_percent: 0,
      reset_at: '2026-03-05T08:00:00Z',
      label: 'GPT-5.3-Codex-Spark 5小时使用限额',
    },
    spark_secondary: {
      used_percent: 7,
      reset_at: '2026-03-12T17:03:00Z',
      label: 'GPT-5.3-Codex-Spark 每周使用限额',
    },
    code_review: {
      used_percent: 44,
      reset_at: '2026-03-08T00:26:00Z',
      label: '代码审查',
    },
  },
  credits_balance: 0,
};

const MOCK_KIMI_USAGE_RESPONSE = {
  usages: [
    {
      scope: 'FEATURE_CODING',
      detail: {
        limit: '1000',
        used: '970',
        remaining: '30',
        resetTime: '2026-03-09T19:10:00Z',
      },
      limits: [
        {
          window: { duration: 5, timeUnit: 'hour' },
          detail: {
            limit: '50',
            used: '12',
            remaining: '38',
            resetTime: '2026-03-05T07:10:00Z',
          },
        },
      ],
    },
  ],
};

describe('Claude OAuth API parser (v3)', () => {
  it('parses Anthropic OAuth usage response into usageItems with poolId', async () => {
    const { parseClaudeOAuthUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseClaudeOAuthUsageResponse(MOCK_CLAUDE_OAUTH_RESPONSE);
    assert.equal(items.length, 4);
    assert.deepEqual(
      items.map((x) => [x.label, x.usedPercent, x.poolId]),
      [
        ['Session 5h', 7, 'claude-session'],
        ['Weekly all models', 54, 'claude-weekly-all'],
        ['Weekly Sonnet', 3, 'claude-weekly-sonnet'],
        ['Weekly Opus', 12, 'claude-weekly-opus'],
      ],
    );
  });

  it('includes reset times from API response', async () => {
    const { parseClaudeOAuthUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseClaudeOAuthUsageResponse(MOCK_CLAUDE_OAUTH_RESPONSE);
    assert.equal(items[0].resetsAt, '2026-03-05T18:00:00Z');
    assert.equal(items[1].resetsAt, '2026-03-06T03:00:00Z');
  });

  it('treats used_percent as utilization (not remaining)', async () => {
    const { parseClaudeOAuthUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseClaudeOAuthUsageResponse(MOCK_CLAUDE_OAUTH_RESPONSE);
    // API gives used_percent — percentKind should be 'used'
    for (const item of items) {
      assert.equal(item.percentKind, 'used');
    }
  });

  it('handles missing optional fields gracefully', async () => {
    const { parseClaudeOAuthUsageResponse } = await import('../dist/routes/quota.js');
    // Minimal response with only five_hour
    const items = parseClaudeOAuthUsageResponse({ five_hour: { used_percent: 10 } });
    assert.ok(items.length >= 1);
    assert.equal(items[0].usedPercent, 10);
    assert.equal(items[0].poolId, 'claude-session');
  });

  it('returns empty array for completely empty response', async () => {
    const { parseClaudeOAuthUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseClaudeOAuthUsageResponse({});
    assert.equal(items.length, 0);
  });
});

describe('Codex Wham API parser (v3)', () => {
  it('parses Wham usage response into usageItems with poolId', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse(MOCK_CODEX_WHAM_RESPONSE);
    assert.ok(items.length >= 5);
    const labels = items.map((x) => x.poolId);
    assert.ok(labels.includes('codex-main'));
    assert.ok(labels.includes('codex-spark'));
    assert.ok(labels.includes('codex-review'));
  });

  it('maps primary/secondary windows to 5h and weekly pools', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse(MOCK_CODEX_WHAM_RESPONSE);
    const main5h = items.find((x) => x.poolId === 'codex-main' && x.label.includes('5'));
    assert.ok(main5h);
    assert.equal(main5h.usedPercent, 3);
    const mainWeekly = items.find((x) => x.poolId === 'codex-main' && x.label.includes('周'));
    assert.ok(mainWeekly);
    assert.equal(mainWeekly.usedPercent, 1);
  });

  it('includes reset times from API response', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse(MOCK_CODEX_WHAM_RESPONSE);
    const main5h = items.find((x) => x.poolId === 'codex-main' && x.label.includes('5'));
    assert.ok(main5h);
    assert.equal(main5h.resetsAt, '2026-03-05T07:10:00Z');
  });

  it('normalizes current Wham epoch-second reset_at values to ISO timestamps', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse({
      rate_limit: { primary_window: { used_percent: 8, reset_at: 1_784_400_000 } },
    });
    assert.equal(items[0]?.resetsAt, new Date(1_784_400_000 * 1000).toISOString());
  });

  it('labels the current seven-day primary window from its reported duration', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse({
      rate_limit: {
        primary_window: {
          used_percent: 28,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_at: 1_784_954_678,
        },
        secondary_window: null,
      },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.label, '每周使用限额');
    assert.equal(items[0]?.usedPercent, 28);
  });

  it('uses the body primary window once when matching fallback headers are also present', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse(
      {
        rate_limit: {
          primary_window: {
            used_percent: 28,
            limit_window_seconds: 7 * 24 * 60 * 60,
          },
        },
      },
      new Headers({ 'x-codex-primary-used-percent': '28' }),
    );

    assert.deepEqual(
      items.map((item) => [item.label, item.usedPercent, item.poolId]),
      [['每周使用限额', 28, 'codex-main']],
    );
  });

  it('extracts credits_balance as overflow pool', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse(MOCK_CODEX_WHAM_RESPONSE);
    const overflow = items.find((x) => x.poolId === 'codex-overflow');
    assert.ok(overflow);
    assert.equal(overflow.usedPercent, 0);
    assert.equal(overflow.percentKind, 'remaining');
  });

  it('uses Wham response headers when the body lacks rate_limit usage windows', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse(
      {},
      new Headers({
        'x-codex-primary-used-percent': '13',
        'x-codex-secondary-used-percent': '21',
        'x-codex-credits-balance': '0',
      }),
    );
    assert.deepEqual(
      items.map((x) => [x.label, x.usedPercent, x.poolId, x.percentKind]),
      [
        ['5小时使用限额', 13, 'codex-main', 'used'],
        ['每周使用限额', 21, 'codex-main', 'used'],
        ['溢出额度', 0, 'codex-overflow', 'remaining'],
      ],
    );
  });

  it('treats used_percent as utilization (not remaining)', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse(MOCK_CODEX_WHAM_RESPONSE);
    const nonOverflow = items.filter((x) => x.poolId !== 'codex-overflow');
    for (const item of nonOverflow) {
      assert.equal(item.percentKind, 'used');
    }
  });

  it('returns empty array for empty response', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse({});
    assert.equal(items.length, 0);
  });
});

describe('Kimi usage parsers', () => {
  it('parses weekly and 5-hour quotas from Kimi CLI /usage output', async () => {
    const { parseKimiCliUsageOutput } = await import('../dist/routes/quota.js');
    const items = parseKimiCliUsageOutput(`
╭─────────────────────────────── API Usage ───────────────────────────────╮
│  Weekly limit  ━━━━━━━━━━━━━━━━━━━━  100% left  (resets in 6d 23h 22m)  │
│  5h limit      ━━━━━━━━━━━━━━━━━━━━  75% left   (resets in 4h 22m)      │
╰─────────────────────────────────────────────────────────────────────────╯
`);
    assert.deepEqual(
      items.map((item) => [item.label, item.usedPercent, item.percentKind, item.poolId]),
      [
        ['每周使用限额', 100, 'remaining', 'kimi-weekly'],
        ['5小时使用限额', 75, 'remaining', 'kimi-rate-limit'],
      ],
    );
  });

  it('parses weekly and 5-hour windows from Kimi billing response', async () => {
    const { parseKimiOfficialUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseKimiOfficialUsageResponse(MOCK_KIMI_USAGE_RESPONSE);
    assert.deepEqual(
      items.map((item) => [item.label, item.usedPercent, item.poolId]),
      [
        ['每周使用限额', 97, 'kimi-weekly'],
        ['5小时使用限额', 24, 'kimi-rate-limit'],
      ],
    );
  });
});

describe('POST /api/quota/refresh/official — v3 OAuth flow', () => {
  it('fetches Claude usage via Anthropic OAuth API and updates cache', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: { accessToken: 'test-token', refreshToken: 'test-refresh' },
      codexCredentials: null,
      fetchLike: async (url) => {
        if (String(url).includes('anthropic.com')) {
          return new Response(JSON.stringify(MOCK_CLAUDE_OAUTH_RESPONSE), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('', { status: 404 });
      },
    });
    assert.ok(result.claude);
    assert.ok(result.claude.items > 0);
    assert.ok(!result.claude.error);
  });

  it('fetches Codex usage via Wham API and updates cache', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: null,
      codexCredentials: { accessToken: 'test-token', refreshToken: 'test-refresh', accountId: 'test-account' },
      fetchLike: async (url) => {
        if (String(url).includes('chatgpt.com')) {
          return new Response(JSON.stringify(MOCK_CODEX_WHAM_RESPONSE), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-codex-primary-used-percent': '3',
              'x-codex-secondary-used-percent': '1',
              'x-codex-credits-balance': '0',
            },
          });
        }
        return new Response('', { status: 404 });
      },
    });
    assert.ok(result.codex);
    assert.ok(result.codex.items > 0);
    assert.ok(!result.codex.error);
  });

  it('reports Codex Wham success responses that contain no usage items', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: null,
      codexCredentials: { accessToken: 'test-token', refreshToken: 'test-refresh', accountId: 'test-account' },
      fetchLike: async (url) => {
        if (String(url).includes('chatgpt.com')) {
          return new Response(JSON.stringify({ rate_limit: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('', { status: 404 });
      },
    });
    assert.equal(result.codex?.items, 0);
    assert.match(result.codex?.error ?? '', /no usage items/i);
  });

  it('reports error when API returns 401 and refresh also fails', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: { accessToken: 'expired', refreshToken: 'bad' },
      codexCredentials: null,
      fetchLike: async () => new Response('{"error":"invalid_token"}', { status: 401 }),
    });
    assert.ok(result.claude?.error);
    assert.match(result.claude.error, /401|auth|token/i);
  });

  it('retries with refreshed token on 401 (Claude)', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    let callCount = 0;
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: { accessToken: 'expired-token', refreshToken: 'valid-refresh' },
      codexCredentials: null,
      fetchLike: async (url) => {
        const urlStr = String(url);
        // Token refresh endpoint — return new token
        if (urlStr.includes('platform.claude.com') || urlStr.includes('auth.openai.com')) {
          return new Response(JSON.stringify({ access_token: 'fresh-token' }), { status: 200 });
        }
        // Usage API
        if (urlStr.includes('anthropic.com')) {
          callCount++;
          if (callCount === 1) {
            return new Response('{"error":"invalid_token"}', { status: 401 });
          }
          return new Response(JSON.stringify(MOCK_CLAUDE_OAUTH_RESPONSE), { status: 200 });
        }
        return new Response('', { status: 404 });
      },
    });
    // Should have retried and succeeded
    assert.equal(callCount, 2, 'should call usage API twice (initial 401 + retry)');
    assert.ok(result.claude);
    assert.ok(result.claude.items > 0, 'should have items after refresh retry');
    assert.ok(!result.claude.error, 'should not have error after successful retry');
  });

  it('does not consume Codex refresh-token rotation on 401', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    let refreshCallCount = 0;
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: null,
      codexCredentials: { accessToken: 'expired-token', refreshToken: 'valid-refresh', accountId: 'acct' },
      fetchLike: async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('auth.openai.com')) {
          refreshCallCount++;
          return new Response(
            JSON.stringify({ access_token: 'fresh-codex-token', refresh_token: 'rotated-refresh-token' }),
            { status: 200 },
          );
        }
        if (urlStr.includes('chatgpt.com')) {
          return new Response('{"error":"invalid_token"}', { status: 401 });
        }
        return new Response('', { status: 404 });
      },
    });
    assert.equal(refreshCallCount, 0, 'quota refresh must not consume and discard Codex refresh-token rotation');
    assert.equal(result.codex?.items, 0);
    assert.match(result.codex?.error ?? '', /Codex CLI.*refresh|refresh.*Codex CLI/i);
  });

  it('handles both providers in parallel', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: { accessToken: 'ok', refreshToken: 'ok' },
      codexCredentials: { accessToken: 'ok', refreshToken: 'ok', accountId: 'acct' },
      fetchLike: async (url) => {
        if (String(url).includes('anthropic.com')) {
          return new Response(JSON.stringify(MOCK_CLAUDE_OAUTH_RESPONSE), { status: 200 });
        }
        if (String(url).includes('chatgpt.com')) {
          return new Response(JSON.stringify(MOCK_CODEX_WHAM_RESPONSE), { status: 200 });
        }
        return new Response('', { status: 404 });
      },
    });
    assert.ok(result.claude?.items > 0);
    assert.ok(result.codex?.items > 0);
  });

  it('fetches Kimi official usage via billing API and updates cache', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: null,
      codexCredentials: null,
      kimiAuthToken: 'header.payload.signature',
      fetchLike: async (url) => {
        if (String(url).includes('kimi.gateway.billing')) {
          return new Response(JSON.stringify(MOCK_KIMI_USAGE_RESPONSE), { status: 200 });
        }
        return new Response('', { status: 404 });
      },
    });
    assert.ok(result.kimi);
    assert.ok(result.kimi.items > 0);
    assert.ok(!result.kimi.error);
  });

  it('skips provider when credentials are null', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: null,
      codexCredentials: null,
      fetchLike: async () => new Response('', { status: 404 }),
    });
    assert.equal(result.claude, undefined);
    assert.equal(result.codex, undefined);
    assert.equal(result.kimi, undefined);
  });

  it('reports skipped providers in result', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    // Only Claude has credentials; Codex and Kimi should be reported as skipped
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: { accessToken: 'ok', refreshToken: 'ok' },
      codexCredentials: null,
      kimiAuthToken: null,
      fetchLike: async (url) => {
        if (String(url).includes('anthropic.com')) {
          return new Response(JSON.stringify(MOCK_CLAUDE_OAUTH_RESPONSE), { status: 200 });
        }
        return new Response('', { status: 404 });
      },
    });
    assert.ok(result.claude?.items > 0);
    assert.equal(result.codex, undefined);
    // Result should have a skipped array indicating which providers were skipped
    assert.ok(Array.isArray(result.skipped), 'result should have skipped array');
    assert.ok(result.skipped.includes('codex'), 'codex should be in skipped list');
    assert.ok(result.skipped.includes('kimi'), 'kimi should be in skipped list');
  });

  it('sends Claude token refresh as form-encoded OAuth (not JSON)', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    let refreshContentType = '';
    let refreshBody = '';
    await refreshOfficialQuotaViaOAuth({
      claudeCredentials: { accessToken: 'expired', refreshToken: 'valid-refresh' },
      codexCredentials: null,
      fetchLike: async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('platform.claude.com')) {
          refreshContentType = init?.headers?.['Content-Type'] ?? '';
          refreshBody = typeof init?.body === 'string' ? init.body : '';
          return new Response(JSON.stringify({ access_token: 'fresh' }), { status: 200 });
        }
        if (urlStr.includes('anthropic.com')) {
          return new Response('{"error":"expired"}', { status: 401 });
        }
        return new Response('', { status: 404 });
      },
    });
    // Token refresh endpoint must receive form-encoded, not JSON
    assert.match(refreshContentType, /x-www-form-urlencoded/, 'refresh must use form-encoded content type');
    assert.ok(!refreshBody.startsWith('{'), 'refresh body must not be JSON');
    assert.ok(refreshBody.includes('grant_type=refresh_token'), 'body must contain grant_type param');
    assert.ok(refreshBody.includes('refresh_token=valid-refresh'), 'body must contain refresh_token param');
  });
});
