/**
 * F247 AC-B1c-2 R1: invokeSingleCat × bridge wiring contract.
 *
 * gpt52 R1 P1-1 + P1-2 ground-truth fixes pinned by this test:
 *
 *  - When `InvocationDeps.cloudInvokeBridge` is supplied AND
 *    `InvocationParams.mentionContent` + `mentioningCatId` are present,
 *    bridge.dispatch() is called with the RAW mention text + RAW mentioning
 *    catId (NOT the orchestrated prompt, NOT the thread owner userId).
 *
 *  - When the bridge is supplied but either field is missing, dispatch is
 *    SUPPRESSED (not called) — safer than sending wrong content. This pins
 *    the PR-B "library drop" contract: until PR-C plumbs mentionContent /
 *    mentioningCatId from `route-serial`/`route-parallel`, the bridge stays
 *    dormant rather than emitting incorrect deltas.
 *
 *  - The KD-17 guard still yields `done` and returns regardless of bridge
 *    state — invokeSingleCat NEVER blocks on bridge completion.
 *
 *  - No exception escapes the guard, even if bridge.dispatch rejects.
 *
 * NOTE: this is a unit test of the *guard contract*, not a full route-level
 * integration. Real `route-serial` / `route-parallel` integration tests land
 * with PR-C wiring.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { catRegistry } from '@cat-cafe/shared';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';

// Ensure gpt-pro is in the registry for these tests (its `openai-chatgpt-pro`
// provider is what triggers the KD-17 guard we're exercising).
function ensureGptProRegistered() {
  if (catRegistry.has('gpt-pro')) return;
  catRegistry.register('gpt-pro', {
    catId: 'gpt-pro',
    clientId: 'openai',
    provider: 'openai-chatgpt-pro',
    avatar: '/avatars/gpt-pro.png',
  });
}

function makeMockThreadStore() {
  return {
    get: async (_id) => ({ id: 'thread_t1', title: 'demo', participants: ['opus-47', 'gpt-pro'] }),
    getCloudCatBindings: async () => ({}),
    updateCloudCatBinding: async () => undefined,
  };
}

function makeRecordingBridge({ throwInDispatch = false } = {}) {
  const calls = [];
  return {
    calls,
    dispatch: async (params) => {
      calls.push(params);
      if (throwInDispatch) throw new Error('bridge boom');
    },
  };
}

function makeMinimalDeps(extraDeps = {}) {
  return {
    registry: { put: () => {}, get: () => null, getAll: () => [] },
    sessionManager: {},
    threadStore: makeMockThreadStore(),
    apiUrl: 'http://localhost:0',
    ...extraDeps,
  };
}

const baseParams = {
  catId: 'gpt-pro',
  service: { usesChainKeyResume: () => false },
  prompt: 'FULL ORCHESTRATED PROMPT — must not appear in delta intent',
  userId: 'alice',
  threadId: 'thread_t1',
  isLastCat: true,
};

async function drainGenerator(gen) {
  const messages = [];
  for await (const msg of gen) {
    messages.push(msg);
  }
  return messages;
}

describe('F247 AC-B1c-2 R1: invokeSingleCat × bridge wiring contract', () => {
  it('SUPPRESSES bridge dispatch when bridge wired but mentionContent missing (gpt52 R1 P1-2)', async () => {
    ensureGptProRegistered();
    const bridge = makeRecordingBridge();
    const deps = makeMinimalDeps({ cloudInvokeBridge: bridge });
    const messages = await drainGenerator(
      invokeSingleCat(deps, {
        ...baseParams,
        mentioningCatId: 'opus-47',
        // mentionContent omitted intentionally
      }),
    );
    assert.equal(bridge.calls.length, 0, 'bridge NOT called when mentionContent missing');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'done');
  });

  it('SUPPRESSES bridge dispatch when bridge wired but mentioningCatId missing', async () => {
    ensureGptProRegistered();
    const bridge = makeRecordingBridge();
    const deps = makeMinimalDeps({ cloudInvokeBridge: bridge });
    const messages = await drainGenerator(
      invokeSingleCat(deps, {
        ...baseParams,
        mentionContent: 'raw user words',
        // mentioningCatId omitted
      }),
    );
    assert.equal(bridge.calls.length, 0, 'bridge NOT called when mentioningCatId missing');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'done');
  });

  it('DOES dispatch when bridge + both new fields supplied (RAW intent + RAW mentioningCatId)', async () => {
    ensureGptProRegistered();
    const bridge = makeRecordingBridge();
    const deps = makeMinimalDeps({ cloudInvokeBridge: bridge });
    const messages = await drainGenerator(
      invokeSingleCat(deps, {
        ...baseParams,
        mentionContent: 'help me audit the auth flow',
        mentioningCatId: 'opus-47',
      }),
    );
    assert.equal(bridge.calls.length, 1, 'bridge IS called when both fields supplied');
    const dispatchedParams = bridge.calls[0];
    // gpt52 R1 P1-2: intent MUST be the raw mention content, NOT the prompt.
    assert.equal(dispatchedParams.intent, 'help me audit the auth flow');
    assert.notEqual(dispatchedParams.intent, baseParams.prompt, 'intent must not be the orchestrated prompt');
    // gpt52 R1 P1-2: calledBy MUST be the mentioning catId, NOT the userId.
    assert.equal(dispatchedParams.calledBy, 'opus-47');
    assert.notEqual(dispatchedParams.calledBy, baseParams.userId, 'calledBy must not be the thread owner userId');
    assert.equal(messages[0].type, 'done', 'guard still yields done');
  });

  it('NEVER blocks the generator on bridge completion (fire-and-forget)', async () => {
    ensureGptProRegistered();
    let resolveDispatch;
    const slowDispatch = new Promise((res) => {
      resolveDispatch = res;
    });
    const bridge = {
      dispatch: () => slowDispatch,
    };
    const deps = makeMinimalDeps({ cloudInvokeBridge: bridge });
    const start = Date.now();
    const messages = await drainGenerator(
      invokeSingleCat(deps, {
        ...baseParams,
        mentionContent: 'asap',
        mentioningCatId: 'opus-47',
      }),
    );
    const elapsed = Date.now() - start;
    assert.equal(messages[0].type, 'done');
    assert.ok(elapsed < 500, `generator returned in ${elapsed}ms — must not await dispatch`);
    resolveDispatch();
  });

  it('absorbs bridge.dispatch() rejection (no exception escape)', async () => {
    ensureGptProRegistered();
    const bridge = makeRecordingBridge({ throwInDispatch: true });
    const deps = makeMinimalDeps({ cloudInvokeBridge: bridge });
    // Drain the generator — must NOT throw even though bridge.dispatch rejects.
    const messages = await drainGenerator(
      invokeSingleCat(deps, {
        ...baseParams,
        mentionContent: 'words',
        mentioningCatId: 'opus-47',
      }),
    );
    assert.equal(messages[0].type, 'done', 'guard yields done despite bridge rejection');
  });

  it('NO-OPS when bridge is null (back-compat with InvocationDeps without bridge wired)', async () => {
    ensureGptProRegistered();
    const deps = makeMinimalDeps({ cloudInvokeBridge: null });
    const messages = await drainGenerator(
      invokeSingleCat(deps, {
        ...baseParams,
        mentionContent: 'words',
        mentioningCatId: 'opus-47',
      }),
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'done');
  });

  it('NO-OPS when bridge field absent (undefined) from deps', async () => {
    ensureGptProRegistered();
    const deps = makeMinimalDeps(); // no cloudInvokeBridge at all
    const messages = await drainGenerator(
      invokeSingleCat(deps, {
        ...baseParams,
        mentionContent: 'words',
        mentioningCatId: 'opus-47',
      }),
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'done');
  });
});
