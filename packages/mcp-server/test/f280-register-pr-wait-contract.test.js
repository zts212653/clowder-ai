import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const EXPECTED_PUBLIC_KEYS = ['autoRenew', 'expiresAt', 'goal', 'nextStep', 'prNumber', 'repoFullName', 'when'];

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
  /*
   * #1392 AC-2: `expiresAt` is optional. The key stays in the public contract (a caller who wants
   * a deadline must be able to state it), but omitting it must mean "no time-based termination"
   * and must not reach the server as an explicit null or a zero.
   */
  it('makes expiresAt optional without removing it from the contract', async () => {
    const { registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');
    assert.equal(registerPrTrackingInputSchema.expiresAt.isOptional(), true);
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
      const { handleRegisterPrTracking } = await import('../dist/tools/callback-tools.js');
      await handleRegisterPrTracking({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 3300,
        when: [{ kind: 'pr_head_changed' }],
        nextStep: 'Continue.',
      });
      assert.equal(Object.hasOwn(requestBody, 'expiresAt'), false, 'PR: no deadline was asked for');
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  });
  it('offers autoRenew as an optional single-fire opt-out', async () => {
    const { registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');
    assert.equal(registerPrTrackingInputSchema.autoRenew.isOptional(), true);
  });

  /*
   * #1392 AC-3: a PR comment predicate names its audience. The tool must refuse the same shapes the
   * server refuses — an omitted audience is not "any author", and an empty one matches nobody.
   */
  it('requires a named audience on both PR comment predicates', async () => {
    const { registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');
    for (const kind of ['pr_conversation_comment_added', 'pr_inline_comment_added']) {
      assert.equal(registerPrTrackingInputSchema.when.safeParse([{ kind }]).success, false, `${kind}: omitted`);
      assert.equal(
        registerPrTrackingInputSchema.when.safeParse([{ kind, authorLogins: [] }]).success,
        false,
        `${kind}: empty`,
      );
      assert.equal(
        registerPrTrackingInputSchema.when.safeParse([{ kind, authorLogins: [' '] }]).success,
        false,
        `${kind}: blank login`,
      );
      assert.equal(
        registerPrTrackingInputSchema.when.safeParse([{ kind, authorLogins: ['pr-author'] }]).success,
        true,
        `${kind}: named`,
      );
    }
  });
  /*
   * The tool's prose duplicated the cap as a literal and drifted the moment the cap changed, telling
   * agents they could name at most four conditions while the schema already accepted eight. A stale
   * description is worse than a missing one: it is followed. So the number is derived, and this asserts
   * the derivation rather than any particular sentence.
   */
  it('the tool description states the real cap instead of a copy that can drift', async () => {
    const { callbackTools, registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');
    const description = callbackTools.find((tool) => tool.name === 'cat_cafe_register_pr_tracking')?.description ?? '';

    const cap = registerPrTrackingInputSchema.when._def.innerType._def.maxLength.value;
    assert.match(description, new RegExp(`up to ${cap} flat`), 'the prose must carry the schema’s own cap');
    assert.doesNotMatch(description, /1[–-]4/, 'no hand-written cap may survive in the prose');
  });

  /*
   * #1392 AC-7: the whole point is that a caller can register without naming conditions. If either of
   * these stops being optional at the public entry, the common path silently becomes the advanced one
   * again and every caller is back to hand-picking predicates they cannot verify they got right.
   */
  it('lets a caller register without naming any condition', async () => {
    const { registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');

    assert.equal(registerPrTrackingInputSchema.when.isOptional(), true, '`when` must be the advanced path');
    assert.equal(registerPrTrackingInputSchema.goal.isOptional(), true, 'naming who you wait on is additive');
  });

  /*
   * #1392 AC-7: the accepted default is a product decision, and the tool description is where a cat
   * learns it. A description that still described the old conservative default would send callers
   * back to hand-writing `goal.authorLogins` to hear anything — the precondition the product owner
   * explicitly removed.
   */
  it('the tool description states the accepted default audience, both perspectives', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const description = callbackTools.find((tool) => tool.name === 'cat_cafe_register_pr_tracking')?.description ?? '';

    assert.match(description, /every reply that is not your own, bots included/, 'the PR author perspective');
    assert.match(description, /bots and pure summon commands filtered/, 'the maintainer\u002freviewer perspective');
    assert.match(description, /delivers every comment flagged/, 'and what happens when neither can be proved');
    assert.doesNotMatch(description, /which is what arms their comments/, 'comments are no longer opt-in');
  });

  /*
   * #1392 D1: the ruling was that API and MCP move together. Until now only the API catalog had a
   * capacity assertion, so reverting this file alone to a cap of four left every other suite green —
   * the alignment the maintainer asked for had no regression protection at the public entry.
   */
  it('accepts the five-condition baseline a PR author needs at the public entry', async () => {
    const { registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');

    const parsed = registerPrTrackingInputSchema.when.safeParse([
      { kind: 'pr_review_decision_changed' },
      { kind: 'pr_conversation_comment_added', authorLogins: ['zts212653'] },
      { kind: 'pr_inline_comment_added', authorLogins: ['zts212653'] },
      { kind: 'pr_ci_terminal' },
      { kind: 'pr_became_conflicting' },
    ]);

    assert.equal(parsed.success, true, 'the MCP entry must not reject five distinct supported conditions');
  });

  it('accepts every distinct PR condition in the catalog at the public entry', async () => {
    const { registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');

    const parsed = registerPrTrackingInputSchema.when.safeParse([
      { kind: 'pr_head_changed' },
      { kind: 'pr_review_result_available' },
      { kind: 'pr_review_decision_changed' },
      { kind: 'pr_review_thread_changed', reviewThreadIds: ['RT_kwDO'] },
      { kind: 'pr_ci_terminal' },
      { kind: 'pr_became_conflicting' },
      { kind: 'pr_conversation_comment_added', authorLogins: ['zts212653'] },
      { kind: 'pr_inline_comment_added', authorLogins: ['zts212653'] },
    ]);

    assert.equal(parsed.success, true, 'MCP capacity must be derived from the same catalog as the API');
  });

  /*
   * Raising capacity must not relax what the entry already refuses. Deduplication is deliberately not
   * asserted here: it lives in the API schema this call forwards to, so a duplicate is still rejected
   * end to end, just one hop later. That asymmetry predates this change and is left as found rather
   * than widened into it.
   */
  it('still refuses an unknown kind and a precise wait without its anchor at the public entry', async () => {
    const { registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');

    assert.equal(
      registerPrTrackingInputSchema.when.safeParse([{ kind: 'pr_everything_please' }]).success,
      false,
      'unknown kinds must stay rejected',
    );
    assert.equal(
      registerPrTrackingInputSchema.when.safeParse([{ kind: 'pr_review_thread_changed' }]).success,
      false,
      'broader capacity is not a licence to fabricate a precise wait anchor',
    );
  });

  /*
   * #1392 R2 follow-up: an agent builds its wait from this description, so a description that still
   * promised replacement would have a reviewer name a third party, be told exactly that login wakes
   * them, and get an audience — author-only, further narrowed to the named login — that matches
   * nobody. The dead combination has to be stated here, where the wait is written.
   */
  it('the goal description states narrowing, and names the audience that matches nobody', async () => {
    const { registerPrTrackingInputSchema } = await import('../dist/tools/callback-tools.js');
    const description = registerPrTrackingInputSchema.goal.description ?? '';

    assert.match(description, /narrows the audience/i, 'the list narrows the role-derived rule');
    assert.match(description, /both rules apply/i, 'and both rules have to admit a comment');
    assert.match(description, /matches nobody/i, 'the dead combination must be named, not implied');
    assert.doesNotMatch(description, /replaces the derived audience/i, 'the replacement promise is gone');
  });
});
