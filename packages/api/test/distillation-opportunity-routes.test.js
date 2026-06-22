/**
 * F208 Phase E AC-E2: Distillation Opportunity Route Tests
 *
 * Tests the REST API for querying and managing distillation opportunities.
 * All write/read endpoints require authentication (resolveStrictUserId).
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'default-user' };

describe('distillation opportunity routes', () => {
  let app;
  let store;
  let checkpoint;

  // Pin DEFAULT_OWNER_USER_ID so scope enforcement is explicitly tested
  // in multi-user mode. 'default-user' is the operator/owner (sees all).
  const origOwner = process.env.DEFAULT_OWNER_USER_ID;
  before(() => {
    process.env.DEFAULT_OWNER_USER_ID = 'default-user';
  });
  after(() => {
    if (origOwner !== undefined) process.env.DEFAULT_OWNER_USER_ID = origOwner;
    else delete process.env.DEFAULT_OWNER_USER_ID;
  });

  beforeEach(async () => {
    const { InMemoryOpportunityStore, DistillationCheckpoint } = await import(
      '../dist/infrastructure/distillation/DistillationCheckpoint.js'
    );
    const { distillationOpportunityRoutes } = await import('../dist/routes/distillation-opportunities.js');

    store = new InMemoryOpportunityStore();
    checkpoint = new DistillationCheckpoint({
      opportunityStore: store,
      log: { info: () => {}, warn: () => {} },
    });
    app = Fastify();
    await app.register(distillationOpportunityRoutes, { opportunityStore: store });
    await app.ready();
  });

  it('GET returns 401 for unauthenticated browser request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: { origin: 'http://localhost:3000' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST dismiss returns 401 for unauthenticated browser request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillation-opportunities/opp-1/dismiss',
      headers: { origin: 'http://localhost:3000' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('GET returns empty list when no opportunities exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.opportunities, []);
  });

  it('GET returns pending opportunities after checkpoint fires', async () => {
    await checkpoint.onFeatPhaseClose({
      prNumber: 2461,
      repoFullName: 'zts212653/cat-cafe',
      authorCatId: 'opus',
      threadId: 'thread_abc',
      featureId: 'F208',
      phaseLabel: 'E',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.opportunities.length, 1);
    assert.equal(body.opportunities[0].sourceEvent, 'feat-phase-close');
    assert.equal(body.opportunities[0].targetCatId, 'opus');
  });

  it('POST dismiss removes opportunity from pending list', async () => {
    await checkpoint.onReviewComplete({
      prNumber: 100,
      repoFullName: 'r',
      reviewerCatId: 'codex',
      authorCatId: 'opus',
      threadId: 't',
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: AUTH_HEADERS,
    });
    const opp = JSON.parse(listRes.body).opportunities[0];

    const dismissRes = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillation-opportunities/${opp.opportunityId}/dismiss`,
      headers: AUTH_HEADERS,
    });
    assert.equal(dismissRes.statusCode, 200);

    const afterRes = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: AUTH_HEADERS,
    });
    assert.equal(JSON.parse(afterRes.body).opportunities.length, 0);
  });

  it('POST convert marks opportunity as converted with proposalId', async () => {
    await checkpoint.onFeatPhaseClose({
      prNumber: 100,
      repoFullName: 'r',
      authorCatId: 'opus',
      threadId: 't',
      featureId: 'F001',
      phaseLabel: 'A',
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: AUTH_HEADERS,
    });
    const opp = JSON.parse(listRes.body).opportunities[0];

    const convertRes = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillation-opportunities/${opp.opportunityId}/convert`,
      headers: AUTH_HEADERS,
      payload: { proposalId: 'proposal-xyz' },
    });
    assert.equal(convertRes.statusCode, 200);

    const afterRes = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: AUTH_HEADERS,
    });
    assert.equal(JSON.parse(afterRes.body).opportunities.length, 0);
  });

  it('POST convert requires proposalId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillation-opportunities/opp-1/convert',
      headers: AUTH_HEADERS,
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST dismiss on non-existent returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillation-opportunities/nonexistent/dismiss',
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 404);
  });

  // ──────────── Scope enforcement (gpt52 R2 P1 + R4 P1 fix) ────────────
  // DEFAULT_OWNER_USER_ID='default-user' pinned by describe-level before()
  // ensures these tests explicitly verify multi-user scope enforcement.

  it('GET only returns opportunities targeting the calling cat', async () => {
    // feat-phase-close targets author='opus'
    await checkpoint.onFeatPhaseClose({
      prNumber: 100,
      repoFullName: 'r',
      authorCatId: 'opus',
      threadId: 't',
      featureId: 'F001',
      phaseLabel: 'A',
    });
    // review-complete targets author='codex' (reviewer is GitHub login, not used as target)
    await checkpoint.onReviewComplete({
      prNumber: 101,
      repoFullName: 'r',
      reviewerCatId: 'external-gh-login',
      authorCatId: 'codex',
      threadId: 't',
    });

    // 'opus' only sees the feat-phase-close opportunity (targetCatId=opus)
    const opusRes = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const opusOpps = JSON.parse(opusRes.body).opportunities;
    assert.equal(opusOpps.length, 1);
    assert.equal(opusOpps[0].targetCatId, 'opus');
    assert.equal(opusOpps[0].sourceEvent, 'feat-phase-close');

    // 'codex' only sees the review-complete opportunity (targetCatId=codex as PR author)
    const codexRes = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: { 'x-cat-cafe-user': 'codex' },
    });
    const codexOpps = JSON.parse(codexRes.body).opportunities;
    assert.equal(codexOpps.length, 1);
    assert.equal(codexOpps[0].targetCatId, 'codex');
    assert.equal(codexOpps[0].sourceEvent, 'review-complete');
  });

  it('POST dismiss returns 403 when caller is not target cat', async () => {
    await checkpoint.onFeatPhaseClose({
      prNumber: 100,
      repoFullName: 'r',
      authorCatId: 'opus',
      threadId: 't',
      featureId: 'F001',
      phaseLabel: 'A',
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const opp = JSON.parse(listRes.body).opportunities[0];

    // 'codex' tries to dismiss opus's opportunity → 403
    const dismissRes = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillation-opportunities/${opp.opportunityId}/dismiss`,
      headers: { 'x-cat-cafe-user': 'codex' },
    });
    assert.equal(dismissRes.statusCode, 403);
  });

  it('POST convert returns 403 when caller is not target cat', async () => {
    await checkpoint.onFeatPhaseClose({
      prNumber: 100,
      repoFullName: 'r',
      authorCatId: 'opus',
      threadId: 't',
      featureId: 'F001',
      phaseLabel: 'A',
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/dossier/distillation-opportunities',
      headers: { 'x-cat-cafe-user': 'opus' },
    });
    const opp = JSON.parse(listRes.body).opportunities[0];

    // 'codex' tries to convert opus's opportunity → 403
    const convertRes = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillation-opportunities/${opp.opportunityId}/convert`,
      headers: { 'x-cat-cafe-user': 'codex' },
      payload: { proposalId: 'p-123' },
    });
    assert.equal(convertRes.statusCode, 403);
  });
});
