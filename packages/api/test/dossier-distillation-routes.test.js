/**
 * F208 Phase E: Dossier Distillation Routes
 *
 * AC-E1: Proposal CRUD (schema + store behind REST endpoints).
 * AC-E3: operator approve → cat apply lifecycle via routes.
 * KD-16: Independent from F231 profile-update routes.
 * KD-17: evidenceRefs fail-closed, sourceId idempotency.
 * KD-18: v1 no auto-commit — operator approve, cat apply later.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('dossier distillation routes', () => {
  let app;
  let store;
  let _savedOwnerId;

  const baseBody = () => ({
    sourceEvent: 'feat-phase-close',
    sourceId: 'feat-phase-close:F208:D',
    targetCatId: 'opus',
    targetFields: ['nativePeakAbilities', 'blindSpots'],
    beforeSnapshot: '原生峰值: 深度思考',
    afterDraft: '原生峰值: 深度思考 + Redis 架构',
    rationale: 'Phase D 实现展示 Redis 能力',
    evidenceRefs: [{ type: 'review', id: 'review-pr-2457', summary: 'PR review' }],
    baseHash: 'abc123',
  });

  beforeEach(async () => {
    // Isolate from host env: tests run in single-user mode by default
    _savedOwnerId = process.env.DEFAULT_OWNER_USER_ID;
    delete process.env.DEFAULT_OWNER_USER_ID;

    const { InMemoryDossierDistillationProposalStore } = await import(
      '../dist/domains/cats/services/stores/ports/DossierDistillationProposalStore.js'
    );
    const { distillationRoutes } = await import('../dist/routes/dossier-distillations.js');

    store = new InMemoryDossierDistillationProposalStore();
    app = Fastify();
    await app.register(distillationRoutes, { distillationStore: store });
    await app.ready();
  });

  afterEach(() => {
    if (_savedOwnerId !== undefined) process.env.DEFAULT_OWNER_USER_ID = _savedOwnerId;
  });

  // ===== Auth (P0 review fix — resolveStrictUserId) =====

  it('POST 401 if no identity header (unauthenticated)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      // no x-cat-cafe-user header
    });
    assert.equal(res.statusCode, 401);
  });

  it('approve 401 if no identity header', async () => {
    // Create first (authenticated)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/approve`,
      // no header
    });
    assert.equal(res.statusCode, 401);
  });

  it('reject 401 if no identity header', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/reject`,
      payload: { rejectionReason: 'test' },
      // no header
    });
    assert.equal(res.statusCode, 401);
  });

  it('apply 401 if no identity header', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;
    await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': 'you' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/apply`,
      payload: { commitSha: 'abc123' },
      // no header
    });
    assert.equal(res.statusCode, 401);
  });

  // ===== operator owner gate (P0 review fix — resolveOwnerGate) =====

  it('approve 403 if non-operator user tries to approve (owner gate)', async () => {
    const saved = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/dossier/distillations',
        payload: baseBody(),
        headers: { 'x-cat-cafe-user': 'opus' },
      });
      const { proposalId } = JSON.parse(createRes.body).proposal;

      const res = await app.inject({
        method: 'POST',
        url: `/api/dossier/distillations/${proposalId}/approve`,
        headers: { 'x-cat-cafe-user': 'intruder' }, // not operator
      });
      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.body).error, /operator/i);
    } finally {
      if (saved !== undefined) process.env.DEFAULT_OWNER_USER_ID = saved;
      else delete process.env.DEFAULT_OWNER_USER_ID;
    }
  });

  it('reject 403 if non-operator user tries to reject (owner gate)', async () => {
    const saved = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/dossier/distillations',
        payload: baseBody(),
        headers: { 'x-cat-cafe-user': 'opus' },
      });
      const { proposalId } = JSON.parse(createRes.body).proposal;

      const res = await app.inject({
        method: 'POST',
        url: `/api/dossier/distillations/${proposalId}/reject`,
        payload: { rejectionReason: 'test' },
        headers: { 'x-cat-cafe-user': 'intruder' }, // not operator
      });
      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.body).error, /operator/i);
    } finally {
      if (saved !== undefined) process.env.DEFAULT_OWNER_USER_ID = saved;
      else delete process.env.DEFAULT_OWNER_USER_ID;
    }
  });

  // ===== Access control gates (separation of duties + ownership) =====

  it('approve 403 if creator tries to self-approve', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': 'opus' }, // same as creator
    });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /own proposal/i);
  });

  it('reject 403 if creator tries to self-reject', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/reject`,
      payload: { rejectionReason: 'test' },
      headers: { 'x-cat-cafe-user': 'opus' }, // same as creator
    });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /own proposal/i);
  });

  it('apply 403 if non-target cat tries to apply', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(), // targetCatId = 'opus'
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': 'you' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/apply`,
      payload: { commitSha: 'abc123' },
      headers: { 'x-cat-cafe-user': 'intruder' }, // not targetCatId
    });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /target cat/i);
  });

  // ===== POST /api/dossier/distillations =====

  it('POST creates a distillation proposal (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.ok(body.proposal.proposalId);
    assert.equal(body.proposal.status, 'pending');
    assert.equal(body.proposal.targetCatId, 'opus');
  });

  it('POST 400 if evidenceRefs empty (fail-closed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: { ...baseBody(), evidenceRefs: [] },
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /evidence/i);
  });

  it('POST 400 if evidenceRefs contains structurally invalid ref (cloud P2 fix)', async () => {
    // [{}] — missing type and id
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: { ...baseBody(), evidenceRefs: [{}] },
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    assert.equal(res1.statusCode, 400);
    assert.match(JSON.parse(res1.body).error, /type/i);

    // [{type: "review"}] — missing id
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: { ...baseBody(), evidenceRefs: [{ type: 'review' }] },
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    assert.equal(res2.statusCode, 400);
    assert.match(JSON.parse(res2.body).error, /id/i);

    // [{type: "invalid-type", id: "x"}] — invalid type enum
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: { ...baseBody(), evidenceRefs: [{ type: 'bogus', id: 'x' }] },
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    assert.equal(res3.statusCode, 400);
    assert.match(JSON.parse(res3.body).error, /type/i);
  });

  it('POST 400 if required fields missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: { sourceEvent: 'feat-phase-close' }, // missing most fields
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST idempotent — same sourceId returns existing proposal', async () => {
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    assert.equal(res2.statusCode, 200); // 200 not 201 for idempotent hit
    const body1 = JSON.parse(res1.body);
    const body2 = JSON.parse(res2.body);
    assert.equal(body1.proposal.proposalId, body2.proposal.proposalId);
  });

  it('POST idempotent — unauthenticated duplicate gets 401 not 200 (cloud P1 fix)', async () => {
    // First request: authenticated, creates proposal
    await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    // Second request: same sourceId but NO auth header → must get 401
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      // no x-cat-cafe-user header
    });
    assert.equal(res.statusCode, 401);
  });

  // ===== GET /api/dossier/distillations =====

  it('GET lists pending proposals', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillations',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.proposals.length, 1);
  });

  it('GET ?catId=X filters by target cat', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: { ...baseBody(), sourceId: 's2', targetCatId: 'codex' },
      headers: { 'x-cat-cafe-user': 'codex' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillations?catId=opus',
    });
    const body = JSON.parse(res.body);
    assert.equal(body.proposals.length, 1);
    assert.equal(body.proposals[0].targetCatId, 'opus');
  });

  // ===== GET /api/dossier/distillations/:proposalId =====

  it('GET /:proposalId returns specific proposal', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    const res = await app.inject({
      method: 'GET',
      url: `/api/dossier/distillations/${proposalId}`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.proposal.proposalId, proposalId);
  });

  it('GET /:proposalId 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillations/proposal_nonexistent',
    });
    assert.equal(res.statusCode, 404);
  });

  // ===== POST /api/dossier/distillations/:id/approve =====

  it('approve transitions pending → approved (operator only)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': 'you' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.proposal.status, 'approved');
    assert.equal(body.proposal.approvedBy, 'you');
  });

  it('approve 409 if not pending', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    // approve first time
    await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': 'you' },
    });
    // approve second time — already approved
    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': 'you' },
    });
    assert.equal(res.statusCode, 409);
  });

  // ===== POST /api/dossier/distillations/:id/reject =====

  it('reject transitions pending → rejected', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/reject`,
      payload: { rejectionReason: 'evidence insufficient' },
      headers: { 'x-cat-cafe-user': 'you' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.proposal.status, 'rejected');
    assert.equal(body.proposal.rejectionReason, 'evidence insufficient');
  });

  // ===== POST /api/dossier/distillations/:id/apply =====

  it('apply transitions approved → applied with commitSha', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    // approve first
    await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': 'you' },
    });

    // apply
    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/apply`,
      payload: { commitSha: 'abc123def456' },
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.proposal.status, 'applied');
    assert.equal(body.proposal.appliedBy, 'opus');
    assert.equal(body.proposal.appliedCommitSha, 'abc123def456');
  });

  it('apply 409 if not approved', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    // try to apply without approve
    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/apply`,
      payload: { commitSha: 'abc123' },
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('apply 400 if commitSha missing', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations',
      payload: baseBody(),
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const { proposalId } = JSON.parse(createRes.body).proposal;

    await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': 'you' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposalId}/apply`,
      payload: {},
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    assert.equal(res.statusCode, 400);
  });
});
