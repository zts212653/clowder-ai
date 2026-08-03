import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

// F246 v2: proposal_created socket event regression (cloud review P2).
// Ensures F231 emits the generic proposal_created event that the Approval Hub
// listens for (useApprovalHub → cat-cafe:proposal-created CustomEvent), alongside
// the legacy profile_update_proposal_created event.
describe('F246 v2: proposal_created socket event for F231', () => {
  let profileDir;
  let app;
  let registry;
  let store;
  let messageStore;
  let emitCalls;
  let repository;
  let originByRequest;

  const seedPrimer = (content, catId = 'opus') => {
    const path = repository.primerPath(repository.scope('alice', catId));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  };

  const propose = async ({ userId = 'alice', catId = 'opus', threadId = 'thread_1', body }) => {
    const key = body.clientRequestId ? `${userId}:${catId}:${threadId}:${body.clientRequestId}` : undefined;
    let origin = key ? originByRequest.get(key) : undefined;
    if (!origin) {
      origin = messageStore.append({
        userId,
        catId: null,
        content: 'Please update the profile',
        mentions: [],
        timestamp: Date.now(),
        threadId,
      });
      if (key) originByRequest.set(key, origin);
    }
    const { invocationId, callbackToken } = await registry.create(userId, catId, threadId, undefined, origin.id);
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-profile-update',
      headers: {
        'x-invocation-id': invocationId,
        'x-callback-token': callbackToken,
        'content-type': 'application/json',
      },
      payload: { sourceMessageId: origin.id, ...body },
    });
  };

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f231-socket-'));
    const routeMod = await import('../dist/routes/callback-propose-profile-update-routes.js');
    const RegMod = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
    const StoreMod = await import('../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js');
    const MsgMod = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const authMod = await import('../dist/routes/callback-auth-prehandler.js');
    const RepoMod = await import('../dist/domains/cats/services/profile/ProfileRepository.js');
    repository = new RepoMod.FileProfileRepository({
      dataDir,
      relationshipKeyForCat: (catId) => ({ opus: 'ragdoll' })[catId],
    });
    profileDir = repository.profileDir('alice');

    registry = new RegMod.InvocationRegistry();
    store = new StoreMod.InMemoryProfileUpdateProposalStore();
    messageStore = new MsgMod.MessageStore();
    originByRequest = new Map();
    emitCalls = [];
    const socketManager = {
      emitToUser(userId, event, data) {
        emitCalls.push({ userId, event, data });
      },
      broadcastToRoom() {},
    };
    app = Fastify();
    authMod.registerCallbackAuthHook(app, registry);
    routeMod.registerCallbackProposeProfileUpdateRoutes(app, {
      registry,
      proposalStore: store,
      messageStore,
      socketManager,
      repository,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(profileDir, { recursive: true, force: true });
  });

  it('emits proposal_created alongside profile_update_proposal_created', async () => {
    seedPrimer('OLD primer');
    const res = await propose({
      body: { afterContent: 'NEW', rationale: 'testing socket', signalKind: 'cat-declared' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    const legacy = emitCalls.find((call) => call.event === 'profile_update_proposal_created');
    assert.ok(legacy, 'profile_update_proposal_created event emitted');
    assert.equal(legacy.userId, 'alice');

    const hubEvent = emitCalls.find((call) => call.event === 'proposal_created');
    assert.ok(hubEvent, 'proposal_created event emitted for Approval Hub refresh');
    assert.equal(hubEvent.userId, 'alice');
    assert.equal(hubEvent.data.proposalId, body.proposalId);
    assert.equal(hubEvent.data.status, 'pending');
    assert.equal(hubEvent.data.sourceFeatureId, 'F231');
  });
});
