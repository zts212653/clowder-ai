import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

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
    return messageStore.append({
      userId: 'alice',
      catId: null,
      content,
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_1',
    });
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

    const response = await propose(retryOrigin.id, retryOrigin.id, { clientRequestId: 'origin-retry' });

    assert.equal(response.statusCode, 200);
    const stored = await proposalStore.get(proposalId);
    assert.equal(stored.publication.state, 'anchored');
    assert.deepEqual(stored.publication.envelope.originRef, {
      kind: 'message',
      threadId: 'thread_1',
      messageId: originalOrigin.id,
    });
  });
});
