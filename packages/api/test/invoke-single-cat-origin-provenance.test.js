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
