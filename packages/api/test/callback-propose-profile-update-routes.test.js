import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

// F231 Phase C Task3: cat-side propose-profile-update callback route.
// Pins the current primer as beforeContent + baseContentHash (P1-2 optimistic-lock base),
// derives targetPath from the authenticated cat (no user-supplied path → no escape),
// enforces INV-6 (primer only), and appends the confirmation card.
describe('callback propose-profile-update route', () => {
  let profileDir;
  let app;
  let registry;
  let store;
  let messageStore;
  let writeMod;
  let repository;
  let originByRequest;

  const seedPrimer = (content, catId = 'opus', userId = 'alice') => {
    const path = repository.primerPath(repository.scope(userId, catId));
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
    const dataDir = mkdtempSync(join(tmpdir(), 'f231-propose-'));
    const routeMod = await import('../dist/routes/callback-propose-profile-update-routes.js');
    const RegMod = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
    const StoreMod = await import('../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js');
    const MsgMod = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const authMod = await import('../dist/routes/callback-auth-prehandler.js');
    writeMod = await import('../dist/domains/cats/services/profile/writeProfileUpdate.js');
    const RepoMod = await import('../dist/domains/cats/services/profile/ProfileRepository.js');
    repository = new RepoMod.FileProfileRepository({
      dataDir,
      relationshipKeyForCat: (catId) => ({ opus: 'ragdoll', 'codex-sol': 'maine-coon' })[catId],
    });
    profileDir = repository.profileDir('alice');

    registry = new RegMod.InvocationRegistry();
    store = new StoreMod.InMemoryProfileUpdateProposalStore();
    messageStore = new MsgMod.MessageStore();
    originByRequest = new Map();
    const socketManager = { emitToUser() {}, broadcastToRoom() {} };
    app = Fastify();
    authMod.registerCallbackAuthHook(app, registry); // sets request.callbackAuth (proposal-test-harness gets this via full callbacksRoutes)
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

  it('happy path: pins current primer as beforeContent + baseContentHash, creates pending + card', async () => {
    seedPrimer('OLD primer');
    const res = await propose({
      body: { afterContent: 'NEW primer', rationale: 'landy likes blue', signalKind: 'cat-declared' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'pending');
    const proposal = store.get(body.proposalId);
    assert.equal(proposal.beforeContent, 'OLD primer');
    assert.equal(proposal.baseContentHash, writeMod.hashContent('OLD primer'));
    assert.equal(proposal.afterContent, 'NEW primer');
    assert.equal(proposal.targetPath, 'relationship/ragdoll-primer.md');
    assert.equal(proposal.targetLayer, 'primer');
    assert.equal(proposal.sourceCatId, 'opus');
    assert.equal(proposal.signalProvenance.kind, 'cat-declared');
    assert.ok(proposal.cardMessageId, 'card appended + marker set');
    const msgs = await messageStore.getByThread('thread_1', 50);
    assert.ok(
      msgs.some((m) => (m.extra?.rich?.blocks ?? []).some((b) => b.id === `profile-update-${body.proposalId}`)),
      'confirmation card present in source thread',
    );
  });

  it('absent primer → beforeContent empty, baseContentHash = hash("")', async () => {
    const res = await propose({ body: { afterContent: 'FIRST', rationale: 'init', signalKind: 'cat-declared' } });
    assert.equal(res.statusCode, 200);
    const proposal = store.get(JSON.parse(res.body).proposalId);
    assert.equal(proposal.beforeContent, '');
    assert.equal(proposal.baseContentHash, writeMod.hashContent(''));
  });

  it('projects a new model catId onto its stable relationship persona', async () => {
    seedPrimer('SOL FAMILY OLD', 'codex-sol');
    const res = await propose({
      catId: 'codex-sol',
      body: { afterContent: 'SOL FAMILY NEW', rationale: 'same persona', signalKind: 'cat-declared' },
    });
    assert.equal(res.statusCode, 200);
    const proposal = store.get(JSON.parse(res.body).proposalId);
    assert.equal(proposal.targetPath, 'relationship/maine-coon-primer.md');
    assert.equal(proposal.beforeContent, 'SOL FAMILY OLD');
  });

  it('INV-6: targetLayer capsule rejected (400 — AC-C1 primer only)', async () => {
    seedPrimer('OLD');
    const res = await propose({
      body: { afterContent: 'X', rationale: 'r', signalKind: 'cat-declared', targetLayer: 'capsule' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('stale invocation → stale_ignored (no proposal created)', async () => {
    seedPrimer('OLD');
    const first = await registry.create('alice', 'opus', 'thread_1');
    await registry.create('alice', 'opus', 'thread_1'); // supersede first
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-profile-update',
      headers: {
        'x-invocation-id': first.invocationId,
        'x-callback-token': first.callbackToken,
        'content-type': 'application/json',
      },
      payload: {
        afterContent: 'X',
        rationale: 'r',
        signalKind: 'cat-declared',
        sourceMessageId: 'unused-for-stale-invocation',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'stale_ignored');
  });

  it('idempotent on clientRequestId (same proposalId, deduped)', async () => {
    seedPrimer('OLD');
    const body = { afterContent: 'X', rationale: 'r', signalKind: 'cat-declared', clientRequestId: 'req-1' };
    const r1 = await propose({ body });
    const r2 = await propose({ body });
    assert.equal(JSON.parse(r1.body).proposalId, JSON.parse(r2.body).proposalId);
    assert.equal(JSON.parse(r2.body).deduped, true);
  });

  it('dedup retry recovers a staged proposal by publishing and anchoring its card', async () => {
    seedPrimer('OLD');
    const existingProposalId = 'profile_update_pending_no_card';
    store.reserveDedup('alice', 'req-invisible', existingProposalId);
    store.create({
      proposalId: existingProposalId,
      sourceThreadId: 'thread_1',
      sourceInvocationId: 'inv_1',
      sourceCatId: 'opus',
      targetLayer: 'primer',
      targetPath: 'relationship/ragdoll-primer.md',
      beforeContent: 'OLD',
      baseContentHash: writeMod.hashContent('OLD'),
      afterContent: 'X',
      rationale: 'r',
      signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1' },
      createdBy: 'alice',
    });

    const res = await propose({
      body: { afterContent: 'X', rationale: 'r', signalKind: 'cat-declared', clientRequestId: 'req-invisible' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.proposalId, existingProposalId);
    assert.equal(body.deduped, true);
    assert.ok(body.messageId);
    assert.equal(store.get(existingProposalId).publication.state, 'anchored');
  });

  it('dedup self-heals a visible card even after more than 500 newer messages', async () => {
    seedPrimer('OLD');
    const existingProposalId = 'profile_update_old_visible_card';
    store.reserveDedup('alice', 'req-old-visible', existingProposalId);
    store.create({
      proposalId: existingProposalId,
      sourceThreadId: 'thread_1',
      sourceInvocationId: 'inv_1',
      sourceCatId: 'opus',
      targetLayer: 'primer',
      targetPath: 'relationship/ragdoll-primer.md',
      beforeContent: 'OLD',
      baseContentHash: writeMod.hashContent('OLD'),
      afterContent: 'X',
      rationale: 'r',
      signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1' },
      createdBy: 'alice',
    });
    const cardMessage = await messageStore.append({
      userId: 'alice',
      catId: 'opus',
      content: 'visible profile update card',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_1',
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: `profile-update-${existingProposalId}`, kind: 'card', v: 1, title: 'Profile update' }],
        },
      },
    });
    for (let i = 0; i < 600; i += 1) {
      await messageStore.append({
        userId: 'alice',
        catId: null,
        content: `newer ${i}`,
        mentions: [],
        timestamp: Date.now() + i + 1,
        threadId: 'thread_1',
      });
    }

    const res = await propose({
      body: { afterContent: 'X', rationale: 'r', signalKind: 'cat-declared', clientRequestId: 'req-old-visible' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.proposalId, existingProposalId);
    assert.equal(body.deduped, true);
    assert.equal(store.get(existingProposalId).cardMessageId, cardMessage.id);
  });
});
