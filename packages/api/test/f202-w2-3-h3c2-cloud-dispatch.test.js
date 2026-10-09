/**
 * F202 W2-3 h3c-2 — dispatch and the thread's binding answer to the configured cloud cat, whatever
 * its id; a provider with several cats is refused before any grant or delivery, naming the cats
 * (ledger「h3c 实现设计」h3c-2, 实现边界; astra `…000181`).
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { buildFallbackMessageContent } from '../dist/domains/cats/services/cloud-bridge/cloud-bridge-fallback.js';
import { MemoryCloudReturnGrantStore } from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { configureCats } from './helpers/cloud-return-harness.js';

/** The dispatched source, as the Host mints message ids. */
const SOURCE_ID = '0000000000001000-000001-abcdef01';

beforeEach(() => configureCats(['cloud-alt']));

function dispatchHarness({ grantStore } = {}) {
  const bridgeCalls = [];
  const grants = [];
  const deps = {
    registry: new InvocationRegistry(),
    sessionManager: {},
    threadStore: {
      get: async () => ({ id: 'thread_t1', title: 'demo', participants: ['opus', 'cloud-alt'] }),
      getCloudCatBindings: async () => ({}),
      updateCloudCatBinding: async () => undefined,
    },
    apiUrl: 'http://localhost:0',
    cloudReturnGrantStore: grantStore ?? {
      issue: async (claims) => {
        grants.push(claims);
        return { ok: true, status: 'issued' };
      },
    },
    cloudInvokeBridge: {
      dispatch: async (params) => {
        bridgeCalls.push(params);
        return { kind: 'sent', capturedUrl: 'https://chatgpt.com/c/demo', transport: 'host', hostMessageId: 'h-1' };
      },
    },
  };
  const dispatch = async (catId) => {
    const messages = [];
    for await (const message of invokeSingleCat(deps, {
      catId,
      service: { usesChainKeyResume: () => false },
      prompt: 'orchestrated prompt',
      userId: 'alice',
      threadId: 'thread_t1',
      ownerAuthProvenance: 'strict',
      isLastCat: true,
      executionCausal: { triggerMessageId: SOURCE_ID },
      mentionContent: 'raw words',
      mentioningCatId: 'opus',
    })) {
      messages.push(message);
    }
    const status = messages
      .filter((message) => message.type === 'system_info' && message.content)
      .map((message) => JSON.parse(message.content))
      .find((payload) => payload.type === 'cloud_bridge_status');
    return { messages, status };
  };
  return { bridgeCalls, grants, dispatch };
}

test('a cloud cat that is not gpt-pro is dispatched, and granted its return, as itself', async () => {
  const h = dispatchHarness();
  const { status, messages } = await h.dispatch('cloud-alt');

  assert.equal(h.bridgeCalls.length, 1);
  assert.equal(h.bridgeCalls[0].catId, 'cloud-alt');
  assert.deepEqual(
    h.grants.map((grant) => grant.targetCatId),
    ['cloud-alt'],
  );
  assert.equal(status.status, 'sent');
  assert.equal(messages.at(-1).type, 'done');
});

test('several cats on one cloud provider: refused before any grant or delivery, naming them', async () => {
  configureCats(['cloud-alt', 'cloud-beta']);
  const h = dispatchHarness();
  const { status, messages } = await h.dispatch('cloud-alt');

  assert.equal(h.bridgeCalls.length, 0);
  assert.equal(h.grants.length, 0);
  assert.equal(status.status, 'unavailable');
  assert.equal(status.reason, 'ambiguous-cloud-cat');
  assert.match(status.message, /@cloud-alt/);
  assert.match(status.detail, /cloud-alt, cloud-beta/);
  assert.equal(status.outboundReceipt.status, 'failed');
  assert.equal(status.outboundReceipt.idempotency.disposition, 'not_attempted');
  assert.equal(messages.at(-1).type, 'done');
});

test('P1-3: a message already sent to one cloud cat is not sent again to another', async () => {
  const grantStore = new MemoryCloudReturnGrantStore(Date.now, { historyBoundary: 0 });
  await grantStore.issue({
    threadId: 'thread_t1',
    userId: 'alice',
    sourceMessageId: SOURCE_ID,
    dispatchInvocationId: 'earlier-dispatch',
    targetCatId: 'cloud-alt',
  });
  configureCats(['cloud-beta']);
  const h = dispatchHarness({ grantStore });
  const { status, messages } = await h.dispatch('cloud-beta');

  assert.equal(h.bridgeCalls.length, 0);
  assert.equal(status.reason, 'source-retargeted');
  assert.match(status.message, /@cloud-beta/);
  assert.match(status.detail, /cloud-alt/);
  assert.equal(messages.at(-1).type, 'done');
});

test('the needs-binding notice names the cat it was for', () => {
  const { message } = JSON.parse(buildFallbackMessageContent({ reason: 'needs-binding', catId: 'cloud-alt' }));
  assert.match(message, /@cloud-alt 尚未绑定/);
});

// ── The thread's binding: the panel reads the configured cloud cat's entry ──

async function bindingsApp(bindings) {
  const { threadsRoutes } = await import('../dist/routes/threads.js');
  const app = Fastify();
  await app.register(threadsRoutes, {
    threadStore: {
      get: async (id) => (id === 'T1' ? { id: 'T1', createdBy: 'alice', deletedAt: null } : null),
      getCloudCatBindings: async () => ({ ...bindings }),
      updateCloudCatBinding: async () => undefined,
      list: async () => [],
      listByProject: async () => [],
    },
    messageStore: { getByThread: async () => [], getByThreadBefore: async () => [] },
    taskStore: { listByThread: async () => [] },
  });
  const read = async () =>
    (
      await app.inject({
        method: 'GET',
        url: '/api/threads/T1/cloud-bindings',
        headers: { 'x-cat-cafe-user': 'alice' },
      })
    ).json();
  return { app, read };
}

test("the thread's bindings come with the Host's answer to which cat is the cloud cat", async () => {
  const bindings = { 'cloud-alt': 'https://chatgpt.com/c/alt', 'gpt-pro': 'https://chatgpt.com/c/stale' };
  const { app, read } = await bindingsApp(bindings);

  assert.deepEqual(await read(), { bindings, cloudCat: { status: 'resolved', catId: 'cloud-alt' } });
  configureCats([]);
  assert.deepEqual((await read()).cloudCat, { status: 'unavailable' });
  configureCats(['cloud-alt', 'cloud-beta']);
  assert.deepEqual((await read()).cloudCat, { status: 'ambiguous', catIds: ['cloud-alt', 'cloud-beta'] });
  await app.close();
});
