import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';

test('invokeSingleCat persists the exact turn trigger separately from A2A reply threading', async () => {
  const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
  let createArgs;
  const deps = {
    registry: {
      async create(...args) {
        createArgs = args;
        return { invocationId: 'inv-direct-origin', callbackToken: 'tok-direct-origin' };
      },
      async verify() {
        return { ok: false, reason: 'unknown_invocation' };
      },
    },
    sessionManager: {
      async get() {
        return undefined;
      },
      async getOrCreate() {
        return {};
      },
      async store() {},
      async delete() {},
      resolveWorkingDirectory() {
        return '/tmp/test';
      },
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
  };
  const service = {
    async *invoke() {
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };

  for await (const _message of invokeSingleCat(deps, {
    catId: 'codex',
    service,
    prompt: 'direct user request',
    userId: 'user-1',
    threadId: 'thread-1',
    isLastCat: true,
    executionCausal: { triggerMessageId: 'msg-user-direct' },
  })) {
    // Drain the invocation so registry.create is observed through the real path.
  }

  assert.equal(createArgs[4], undefined, 'direct user turns must not become A2A replyTo provenance');
  assert.equal(createArgs[6], 'msg-user-direct', 'exact turn origin must reach callback auth storage');
});

for (const [origin, provenance, expected, live = false, explicitSeed = false] of [
  ['interactive', 'strict', true],
  ['interactive', 'legacy_fallback', false],
  ['a2a', 'strict', false],
  ['interactive', 'strict', false, true],
  ['interactive', 'strict', false, true, true],
]) {
  test(`F321 opening hook: ${origin}/${provenance}, Live=${live}, explicit cue=${explicitSeed}`, async () => {
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    const prepared = [];
    const resolved = [];
    const deps = {
      registry: {
        create: async () => ({ invocationId: 'inv-f321-wiring', callbackToken: 'token' }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      threadOverviewOpportunitySource: {
        async prepareOpportunity(input) {
          prepared.push(input);
          return {
            kind: 'thread_opened',
            producer: 'owner_message',
            occurredAt: input.occurredAt,
            payload: { sourceMessageId: input.sourceMessageId },
          };
        },
      },
      memoryCuePromptService: {
        async resolve(input) {
          resolved.push(input);
          return {
            promptSegment: '',
            presentationEnvelopes: [],
            deliveryReceipts: [],
            admittedOpportunityIds: [],
            omittedOpportunityIds: [],
          };
        },
      },
    };
    const service = {
      async *invoke() {
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    for await (const _ of invokeSingleCat(deps, {
      catId: 'codex',
      service,
      prompt: 'new idea',
      userId: 'owner',
      threadId: 'new',
      isLastCat: true,
      invocationOrigin: origin,
      ownerAuthProvenance: provenance,
      executionCausal: { triggerMessageId: 'first-owner-message' },
      ...(live
        ? { liveCompanion: { finished: new Promise(() => {}), ready: async () => {}, observe: async () => {} } }
        : {}),
      ...(explicitSeed
        ? {
            memoryCueOpportunitySeeds: [
              {
                kind: 'thread_opened',
                producer: 'owner_message',
                occurredAt: 1,
                payload: { sourceMessageId: 'explicit' },
              },
            ],
          }
        : {}),
    })) {
    }
    assert.equal(prepared.length, expected ? 1 : 0);
    assert.equal(resolved.length, expected || explicitSeed ? 1 : 0);
    if (explicitSeed) assert.equal(resolved[0].seeds[0].payload.sourceMessageId, 'explicit');
    if (expected) {
      assert.equal(prepared[0].sourceMessageId, 'first-owner-message');
      assert.equal(prepared[0].consumerCatId, 'codex');
      assert.equal(resolved[0].seeds[0].payload.sourceMessageId, 'first-owner-message');
      assert.equal(resolved[0].serverScope.invocationId, 'inv-f321-wiring');
    }
  });
}

test('owner Stop reaches the opening cue before provider startup through the real invocation path', async () => {
  const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
  const controller = new AbortController();
  let receivedSignal;
  let providerCalls = 0;
  const deps = {
    registry: {
      create: async () => ({ invocationId: 'inv-stop', callbackToken: 'token' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    threadOverviewOpportunitySource: {
      async prepareOpportunity(input) {
        return {
          kind: 'thread_opened',
          producer: 'owner_message',
          occurredAt: input.occurredAt,
          payload: { sourceMessageId: input.sourceMessageId },
        };
      },
    },
    memoryCuePromptService: {
      async resolve(input) {
        receivedSignal = input.signal;
        controller.abort(new Error('owner Stop'));
        return {
          promptSegment: '',
          presentationEnvelopes: [],
          deliveryReceipts: [],
          admittedOpportunityIds: [],
          omittedOpportunityIds: [],
        };
      },
    },
  };
  const service = {
    async *invoke() {
      providerCalls++;
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  for await (const _ of invokeSingleCat(deps, {
    catId: 'codex',
    service,
    prompt: 'new idea',
    userId: 'owner',
    threadId: 'new',
    isLastCat: true,
    invocationOrigin: 'interactive',
    ownerAuthProvenance: 'strict',
    executionCausal: { triggerMessageId: 'first' },
    signal: controller.signal,
  })) {
  }
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(providerCalls, 0);
});
