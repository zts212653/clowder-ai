import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { anchorApproval } from './approval-hub/helpers.js';

// F231 Phase C Task3: profile-update decision routes (user-auth approve/reject HTTP adapter
// over the approveProfileUpdate service). Verifies HTTP status mapping + ownership + the
// optimistic-lock stale path surfaced as 409.
describe('profile-update decision routes (approve / reject)', () => {
  let profileDir;
  let routeMod;
  let writeMod;
  let StoreMod;
  let MutexMod;
  let app;
  let store;
  let socketEvents;
  let clearedL0;
  let repository;

  const seedPrimer = (content, relationshipKey = 'maine-coon') => {
    writeFileSync(join(profileDir, 'relationship', `${relationshipKey}-primer.md`), content, 'utf8');
    return writeMod.hashContent(content);
  };

  const makeProposal = (over = {}, { anchored = true } = {}) => {
    const proposal = store.create({
      sourceThreadId: 'thread_1',
      sourceInvocationId: 'inv_1',
      sourceCatId: 'codex',
      targetLayer: 'primer',
      targetPath: 'relationship/maine-coon-primer.md',
      beforeContent: 'OLD',
      baseContentHash: writeMod.hashContent('OLD'),
      afterContent: 'NEW',
      rationale: 'landy likes blue',
      signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1' },
      createdBy: 'alice',
      ...over,
    });
    if (anchored) {
      anchorApproval(store, {
        proposalId: proposal.proposalId,
        sourceFeatureId: 'F231',
        ownerUserId: proposal.createdBy,
        requesterCatId: proposal.sourceCatId,
        threadId: proposal.sourceThreadId,
        createdAt: proposal.createdAt,
      });
    }
    return proposal;
  };

  const approve = (userId, proposalId) =>
    app.inject({
      method: 'POST',
      url: `/api/profile-updates/${proposalId}/approve`,
      headers: userId
        ? { 'x-cat-cafe-user': userId, 'content-type': 'application/json' }
        : { 'content-type': 'application/json' },
      payload: {},
    });

  const reject = (userId, proposalId, body = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/profile-updates/${proposalId}/reject`,
      headers: { 'x-cat-cafe-user': userId, 'content-type': 'application/json' },
      payload: body,
    });

  const getProposal = (userId, proposalId) =>
    app.inject({
      method: 'GET',
      url: `/api/profile-updates/${proposalId}`,
      headers: userId ? { 'x-cat-cafe-user': userId } : {},
    });

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'f231-route-'));
    routeMod = await import('../dist/routes/profile-update-decision-routes.js');
    writeMod = await import('../dist/domains/cats/services/profile/writeProfileUpdate.js');
    StoreMod = await import('../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js');
    MutexMod = await import('../dist/domains/cats/services/agents/invocation/SessionMutex.js');
    const RepoMod = await import('../dist/domains/cats/services/profile/ProfileRepository.js');
    repository = new RepoMod.FileProfileRepository({
      dataDir,
      relationshipKeyForCat: (catId) => ({ codex: 'maine-coon' })[catId],
    });
    profileDir = repository.profileDir('alice');
    mkdirSync(join(profileDir, 'relationship'), { recursive: true });

    store = new StoreMod.InMemoryProfileUpdateProposalStore();
    socketEvents = [];
    clearedL0 = [];
    const socketManager = {
      emitToUser(userId, event, data) {
        socketEvents.push({ userId, event, data });
      },
    };
    app = Fastify();
    routeMod.registerProfileUpdateDecisionRoutes(app, {
      store,
      lock: new MutexMod.SessionMutex(),
      repository,
      socketManager,
      clearL0Cache: (catId, userId) => clearedL0.push({ catId, userId }),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(profileDir, { recursive: true, force: true });
  });

  it('approve happy path → 200 approved, primer written', async () => {
    seedPrimer('OLD');
    const p = makeProposal();
    const res = await approve('alice', p.proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'approved');
    assert.equal(readFileSync(join(profileDir, 'relationship/maine-coon-primer.md'), 'utf8'), 'NEW');
    assert.ok(socketEvents.some((e) => e.event === 'proposal_updated' && e.data.status === 'approved'));
    assert.deepEqual(clearedL0, [{ catId: 'codex', userId: 'alice' }]);
  });

  it('GET returns current proposal status for owned profile-update cards', async () => {
    seedPrimer('OLD');
    const p = makeProposal();
    await approve('alice', p.proposalId);

    const res = await getProposal('alice', p.proposalId);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.proposalId, p.proposalId);
    assert.equal(body.status, 'approved');
  });

  it('approve unknown proposal → 404', async () => {
    const res = await approve('alice', 'nope');
    assert.equal(res.statusCode, 404);
  });

  it('approve by non-owner → 403', async () => {
    seedPrimer('OLD');
    const p = makeProposal();
    const res = await approve('bob', p.proposalId);
    assert.equal(res.statusCode, 403);
    assert.equal(readFileSync(join(profileDir, 'relationship/maine-coon-primer.md'), 'utf8'), 'OLD');
  });

  it('approve without identity → 401', async () => {
    seedPrimer('OLD');
    const p = makeProposal();
    const res = await approve(null, p.proposalId);
    assert.equal(res.statusCode, 401);
  });

  it('approve rejects trusted-origin browser request without session (no default-user fallback)', async () => {
    seedPrimer('OLD');
    const p = makeProposal({ createdBy: 'default-user' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/profile-updates/${p.proposalId}/approve`,
      headers: {
        origin: 'http://localhost:3003',
        'content-type': 'application/json',
      },
      payload: {},
    });

    assert.equal(res.statusCode, 401);
    assert.equal(readFileSync(join(profileDir, 'relationship/maine-coon-primer.md'), 'utf8'), 'OLD');
    assert.equal(store.get(p.proposalId).status, 'pending');
  });

  it('approve already-rejected → 409', async () => {
    seedPrimer('OLD');
    const p = makeProposal();
    store.markRejected(p.proposalId, 'alice', 'no');
    const res = await approve('alice', p.proposalId);
    assert.equal(res.statusCode, 409);
  });

  it('approve 2nd proposal on same primer → 409 stale (optimistic lock, no overwrite)', async () => {
    seedPrimer('OLD');
    const x = makeProposal({ afterContent: 'X-WINS' });
    const y = makeProposal({ afterContent: 'Y-LOSES' });
    const rx = await approve('alice', x.proposalId);
    const ry = await approve('alice', y.proposalId);
    assert.equal(rx.statusCode, 200);
    assert.equal(ry.statusCode, 409);
    assert.equal(readFileSync(join(profileDir, 'relationship/maine-coon-primer.md'), 'utf8'), 'X-WINS');
    assert.equal(store.get(y.proposalId).status, 'pending'); // rolled back
  });

  it('P2: clears L0 cache when a partial primer commit later fails', async () => {
    seedPrimer('OLD');
    const p = makeProposal();
    await app.close();
    app = Fastify();
    clearedL0 = [];
    routeMod.registerProfileUpdateDecisionRoutes(app, {
      store,
      lock: new MutexMod.SessionMutex(),
      repository,
      socketManager: { emitToUser() {} },
      clearL0Cache: (catId, userId) => clearedL0.push({ catId, userId }),
      approveProfileUpdate: async () => ({
        ok: false,
        reason: 'write_failed',
        error: 'provenance failed',
        proposal: {
          ...p,
          status: 'approving',
          writtenPath: join(profileDir, 'relationship/maine-coon-primer.md'),
        },
      }),
    });
    await app.ready();

    const res = await approve('alice', p.proposalId);

    assert.equal(res.statusCode, 500);
    assert.deepEqual(clearedL0, [{ catId: 'codex', userId: 'alice' }]);
  });

  it('reject happy path → 200 rejected, primer untouched', async () => {
    seedPrimer('OLD');
    const p = makeProposal();
    const res = await reject('alice', p.proposalId, { rejectionReason: 'not now' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'rejected');
    assert.equal(readFileSync(join(profileDir, 'relationship/maine-coon-primer.md'), 'utf8'), 'OLD');
    assert.equal(store.get(p.proposalId).rejectionReason, 'not now');
    assert.ok(socketEvents.some((e) => e.event === 'proposal_updated' && e.data.status === 'rejected'));
  });

  it('staged publication blocks approve and reject before primer or proposal mutation', async () => {
    seedPrimer('OLD');
    const approveProposal = makeProposal({}, { anchored: false });
    const rejectProposal = makeProposal({}, { anchored: false });

    assert.equal((await approve('alice', approveProposal.proposalId)).statusCode, 409);
    assert.equal((await reject('alice', rejectProposal.proposalId)).statusCode, 409);
    assert.equal(readFileSync(join(profileDir, 'relationship/maine-coon-primer.md'), 'utf8'), 'OLD');
    assert.equal(store.get(approveProposal.proposalId).status, 'pending');
    assert.equal(store.get(rejectProposal.proposalId).status, 'pending');
  });

  it('reject already-approved → 409', async () => {
    seedPrimer('OLD');
    const p = makeProposal();
    await approve('alice', p.proposalId);
    const res = await reject('alice', p.proposalId);
    assert.equal(res.statusCode, 409);
  });

  it('reject by non-owner → 403', async () => {
    seedPrimer('OLD');
    const p = makeProposal();
    const res = await reject('bob', p.proposalId);
    assert.equal(res.statusCode, 403);
  });

  it('reject rejects trusted-origin browser request without session (no default-user fallback)', async () => {
    seedPrimer('OLD');
    const p = makeProposal({ createdBy: 'default-user' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/profile-updates/${p.proposalId}/reject`,
      headers: {
        origin: 'http://localhost:3003',
        'content-type': 'application/json',
      },
      payload: {},
    });

    assert.equal(res.statusCode, 401);
    assert.equal(store.get(p.proposalId).status, 'pending');
  });
});
