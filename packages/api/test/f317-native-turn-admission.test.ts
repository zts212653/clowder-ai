import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerNativeTurnAdmissionRoute } from '../src/routes/callback-native-turn-admission.js';

test('native admission requires a currently verified invocation; no principal data is returned', async () => {
  let running = true;
  const app = Fastify();
  registerCallbackAuthHook(app, {
    verify: async (invocationId, callbackToken) => {
      if (!running) return { ok: false, reason: 'unknown_invocation' };
      if (invocationId !== 'inv' || callbackToken !== 'token') return { ok: false, reason: 'invalid_token' };
      return {
        ok: true,
        record: {
          invocationId,
          callbackToken,
          catId: createCatId('codex-astra'),
          threadId: 'thread',
          userId: 'user',
          createdAt: Date.now(),
          expiresAt: null,
        },
      };
    },
  });
  registerNativeTurnAdmissionRoute(app);
  const request = {
    method: 'GET' as const,
    url: '/api/callbacks/native-turn-admission',
    headers: { 'x-invocation-id': 'inv', 'x-callback-token': 'token' },
  };
  try {
    assert.equal((await app.inject({ method: 'GET', url: request.url })).statusCode, 401);
    const live = await app.inject(request);
    assert.equal(live.statusCode, 204);
    assert.equal(live.body, '');
    running = false;
    assert.equal((await app.inject(request)).statusCode, 401);
  } finally {
    await app.close();
  }
});
