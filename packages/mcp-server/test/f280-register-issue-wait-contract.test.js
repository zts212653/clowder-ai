import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const EXPECTED_PUBLIC_KEYS = ['autoRenew', 'expiresAt', 'issueNumber', 'nextStep', 'repoFullName', 'when'];

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
  /*
   * #1392 AC-2: `expiresAt` is optional. The key stays in the public contract (a caller who wants
   * a deadline must be able to state it), but omitting it must mean "no time-based termination"
   * and must not reach the server as an explicit null or a zero.
   */
  it('makes expiresAt optional without removing it from the contract', async () => {
    const { registerIssueTrackingInputSchema } = await import('../dist/tools/callback-tools.js');
    assert.equal(registerIssueTrackingInputSchema.expiresAt.isOptional(), true);
  });

  it('does not serialize an omitted expiresAt', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    let requestBody;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'f280-no-deadline-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'f280-no-deadline-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    try {
      const { handleRegisterIssueTracking } = await import('../dist/tools/callback-tools.js');
      await handleRegisterIssueTracking({
        repoFullName: 'zts212653/cat-cafe',
        issueNumber: 861,
        when: [{ kind: 'issue_comment_added' }],
        nextStep: 'Continue.',
      });
      assert.equal(Object.hasOwn(requestBody, 'expiresAt'), false, 'issue: no deadline was asked for');
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  });
  /*
   * #1392 AC-7: the issue entry kept a mandatory `when[]` for three rounds after the PR entry dropped
   * its own, and "AC-7 is in" stayed literally true the whole time. A caller who has to name a
   * predicate is a caller who can name the wrong one and never find out, which is the failure this
   * issue opened with — so the contract is asserted here, at the door a cat actually walks through.
   */
  it('lets a caller register an issue without naming any condition', async () => {
    const { registerIssueTrackingInputSchema } = await import('../dist/tools/callback-tools.js');

    assert.equal(registerIssueTrackingInputSchema.when.isOptional(), true, '`when` must be the advanced path');
    assert.equal(registerIssueTrackingInputSchema.nextStep.isOptional(), true, 'display-only text cannot gate it');
  });

  it('does not serialize an omitted when, so the server sees "arm the default"', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    let requestBody;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'ac7-issue-default-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'ac7-issue-default-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    try {
      const { handleRegisterIssueTracking } = await import('../dist/tools/callback-tools.js');
      await handleRegisterIssueTracking({ repoFullName: 'zts212653/clowder-ai', issueNumber: 1392 });
      assert.deepEqual(requestBody, { repoFullName: 'zts212653/clowder-ai', issueNumber: 1392 });
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  });

  it('the tool description tells a cat the normal call, not a predicate menu', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const description =
      callbackTools.find((tool) => tool.name === 'cat_cafe_register_issue_tracking')?.description ?? '';

    assert.match(description, /omit `when` and `nextStep`/);
    assert.match(description, /every comment that is not your own/);
  });

  it('offers autoRenew as an optional single-fire opt-out', async () => {
    const { registerIssueTrackingInputSchema } = await import('../dist/tools/callback-tools.js');
    assert.equal(registerIssueTrackingInputSchema.autoRenew.isOptional(), true);
  });

  /*
   * #1392 AC-3: `issue_comment_added` accepts an optional `authorLogins`. The server honoured it,
   * but this tool's strict schema refused the key — so the audience existed only for raw HTTP
   * callers, and no cat could use it.
   */
  it('accepts an optional issue comment audience and forwards it unchanged', async () => {
    const { registerIssueTrackingInputSchema, handleRegisterIssueTracking } = await import(
      '../dist/tools/callback-tools.js'
    );
    const named = [{ kind: 'issue_comment_added', authorLogins: ['maintainer'] }];
    assert.equal(registerIssueTrackingInputSchema.when.safeParse(named).success, true, 'named audience');
    assert.equal(
      registerIssueTrackingInputSchema.when.safeParse([{ kind: 'issue_comment_added' }]).success,
      true,
      'omitted audience stays valid for issues',
    );
    assert.equal(
      registerIssueTrackingInputSchema.when.safeParse([{ kind: 'issue_comment_added', authorLogins: [] }]).success,
      false,
      'an empty audience matches nobody',
    );
    assert.equal(
      registerIssueTrackingInputSchema.when.safeParse([{ kind: 'issue_comment_added', authorLogins: [' '] }]).success,
      false,
      'a blank login matches nobody either',
    );

    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    let requestBody;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'f280-issue-audience-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'f280-issue-audience-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    try {
      await handleRegisterIssueTracking({
        repoFullName: 'zts212653/cat-cafe',
        issueNumber: 1392,
        when: named,
        nextStep: 'Read the maintainer reply.',
      });
      assert.deepEqual(requestBody.when, named);
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    }
  });
  /*
   * #1392 D1: the issue surface is capped by its own half of the catalog, so both distinct kinds must
   * be nameable in one registration. Asserted here for the same reason as the PR entry — without it,
   * a cap regression at the public entry would be invisible to every other suite.
   */
  it('accepts every distinct issue condition in the catalog at the public entry', async () => {
    const { registerIssueTrackingInputSchema } = await import('../dist/tools/callback-tools.js');

    const parsed = registerIssueTrackingInputSchema.when.safeParse([
      { kind: 'issue_comment_added', authorLogins: ['zts212653'] },
      { kind: 'issue_author_commented' },
    ]);

    assert.equal(parsed.success, true, 'both issue kinds must be registrable together');
  });
});
