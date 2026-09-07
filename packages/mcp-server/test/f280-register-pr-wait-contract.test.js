import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const EXPECTED_PUBLIC_KEYS = ['exclude', 'include', 'nextStep', 'prNumber', 'repoFullName'];

describe('F280 register_pr_tracking public contract', () => {
  it('exposes one default-on subscription interface', async () => {
    const { callbackTools, registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');

    assert.deepEqual(Object.keys(registerPrTrackingInputSchema).sort(), EXPECTED_PUBLIC_KEYS);
    const definition = callbackTools.find((tool) => tool.name === 'cat_cafe_register_pr_tracking');
    assert.equal(definition?.policy.activeState, 'canonical');

    assert.deepEqual(registerPrTrackingInputSchema.exclude.parse(['ci_terminal']), ['ci_terminal']);
    assert.deepEqual(registerPrTrackingInputSchema.include.parse(['head_changed']), ['head_changed']);
  });

  it('forwards only named include/exclude adjustments and optional nextStep', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    let requestBody;

    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'f280-contract-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'f280-contract-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    try {
      const { handleRegisterPrTracking } = await import('../dist/tools/callback-tools.js');
      await handleRegisterPrTracking({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 3300,
        include: ['head_changed'],
        exclude: ['ci_terminal'],
        nextStep: 'Re-lock the exact HEAD and continue merge-gate.',
      });

      assert.deepEqual(requestBody, {
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 3300,
        include: ['head_changed'],
        exclude: ['ci_terminal'],
        nextStep: 'Re-lock the exact HEAD and continue merge-gate.',
      });
      for (const forbidden of ['when', 'expiresAt', 'autoRenew', 'intent', 'wakePolicy', 'baseline']) {
        assert.equal(Object.hasOwn(requestBody, forbidden), false, `${forbidden} must not cross the public boundary`);
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  });

  it('the bare call forwards exactly repo and PR number', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    let requestBody;

    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'f280-contract-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'f280-contract-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    try {
      const { handleRegisterPrTracking } = await import('../dist/tools/callback-tools.js');
      await handleRegisterPrTracking({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 3300,
      });

      assert.deepEqual(requestBody, {
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 3300,
      });
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  });
});
