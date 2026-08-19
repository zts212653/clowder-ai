import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

describe('F276 defer route requires durable disposition authority', () => {
  it('rejects an attributed defer before staging when either authority store is absent', async () => {
    const [routeMod, registryMod, messageMod, authMod] = await Promise.all([
      import('../../dist/routes/callback-defer-person-memory-routes.js'),
      import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
      import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../../dist/routes/callback-auth-prehandler.js'),
    ]);
    const registry = new registryMod.InvocationRegistry();
    const messageStore = new messageMod.MessageStore();
    let stageCalls = 0;
    const app = Fastify();
    authMod.registerCallbackAuthHook(app, registry);
    routeMod.registerCallbackDeferPersonMemoryRoutes(app, {
      registry,
      messageStore,
      receiptStore: {
        async stage() {
          stageCalls += 1;
          return { outcome: 'conflict' };
        },
        async rearmWriteOpportunity() {
          return { outcome: 'conflict' };
        },
        async get() {
          return null;
        },
        async withdraw() {
          return { outcome: 'not_available' };
        },
        async hardForget() {
          return { outcome: 'already_absent' };
        },
      },
      registryResolver: { resolve: async () => ({ kind: 'registered_person', ref: 'person-1' }) },
    });
    await app.ready();
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: 'owner turn',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-current',
    });
    const fact = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: 'known person fact',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-history',
    });
    const auth = await registry.create(
      'owner-1',
      'codex-sol',
      origin.threadId,
      undefined,
      undefined,
      undefined,
      origin.id,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/defer-person-memory',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
        'content-type': 'application/json',
      },
      payload: {
        subject: '黄挺',
        sources: [{ kind: 'message', messageId: fact.id }],
        clientRequestId: 'request-without-authority',
        writeOpportunityRef: {
          opportunityId: `write_opp_${'c'.repeat(32)}`,
          dedupeLineage: `write_lineage_${'a'.repeat(32)}`,
          generation: 1,
        },
      },
    });

    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().reason, 'write_opportunity_durable_authority_unavailable');
    assert.equal(stageCalls, 0);
  });
});
