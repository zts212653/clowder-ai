import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const EXPECTED_PUBLIC_KEYS = ['expiresAt', 'issueNumber', 'nextStep', 'repoFullName', 'when'];

describe('F280 register_issue_tracking public contract', () => {
  it('exposes only typed issue wait inputs', async () => {
    const { callbackTools, registerIssueTrackingInputSchema } = await import('../dist/tools/callback-tools.js');
    assert.deepEqual(Object.keys(registerIssueTrackingInputSchema).sort(), EXPECTED_PUBLIC_KEYS);
    const definition = callbackTools.find((tool) => tool.name === 'cat_cafe_register_issue_tracking');
    assert.equal(definition?.policy.activeState, 'canonical');
  });

  it('forwards typed predicates and never serializes legacy actor policy, prose, or caller baseline', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    let requestBody;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'f280-issue-contract-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'f280-issue-contract-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    try {
      const { handleRegisterIssueTracking } = await import('../dist/tools/callback-tools.js');
      await handleRegisterIssueTracking({
        repoFullName: 'zts212653/cat-cafe',
        issueNumber: 1227,
        when: [{ kind: 'issue_author_commented' }],
        nextStep: 'Inspect the author reply.',
        expiresAt: 1_785_500_000_000,
      });
      assert.deepEqual(requestBody, {
        repoFullName: 'zts212653/cat-cafe',
        issueNumber: 1227,
        when: [{ kind: 'issue_author_commented' }],
        nextStep: 'Inspect the author reply.',
        expiresAt: 1_785_500_000_000,
      });
      for (const forbidden of ['wakePolicy', 'instructions', 'trackingInstructions', 'baseline']) {
        assert.equal(Object.hasOwn(requestBody, forbidden), false, `${forbidden} must not cross the public boundary`);
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    }
  });
});
