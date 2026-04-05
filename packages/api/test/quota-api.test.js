/**
 * F051 — Real Quota Dashboard API tests
 *
 * Tests the /api/quota endpoint that returns cached quota data
 * from official sources (ccusage for Claude, browser for Codex).
 */

import assert from 'node:assert/strict';
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
      const res = await app.inject({ method: 'GET', url: '/api/quota/probes' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(Array.isArray(body.probes), true);
      const official = body.probes.find((probe) => probe.id === 'official-browser');
      const kimi = body.probes.find((probe) => probe.id === 'kimi-official-web');
      assert.equal(official?.enabled, false);
      assert.equal(official?.status, 'disabled');
      assert.ok(kimi, 'should expose kimi probe');
      assert.deepEqual(kimi?.targets, ['kimi']);
      assert.deepEqual(official?.targets, ['codex', 'claude', 'kimi']);
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
      const res = await app.inject({ method: 'GET', url: '/api/quota/probes' });
      const body = res.json();
      const kimi = body.probes.find((probe) => probe.id === 'kimi-official-web');
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

  it('marks official-browser probe status=error after official refresh failure', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    const app = await buildApp();
    try {
      // No credentials files → 400 with "No OAuth credentials" error
      const refreshRes = await app.inject({ method: 'POST', url: '/api/quota/refresh/official' });
      assert.equal(refreshRes.statusCode, 400);

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
      assert.equal(typeof body.probes.kimiOfficial.status, 'string');
      assert.equal(typeof body.actions.refreshOfficialPath, 'string');
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      await app.close();
    }
  });


  it('includes Kimi utilization in summary risk calculations', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const oldToken = process.env.KIMI_AUTH_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    process.env.KIMI_AUTH_TOKEN = 'header.payload.signature';
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
      await app.inject({ method: 'POST', url: '/api/quota/refresh/kimi' });
      const res = await app.inject({ method: 'GET', url: '/api/quota/summary' });
      const body = res.json();
      assert.equal(body.platforms.kimi.status, 'error');
      assert.equal(body.risk.level, 'high');
      assert.equal(body.risk.reasons.some((reason) => /97%/.test(String(reason))), true);
      assert.equal(body.actions.refreshKimiPath, '/api/quota/refresh/kimi');
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      if (oldToken != null) process.env.KIMI_AUTH_TOKEN = oldToken;
      else delete process.env.KIMI_AUTH_TOKEN;
      globalThis.fetch = previousFetch;
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
  it('refreshes Kimi official usage on demand', async () => {
    const oldEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const oldToken = process.env.KIMI_AUTH_TOKEN;
    const previousFetch = globalThis.fetch;
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    process.env.KIMI_AUTH_TOKEN = 'header.payload.signature';
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
      const res = await app.inject({ method: 'POST', url: '/api/quota/refresh/kimi' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.kimi.status, 'ok');
      assert.equal(body.kimi.usageItems[0].label, '每周使用限额');
      assert.equal(body.kimi.usageItems[0].usedPercent, 97);
    } finally {
      if (oldEnabled != null) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = oldEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      if (oldToken != null) process.env.KIMI_AUTH_TOKEN = oldToken;
      else delete process.env.KIMI_AUTH_TOKEN;
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

  it('extracts credits_balance as overflow pool', async () => {
    const { parseCodexWhamUsageResponse } = await import('../dist/routes/quota.js');
    const items = parseCodexWhamUsageResponse(MOCK_CODEX_WHAM_RESPONSE);
    const overflow = items.find((x) => x.poolId === 'codex-overflow');
    assert.ok(overflow);
    assert.equal(overflow.usedPercent, 0);
    assert.equal(overflow.percentKind, 'remaining');
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

describe('Kimi official usage parser', () => {
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

  it('retries with refreshed token on 401 (Codex)', async () => {
    const { refreshOfficialQuotaViaOAuth, resetQuotaCachesForTests } = await import('../dist/routes/quota.js');
    resetQuotaCachesForTests?.();
    let callCount = 0;
    const result = await refreshOfficialQuotaViaOAuth({
      claudeCredentials: null,
      codexCredentials: { accessToken: 'expired-token', refreshToken: 'valid-refresh', accountId: 'acct' },
      fetchLike: async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('auth.openai.com')) {
          return new Response(JSON.stringify({ access_token: 'fresh-codex-token' }), { status: 200 });
        }
        if (urlStr.includes('chatgpt.com')) {
          callCount++;
          if (callCount === 1) {
            return new Response('{"error":"invalid_token"}', { status: 401 });
          }
          return new Response(JSON.stringify(MOCK_CODEX_WHAM_RESPONSE), { status: 200 });
        }
        return new Response('', { status: 404 });
      },
    });
    assert.equal(callCount, 2);
    assert.ok(result.codex);
    assert.ok(result.codex.items > 0);
    assert.ok(!result.codex.error);
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

  it('sends form-encoded OAuth refresh request (not JSON)', async () => {
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
