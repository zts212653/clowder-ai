import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

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

  const seedOrigin = (clientRequestId) => {
    const origin = messageStore.append(
      canonicalTestMessageInput({
        userId: 'alice',
        catId: null,
        threadId: 'thread_1',
        content: 'Please update the profile',
        mentions: [],
        timestamp: Date.now(),
      }),
    );
    originByRequest.set(`alice:opus:thread_1:${clientRequestId}`, origin);
    return origin.id;
  };

  const propose = async ({ userId = 'alice', catId = 'opus', threadId = 'thread_1', body }) => {
    const key = body.clientRequestId ? `${userId}:${catId}:${threadId}:${body.clientRequestId}` : undefined;
    let origin = key ? originByRequest.get(key) : undefined;
    if (!origin) {
      origin = messageStore.append(
        canonicalTestMessageInput({
          userId,
          catId: null,
          content: 'Please update the profile',
          mentions: [],
          timestamp: Date.now(),
          threadId,
        }),
      );
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
      body: { afterContent: 'NEW primer', rationale: 'operator likes blue', signalKind: 'cat-declared' },
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

  it('capsule proposal pins the owner-wide target without writing content', async () => {
    seedPrimer('OLD');
    const res = await propose({
      body: { afterContent: 'X', rationale: 'r', signalKind: 'cat-declared', targetLayer: 'capsule' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(store.get(body.proposalId).targetPath, 'capsule.md');
    assert.equal(repository.readCapsule('alice'), null);
  });

  it('replaced invocation → typed auth failure (no proposal created)', async () => {
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
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).reason, 'replaced');
  });

  it('idempotent on clientRequestId (same proposalId, deduped)', async () => {
    seedPrimer('OLD');
    const body = { afterContent: 'X', rationale: 'r', signalKind: 'cat-declared', clientRequestId: 'req-1' };
    const r1 = await propose({ body });
    const r2 = await propose({ body });
    assert.equal(JSON.parse(r1.body).proposalId, JSON.parse(r2.body).proposalId);
    assert.equal(JSON.parse(r2.body).deduped, true);
  });

  it('rejects a draft based on an older profile revision before reserving or publishing', async () => {
    seedPrimer('new facts added by the owner');
    const res = await propose({
      body: {
        afterContent: 'draft based on old facts',
        rationale: 'update',
        signalKind: 'cat-declared',
        clientRequestId: 'stale-draft',
        expectedRevision: `sha256:${writeMod.hashContent('old facts')}`,
      },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'profile_revision_changed');
    assert.equal(store.getDedupProposalId('alice', 'stale-draft'), null);
    assert.equal(store.listPending('alice').length, 0);
    assert.equal((await messageStore.getByThread('thread_1', 50)).length, 1, 'only the source exists');
  });

  it('checks the revision of the selected layer, including an absent layer', async () => {
    seedPrimer('primer must not supply the corpus revision');
    for (const targetLayer of ['corpus', 'capsule']) {
      const body = {
        targetLayer,
        afterContent: 'first owner facts',
        rationale: 'update',
        signalKind: 'cat-declared',
        expectedRevision: `sha256:${writeMod.hashContent('')}`,
        clientRequestId: `first-${targetLayer}`,
      };
      const res = await propose({ body });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(store.get(res.json().proposalId).baseContentHash, writeMod.hashContent(''));
      const mismatch = await propose({
        body: { ...body, clientRequestId: `bad-${targetLayer}`, expectedRevision: `sha256:${'0'.repeat(64)}` },
      });
      assert.equal(mismatch.statusCode, 409, targetLayer);
    }
  });

  it('recovers the same request before checking a newer current revision', async () => {
    seedPrimer('original');
    const body = {
      afterContent: 'draft',
      rationale: 'update',
      signalKind: 'cat-declared',
      clientRequestId: 'same-draft',
      expectedRevision: `sha256:${writeMod.hashContent('original')}`,
    };
    const first = await propose({ body });
    seedPrimer('owner changed the profile after this proposal');
    const retry = await propose({ body });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().proposalId, first.json().proposalId);
    assert.equal(store.listPending('alice').length, 1);
  });

  it('recovers a committed proposal after the create response was lost', async () => {
    const body = {
      afterContent: 'draft',
      rationale: 'r',
      signalKind: 'cat-declared',
      clientRequestId: 'lost-create-response',
    };
    const originalCreate = store.create.bind(store);
    store.create = (input) => {
      originalCreate(input);
      throw new Error('connection lost after commit');
    };
    const unknown = await propose({ body });
    assert.equal(unknown.statusCode, 500);
    store.create = originalCreate;
    const [committed] = store.listPending('alice');
    const retry = await propose({ body });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().proposalId, committed.proposalId);
    assert.equal(store.listPending('alice').length, 1);
  });

  it('releases an aborted staged recovery so the same request can succeed after card storage recovers', async () => {
    const body = {
      afterContent: 'draft',
      rationale: 'r',
      signalKind: 'cat-declared',
      clientRequestId: 'recovery-abort',
    };
    const originalCreate = store.create.bind(store);
    store.create = (input) => {
      originalCreate(input);
      throw new Error('create response lost');
    };
    assert.equal((await propose({ body })).statusCode, 500);
    store.create = originalCreate;
    const [aborted] = store.listPending('alice');
    const originalAppend = messageStore.append.bind(messageStore);
    messageStore.append = () => {
      throw new Error('card storage unavailable');
    };
    assert.equal((await propose({ body })).statusCode, 500);
    assert.equal(store.get(aborted.proposalId), null, 'ingress aborted the staged proposal without a visible card');
    assert.equal(
      store.getDedupProposalId('alice', body.clientRequestId),
      null,
      'confirmed abort releases its durable binding',
    );
    messageStore.append = originalAppend;
    const recovered = await propose({ body });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.notEqual(recovered.json().proposalId, aborted.proposalId);
    assert.equal(store.listPending('alice').length, 1);
  });

  it('rejects reuse of a request key with changed content, target, or expected revision', async () => {
    seedPrimer('original');
    const body = {
      afterContent: 'draft',
      rationale: 'update',
      signalKind: 'cat-declared',
      clientRequestId: 'bound-draft',
      expectedRevision: `sha256:${writeMod.hashContent('original')}`,
    };
    assert.equal((await propose({ body })).statusCode, 200);
    for (const delta of [
      { afterContent: 'different draft' },
      { rationale: 'different reason' },
      { signalKind: 'cvo-instructed' },
      { targetLayer: 'corpus' },
      { expectedRevision: `sha256:${'0'.repeat(64)}` },
    ]) {
      const retry = await propose({ body: { ...body, ...delta } });
      assert.equal(retry.statusCode, 409, JSON.stringify(delta));
      assert.equal(retry.json().error, 'client_request_conflict');
    }
    assert.equal(store.listPending('alice').length, 1);
  });

  it('revalidates the origin before returning a cached proposal', async () => {
    seedPrimer('original');
    const body = {
      afterContent: 'draft',
      rationale: 'r',
      signalKind: 'cat-declared',
      clientRequestId: 'deleted-source',
    };
    const first = await propose({ body });
    const source = store.get(first.json().proposalId).signalProvenance.sourceMessageId;
    await messageStore.softDelete(source, 'alice');
    const retry = await propose({ body });
    assert.equal(retry.statusCode, 409);
    assert.equal(retry.json().error, 'origin_not_eligible');
    assert.equal(store.listPending('alice').length, 1);
  });

  it('rejects an altered concurrent loser instead of returning the winning payload as its success', async () => {
    const body = { afterContent: 'winner', rationale: 'r', signalKind: 'cat-declared', clientRequestId: 'race' };
    const first = await propose({ body });
    const originalLookup = store.getDedupProposalId.bind(store);
    store.getDedupProposalId = () => null; // first lookup raced with the winner's create
    const loser = await propose({ body: { ...body, afterContent: 'loser' } });
    store.getDedupProposalId = originalLookup;
    assert.equal(loser.statusCode, 409);
    assert.equal(loser.json().error, 'client_request_conflict');
    assert.equal(store.get(first.json().proposalId).afterContent, 'winner');
    assert.equal(store.listPending('alice').length, 1);
  });

  it('does not publish a legacy staged proposal lacking its original source binding', async () => {
    store.reserveDedup('alice', 'legacy', 'legacy-proposal');
    store.create({
      proposalId: 'legacy-proposal',
      sourceThreadId: 'thread_1',
      sourceInvocationId: 'old',
      sourceCatId: 'opus',
      targetLayer: 'primer',
      targetPath: 'relationship/ragdoll-primer.md',
      beforeContent: '',
      baseContentHash: writeMod.hashContent(''),
      afterContent: 'draft',
      rationale: 'r',
      createdBy: 'alice',
      signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1' },
    });
    const res = await propose({
      body: { afterContent: 'draft', rationale: 'r', signalKind: 'cat-declared', clientRequestId: 'legacy' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(store.get('legacy-proposal').publication.state, 'staged');
    assert.equal((await messageStore.getByThread('thread_1', 50)).length, 1);
  });

  it('dedup retry recovers a staged proposal by publishing and anchoring its card', async () => {
    seedPrimer('OLD');
    const sourceMessageId = seedOrigin('req-invisible');
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
      signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1', sourceMessageId },
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
    const sourceMessageId = seedOrigin('req-old-visible');
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
      signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1', sourceMessageId },
      createdBy: 'alice',
    });
    const cardMessage = await messageStore.append(
      canonicalTestMessageInput({
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
      }),
    );
    for (let i = 0; i < 600; i += 1) {
      await messageStore.append(
        canonicalTestMessageInput({
          userId: 'alice',
          catId: null,
          content: `newer ${i}`,
          mentions: [],
          timestamp: Date.now() + i + 1,
          threadId: 'thread_1',
        }),
      );
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

  // --- T5: Phase E corpus propose ---

  it('targetLayer corpus: derives targetPath from PROFILE_CORPUS_RELATIVE_PATH, reads corpus beforeContent', async () => {
    // Seed a corpus file
    mkdirSync(join(profileDir, 'corpus'), { recursive: true });
    writeFileSync(join(profileDir, 'corpus', 'shared-facts.md'), 'old fact', 'utf8');

    const res = await propose({
      body: {
        afterContent: 'new fact',
        rationale: 'operator told us',
        signalKind: 'cvo-instructed',
        targetLayer: 'corpus',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'pending');
    const proposal = store.get(body.proposalId);
    assert.equal(proposal.targetLayer, 'corpus');
    assert.equal(proposal.targetPath, 'corpus/shared-facts.md');
    assert.equal(proposal.beforeContent, 'old fact');
    assert.equal(proposal.baseContentHash, writeMod.hashContent('old fact'));
  });

  it('targetLayer corpus: absent corpus → beforeContent empty', async () => {
    const res = await propose({
      body: {
        afterContent: 'first fact',
        rationale: 'init',
        signalKind: 'cat-declared',
        targetLayer: 'corpus',
      },
    });
    assert.equal(res.statusCode, 200);
    const proposal = store.get(JSON.parse(res.body).proposalId);
    assert.equal(proposal.beforeContent, '');
    assert.equal(proposal.baseContentHash, writeMod.hashContent(''));
  });

  it('oversized capsule is rejected before any approval is created', async () => {
    const res = await propose({
      body: { afterContent: 'X'.repeat(301), rationale: 'r', signalKind: 'cat-declared', targetLayer: 'capsule' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'invalid_content', 'typed error for capsule length');
  });

  it('unknown targetLayer → 400 with typed error', async () => {
    const res = await propose({
      body: { afterContent: 'X', rationale: 'r', signalKind: 'cat-declared', targetLayer: 'wormhole' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'invalid_target_layer', 'typed error for unknown layer');
    assert.ok(body.detail, 'detail present');
  });

  it('dedup retry bypasses target read failure (P1 idempotency guard)', async () => {
    // A successful first proposal with clientRequestId should be retrievable even
    // when the corpus repository becomes temporarily unavailable on retry.
    mkdirSync(join(profileDir, 'corpus'), { recursive: true });
    writeFileSync(join(profileDir, 'corpus', 'shared-facts.md'), 'stable fact', 'utf8');

    const body = {
      afterContent: 'updated fact',
      rationale: 'idempotency test',
      signalKind: 'cat-declared',
      targetLayer: 'corpus',
      clientRequestId: 'req-durable',
    };

    const r1 = await propose({ body });
    assert.equal(r1.statusCode, 200, 'first call succeeds');
    const firstProposalId = JSON.parse(r1.body).proposalId;

    // Break the corpus repository — simulates transient disk/storage failure
    const origReadCorpus = repository.readCorpus;
    repository.readCorpus = () => {
      throw new Error('disk gone');
    };
    try {
      // Retry with same clientRequestId — dedup should short-circuit before target read
      const r2 = await propose({ body });
      assert.equal(r2.statusCode, 200, 'retry succeeds via dedup despite broken repository');
      const retryBody = JSON.parse(r2.body);
      assert.equal(retryBody.proposalId, firstProposalId, 'returns same proposal');
      assert.equal(retryBody.deduped, true, 'marked as deduped');
    } finally {
      repository.readCorpus = origReadCorpus;
    }
  });

  it('corpus repository error returns 503 corpus_target_unavailable', async () => {
    // Monkeypatch readCorpus to throw (simulating disk I/O or missing repo)
    const origReadCorpus = repository.readCorpus;
    repository.readCorpus = () => {
      throw new Error('disk I/O');
    };
    try {
      const res = await propose({
        body: { afterContent: 'new fact', rationale: 'r', signalKind: 'cat-declared', targetLayer: 'corpus' },
      });
      assert.equal(res.statusCode, 503, 'returns 503 on corpus repository error');
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'corpus_target_unavailable', 'typed error for unavailable corpus');
      assert.ok(body.detail, 'detail message present');
    } finally {
      repository.readCorpus = origReadCorpus;
    }
  });
});
