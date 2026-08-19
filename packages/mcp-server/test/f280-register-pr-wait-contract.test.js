import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const EXPECTED_PUBLIC_KEYS = ['expiresAt', 'nextStep', 'prNumber', 'repoFullName', 'when'];

describe('F280 register_pr_tracking public contract', () => {
  it('exposes only the typed wait inputs', async () => {
    const { callbackTools, registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');

    assert.deepEqual(Object.keys(registerPrTrackingInputSchema).sort(), EXPECTED_PUBLIC_KEYS);
    const definition = callbackTools.find((tool) => tool.name === 'cat_cafe_register_pr_tracking');
    assert.equal(definition?.policy.activeState, 'canonical');
  });

  it('forwards typed predicates and never serializes legacy axes or caller baseline', async () => {
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
        when: [{ kind: 'pr_head_changed' }, { kind: 'pr_ci_terminal' }],
        nextStep: 'Re-lock the exact HEAD and continue merge-gate.',
        expiresAt: 1_785_500_000_000,
      });

      assert.deepEqual(requestBody, {
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 3300,
        when: [{ kind: 'pr_head_changed' }, { kind: 'pr_ci_terminal' }],
        nextStep: 'Re-lock the exact HEAD and continue merge-gate.',
        expiresAt: 1_785_500_000_000,
      });
      for (const forbidden of ['intent', 'wakePolicy', 'instructions', 'eventWait', 'baseline']) {
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
});
