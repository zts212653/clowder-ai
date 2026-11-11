import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { memoryProposalNativeClient } from './helpers/memory-proposal-native-client.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

describe('F231 approval origin authentication', () => {
  let app;
  let dataDir;
  let messageStore;
  let proposalStore;
  let registry;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'f231-origin-'));
    const routeMod = await import('../dist/routes/callback-propose-profile-update-routes.js');
    const registryMod = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
    const storeMod = await import('../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js');
    const messageMod = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const authMod = await import('../dist/routes/callback-auth-prehandler.js');
    const repositoryMod = await import('../dist/domains/cats/services/profile/ProfileRepository.js');

    registry = new registryMod.InvocationRegistry();
    proposalStore = new storeMod.InMemoryProfileUpdateProposalStore();
    messageStore = new messageMod.MessageStore();
    const repository = new repositoryMod.FileProfileRepository({
      dataDir,
      relationshipKeyForCat: () => 'ragdoll',
    });
    const socketManager = { emitToUser() {}, broadcastToRoom() {} };

    app = Fastify();
    authMod.registerCallbackAuthHook(app, registry);
    routeMod.registerCallbackProposeProfileUpdateRoutes(app, {
      registry,
      proposalStore,
      messageStore,
      socketManager,
      repository,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function appendUserMessage(content) {
    return messageStore.append(
      canonicalTestMessageInput({
        userId: 'alice',
        catId: null,
        content,
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_1',
      }),
    );
  }

  async function propose(sourceMessageId, originTriggerMessageId, payload = {}) {
    const auth = await registry.create(
      'alice',
      'opus',
      'thread_1',
      undefined,
      undefined,
      undefined,
      originTriggerMessageId,
    );
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-profile-update',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
        'content-type': 'application/json',
      },
      payload: {
        afterContent: 'NEW primer',
        rationale: 'Observed preference',
        signalKind: 'cat-declared',
        sourceMessageId,
        ...payload,
      },
    });
  }

  it('rejects a caller-selected same-thread message that is not the authenticated invocation origin', async () => {
    const invocationOrigin = await appendUserMessage('Please update the profile');
    const unrelatedMessage = await appendUserMessage('A different message in the same thread');

    const response = await propose(unrelatedMessage.id, invocationOrigin.id);

    assert.equal(response.statusCode, 400);
    assert.match(JSON.parse(response.body).error, /authenticated invocation origin/i);
    assert.deepEqual(await proposalStore.listPending('alice'), []);
  });

  it('derives the source message from callback auth when the caller omits sourceMessageId', async () => {
    const invocationOrigin = await appendUserMessage('Please update the profile');

    const response = await propose(undefined, invocationOrigin.id);

    assert.equal(response.statusCode, 200);
    const [stored] = await proposalStore.listPending('alice');
    assert.equal(stored.signalProvenance.sourceMessageId, invocationOrigin.id);
    assert.deepEqual(stored.publication.envelope.originRef, {
      kind: 'message',
      threadId: 'thread_1',
      messageId: invocationOrigin.id,
    });
  });

  it('fails closed when the authenticated invocation has no exact message origin', async () => {
    const callerSelectedMessage = await appendUserMessage('Caller-selected source');

    const response = await propose(callerSelectedMessage.id, undefined);

    assert.equal(response.statusCode, 400);
    assert.match(JSON.parse(response.body).error, /exact source message/i);
    assert.deepEqual(await proposalStore.listPending('alice'), []);
  });

  it('recovers an unchanged explicit profile source through two real MCP invocations', async () => {
    const source = await appendUserMessage('Original profile request');
    const later = await appendUserMessage('Continue the original request');
    const auth = (origin) => registry.create('alice', 'opus', 'thread_1', undefined, undefined, undefined, origin.id);
    const api = await app.listen({ port: 0, host: '127.0.0.1' });
    let client = await memoryProposalNativeClient(api, await auth(source), dataDir);
    try {
      const input = {
        afterContent: 'NEW primer',
        rationale: 'Observed preference',
        signalKind: 'cat-declared',
        sourceMessageId: source.id,
        clientRequestId: 'native-profile-explicit-source',
      };
      const call = (args) => client.callTool({ name: 'cat_cafe_propose_profile_update', arguments: args });
      const first = await call(input);
      assert.notEqual(first.isError, true, JSON.stringify(first));
      const id = JSON.parse(first.content[0].text).proposalId;
      await client.close();
      client = await memoryProposalNativeClient(api, await auth(later), dataDir);
      const retry = await call(input);
      assert.notEqual(retry.isError, true, JSON.stringify(retry));
      assert.equal(JSON.parse(retry.content[0].text).proposalId, id);
      const changed = await call({ ...input, sourceMessageId: later.id });
      assert.equal(changed.isError, true, JSON.stringify(changed));
      assert.ok(JSON.stringify(changed).includes('client_request_conflict'));
      assert.equal((await proposalStore.get(id)).signalProvenance.sourceMessageId, source.id);
    } finally {
      await client.close();
    }
  });

  for (const staged of [false, true]) {
    it(`recovers an unchanged explicit profile source from a later invocation (${staged ? 'staged' : 'anchored'})`, async () => {
      const source = await appendUserMessage('Original profile request');
      const later = await appendUserMessage('Continue that request');
      const payload = { clientRequestId: 'profile-explicit-retry' };
      const commit = proposalStore.commitEnvelope.bind(proposalStore);
      if (staged)
        proposalStore.commitEnvelope = async () => {
          throw new Error('Interrupted after original card');
        };
      const first = await propose(source.id, source.id, payload);
      assert.equal(first.statusCode, staged ? 500 : 200, first.body);
      proposalStore.commitEnvelope = commit;
      const savedId = await proposalStore.getDedupProposalId('alice', payload.clientRequestId);
      const retried = await propose(source.id, later.id, payload);
      assert.equal(retried.statusCode, 200, retried.body);
      assert.equal(retried.json().proposalId, savedId);
      assert.equal((await proposalStore.get(savedId)).signalProvenance.sourceMessageId, source.id);
      const changed = await propose(later.id, later.id, payload);
      assert.equal(changed.statusCode, 409, changed.body);
      assert.equal(changed.json().error, 'client_request_conflict');
      await messageStore.softDelete(later.id, 'alice');
      const invalidCaller = await propose(source.id, later.id, payload);
      assert.equal(invalidCaller.statusCode, 409, invalidCaller.body);
      assert.equal(invalidCaller.json().error, 'origin_not_eligible');
      await messageStore.softDelete(source.id, 'alice');
      const freshCaller = await appendUserMessage('A later valid caller');
      const withdrawn = await propose(source.id, freshCaller.id, payload);
      assert.equal(withdrawn.statusCode, 409, withdrawn.body);
      assert.equal(withdrawn.json().error, 'origin_not_eligible');
    });
  }

  it('rejects a deleted or foreign origin before reserving or creating a proposal', async () => {
    const deleted = await appendUserMessage('source later withdrawn');
    await messageStore.softDelete(deleted.id, 'alice');
    const foreign = messageStore.append(
      canonicalTestMessageInput({
        userId: 'bob',
        catId: null,
        threadId: 'thread_1',
        content: 'private',
        mentions: [],
        timestamp: Date.now(),
      }),
    );
    const masqueradingSystem = messageStore.append(
      canonicalTestMessageInput({
        userId: 'scheduler',
        catId: 'opus',
        threadId: 'thread_1',
        content: 'not a system wake',
        mentions: [],
        timestamp: Date.now(),
      }),
    );
    for (const source of [deleted, foreign, masqueradingSystem]) {
      const response = await propose(source.id, source.id, { clientRequestId: `origin-${source.id}` });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error, 'origin_not_eligible');
      assert.equal(await proposalStore.getDedupProposalId('alice', `origin-${source.id}`), null);
    }
    assert.deepEqual(await proposalStore.listPending('alice'), []);
  });

  it('keeps the original authenticated origin when a later invocation recovers a staged dedup proposal', async () => {
    const originalOrigin = await appendUserMessage('Original profile request');
    const retryOrigin = await appendUserMessage('Retry from a later invocation');
    const proposalId = 'profile_update_staged_origin';
    await proposalStore.reserveDedup('alice', 'origin-retry', proposalId);
    await proposalStore.create({
      proposalId,
      sourceThreadId: 'thread_1',
      sourceInvocationId: 'inv_original',
      sourceCatId: 'opus',
      targetLayer: 'primer',
      targetPath: 'relationship/ragdoll-primer.md',
      beforeContent: '',
      baseContentHash: 'base-hash',
      afterContent: 'NEW primer',
      rationale: 'Observed preference',
      signalProvenance: {
        kind: 'cat-declared',
        sourceThreadId: 'thread_1',
        sourceMessageId: originalOrigin.id,
      },
      createdBy: 'alice',
    });

    const response = await propose(undefined, retryOrigin.id, { clientRequestId: 'origin-retry' });

    assert.equal(response.statusCode, 200);
    const stored = await proposalStore.get(proposalId);
    assert.equal(stored.publication.state, 'anchored');
    assert.deepEqual(stored.publication.envelope.originRef, {
      kind: 'message',
      threadId: 'thread_1',
      messageId: originalOrigin.id,
    });
    await messageStore.softDelete(originalOrigin.id, 'alice');
    const revokedRetry = await propose(undefined, retryOrigin.id, { clientRequestId: 'origin-retry' });
    assert.equal(revokedRetry.statusCode, 409, 'a fresh invocation cannot restore a withdrawn original source');
    assert.equal(revokedRetry.json().error, 'origin_not_eligible');
  });
});
