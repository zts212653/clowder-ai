import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { CodexAppServerRpcError } from '../src/domains/cats/services/agents/providers/codex-app-server-rpc-error.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';

async function fixture(submitText: (text: string, source: string) => Promise<string>) {
  const store = new MessageStore();
  const published: string[] = [];
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'retry-call' },
    messageStore: store,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    publish: (message) => {
      published.push(message.id);
    },
  });
  await call.ready('native', {
    submitText,
    request: async (method) => {
      if (method === 'thread/realtime/start')
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      if (method === 'thread/realtime/stop')
        await call.observe({ method: 'thread/realtime/closed', params: { threadId: 'native' } });
      return {};
    },
  });
  await call.start('offer');
  return { call, store, published };
}

test('a rejected typed message retries with the same durable source; concurrent retries and acknowledged replay send once', async () => {
  const submitted: string[] = [];
  const h = await fixture(async (_text, source) => {
    submitted.push(source);
    if (submitted.length === 1)
      throw new CodexAppServerRpcError({ method: 'turn/steer', message: 'turn already completed' });
    return 'next-turn';
  });
  try {
    await assert.rejects(h.call.sendText('continue', 'client'), /turn already completed/);
    assert.equal(h.call.exposureReason(h.store.getById(h.published[0])!), null);
    const results = await Promise.all([h.call.sendText('continue', 'client'), h.call.sendText('continue', 'client')]);
    assert.deepEqual(
      results.map((value) => value.delivery),
      ['accepted', 'accepted'],
    );
    assert.equal(submitted.length, 2);
    assert.equal(new Set(submitted).size, 1);
    assert.equal(h.published.length, 1, 'a retry neither copies nor republishes the source');
    await h.call.sendText('continue', 'client');
    assert.equal(submitted.length, 2);
    assert.equal(h.call.exposureReason(h.store.getById(h.published[0])!), 'same_live_call_exposure');
  } finally {
    await h.call.stop();
  }
});

test('an ambiguous transport failure is not blindly resubmitted or reported as exposure', async () => {
  let attempts = 0;
  const h = await fixture(async () => {
    attempts++;
    throw new Error('transport disconnected before acknowledgement');
  });
  try {
    await assert.rejects(h.call.sendText('continue', 'client'), /transport disconnected/);
    await assert.rejects(h.call.sendText('continue', 'client'), /transport disconnected/);
    assert.equal(attempts, 1);
    assert.equal(h.call.exposureReason(h.store.getById(h.published[0])!), null);
  } finally {
    await h.call.stop();
  }
});

test('a surface timeout retains pending acceptance and a later retry observes it without another execution', async (t) => {
  let accept!: (id: string) => void;
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const accepted = new Promise<string>((resolve) => {
    accept = resolve;
  });
  let attempts = 0;
  const h = await fixture(async () => {
    attempts++;
    dispatched();
    return accepted;
  });
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const timedOut = assert.rejects(h.call.sendText('continue', 'client'), /timed out/);
    await started;
    t.mock.timers.tick(5001);
    await timedOut;
    const retry = h.call.sendText('continue', 'client');
    accept('accepted-turn');
    assert.equal((await retry).delivery, 'accepted');
    assert.equal(attempts, 1);
    assert.equal(h.published.length, 1);
  } finally {
    t.mock.timers.reset();
    await h.call.stop();
  }
});
