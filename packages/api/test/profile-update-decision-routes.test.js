import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

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

  const seedPrimer = (content, catId = 'codex') => {
    writeFileSync(join(profileDir, 'relationship', `${catId}-primer.md`), content, 'utf8');
    return writeMod.hashContent(content);
  };

  const makeProposal = (over = {}) =>
    store.create({
      sourceThreadId: 'thread_1',
      sourceInvocationId: 'inv_1',
      sourceCatId: 'codex',
      targetLayer: 'primer',
      targetPath: join('relationship', 'codex-primer.md'),
      beforeContent: 'OLD',
      baseContentHash: writeMod.hashContent('OLD'),
      afterContent: 'NEW',
      rationale: 'landy likes blue',
      signalProvenance: { kind: 'cat-declared', sourceThreadId: 'thread_1' },
      createdBy: 'alice',
      ...over,
    });

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
    profileDir = mkdtempSync(join(tmpdir(), 'f231-route-'));
    mkdirSync(join(profileDir, 'relationship'), { recursive: true });
    routeMod = await import('../dist/routes/profile-update-decision-routes.js');
    writeMod = await import('../dist/domains/cats/services/profile/writeProfileUpdate.js');
    StoreMod = await import('../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js');
    MutexMod = await import('../dist/domains/cats/services/agents/invocation/SessionMutex.js');

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
      profileDir,
      socketManager,
      clearL0Cache: (catId) => clearedL0.push(catId),
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
    assert.equal(readFileSync(join(profileDir, 'relationship/codex-primer.md'), 'utf8'), 'NEW');
    assert.ok(socketEvents.some((e) => e.event === 'proposal_updated' && e.data.status === 'approved'));
    assert.deepEqual(clearedL0, ['codex']);
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
    assert.equal(readFileSync(join(profileDir, 'relationship/codex-primer.md'), 'utf8'), 'OLD');
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
    assert.equal(readFileSync(join(profileDir, 'relationship/codex-primer.md'), 'utf8'), 'OLD');
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
    assert.equal(readFileSync(join(profileDir, 'relationship/codex-primer.md'), 'utf8'), 'X-WINS');
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
      profileDir,
      socketManager: { emitToUser() {} },
      clearL0Cache: (catId) => clearedL0.push(catId),
      approveProfileUpdate: async () => ({
        ok: false,
        reason: 'write_failed',
        error: 'provenance failed',
        proposal: {
          ...p,
          status: 'approving',
          writtenPath: join(profileDir, 'relationship/codex-primer.md'),
        },
      }),
    });
    await app.ready();

    const res = await approve('alice', p.proposalId);

    assert.equal(res.statusCode, 500);
    assert.deepEqual(clearedL0, ['codex']);
  });

  it('reject happy path → 200 rejected, primer untouched', async () => {
    seedPrimer('OLD');
    const p = makeProposal();
    const res = await reject('alice', p.proposalId, { rejectionReason: 'not now' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'rejected');
    assert.equal(readFileSync(join(profileDir, 'relationship/codex-primer.md'), 'utf8'), 'OLD');
    assert.equal(store.get(p.proposalId).rejectionReason, 'not now');
    assert.ok(socketEvents.some((e) => e.event === 'proposal_updated' && e.data.status === 'rejected'));
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
