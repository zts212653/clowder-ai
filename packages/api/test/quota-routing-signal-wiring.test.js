import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

async function buildApp(observer) {
  const Fastify = (await import('fastify')).default;
  const quotaModule = await import('../dist/routes/quota.js');
  quotaModule.resetQuotaCachesForTests?.();
  const app = Fastify();
  await app.register(quotaModule.quotaRoutes, {
    routingQuotaObserver: observer,
    routingOwnerId: 'owner-1',
  });
  await app.ready();
  return { app, quotaModule };
}

describe('F051 quota refresh routing observation wiring', () => {
  it('observes a successful server-owned Kimi refresh without copying labels', async () => {
    const calls = [];
    const { app, quotaModule } = await buildApp({
      observeSnapshot: async (input) => calls.push(input),
    });
    quotaModule.setKimiCliProbeOverrideForTests?.(async () => [
      {
        label: 'private account weekly label',
        poolId: 'kimi-weekly',
        usedPercent: 97,
        percentKind: 'used',
        resetsAt: '2026-09-02T12:00:00.000Z',
      },
    ]);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/quota/refresh/kimi' });
      assert.equal(response.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].ownerId, 'owner-1');
      assert.equal(calls[0].providerId, 'kimi');
      assert.deepEqual(calls[0].items, [
        {
          poolId: 'kimi-weekly',
          usedPercent: 97,
          percentKind: 'used',
          resetsAt: Date.parse('2026-09-02T12:00:00.000Z'),
        },
      ]);
      assert.equal(JSON.stringify(calls[0]).includes('private account'), false);
    } finally {
      quotaModule.setKimiCliProbeOverrideForTests?.(null);
      await app.close();
    }
  });

  it('does not turn push payloads or observer failures into quota route failures', async () => {
    let calls = 0;
    const { app, quotaModule } = await buildApp({
      observeSnapshot: async () => {
        calls += 1;
        throw new Error('routing observer unavailable');
      },
    });
    quotaModule.setKimiCliProbeOverrideForTests?.(async () => [
      { label: 'weekly', poolId: 'kimi-weekly', usedPercent: 100 },
    ]);
    try {
      const push = await app.inject({
        method: 'PATCH',
        url: '/api/quota/codex',
        payload: { usageItems: [{ label: 'weekly', poolId: 'codex-main', usedPercent: 100 }] },
      });
      assert.equal(push.statusCode, 200);
      assert.equal(calls, 0, 'untrusted push cache updates must not write durable routing truth');

      const refresh = await app.inject({ method: 'POST', url: '/api/quota/refresh/kimi' });
      assert.equal(refresh.statusCode, 200);
      assert.equal(calls, 1);
    } finally {
      quotaModule.setKimiCliProbeOverrideForTests?.(null);
      await app.close();
    }
  });

  it('observes a successful official Codex refresh without exposing account identity', async () => {
    const previousEnabled = process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
    const previousCredentialsPath = process.env.CODEX_CREDENTIALS_PATH;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousFetch = globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'routing-quota-codex-'));
    const codexHome = join(dir, 'codex-home');
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'codex-access',
          refresh_token: 'codex-refresh',
          account_id: 'hidden-codex-account',
        },
      }),
      'utf-8',
    );
    process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = '1';
    delete process.env.CODEX_CREDENTIALS_PATH;
    process.env.CODEX_HOME = codexHome;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 100, reset_at: Math.floor((Date.now() + 60_000) / 1_000) },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const calls = [];
    const { app } = await buildApp({ observeSnapshot: async (input) => calls.push(input) });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/quota/refresh/official',
        payload: { providers: ['codex'] },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].providerId, 'codex');
      assert.equal(
        calls[0].items.some((item) => item.poolId === 'codex-main'),
        true,
      );
      assert.equal(JSON.stringify(calls[0]).includes('hidden-codex-account'), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousEnabled !== undefined) process.env.QUOTA_OFFICIAL_REFRESH_ENABLED = previousEnabled;
      else delete process.env.QUOTA_OFFICIAL_REFRESH_ENABLED;
      if (previousCredentialsPath !== undefined) process.env.CODEX_CREDENTIALS_PATH = previousCredentialsPath;
      else delete process.env.CODEX_CREDENTIALS_PATH;
      if (previousCodexHome !== undefined) process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
