// @ts-check

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const H = { 'x-cat-cafe-user': 'user1' };

describe('External Project Routes', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;

  beforeEach(async () => {
    const { ExternalProjectStore } = await import('../dist/domains/projects/external-project-store.js');
    const { IntentCardStore } = await import('../dist/domains/projects/intent-card-store.js');
    const { NeedAuditFrameStore } = await import('../dist/domains/projects/need-audit-frame-store.js');
    const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');
    const { externalProjectRoutes } = await import('../dist/routes/external-projects.js');
    const { intentCardRoutes } = await import('../dist/routes/intent-card-routes.js');

    const externalProjectStore = new ExternalProjectStore();
    app = Fastify();
    await app.register(externalProjectRoutes, {
      externalProjectStore,
      needAuditFrameStore: new NeedAuditFrameStore(),
      backlogStore: new BacklogStore(),
    });
    await app.register(intentCardRoutes, {
      externalProjectStore,
      intentCardStore: new IntentCardStore(),
    });
  });

  // --- External Project CRUD ---

  test('POST /api/external-projects creates project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: {
        name: 'studio-flow',
        description: 'Freelance project',
        sourcePath: '/tmp/studio-flow',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.project.id.startsWith('ep-'));
    assert.equal(body.project.name, 'studio-flow');
    assert.equal(body.project.backlogPath, 'docs/ROADMAP.md');
  });

  test('POST /api/external-projects rejects missing sourcePath', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'test' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('GET /api/external-projects lists projects', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'a', description: '', sourcePath: '/a' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/external-projects',
      headers: H,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().projects.length, 1);
  });

  test('GET /api/external-projects/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/external-projects/nonexistent',
      headers: H,
    });
    assert.equal(res.statusCode, 404);
  });

  test('DELETE /api/external-projects/:id removes project', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'del', description: '', sourcePath: '/del' },
    });
    const id = createRes.json().project.id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${id}`,
      headers: H,
    });
    assert.equal(delRes.statusCode, 204);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${id}`,
      headers: H,
    });
    assert.equal(getRes.statusCode, 404);
  });

  // --- Intent Card routes ---

  test('POST intent-cards creates card', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: {
        actor: 'Admin',
        goal: 'Approve orders',
        originalText: 'Admin approves orders',
        sourceTag: 'Q',
      },
    });
    assert.equal(res.statusCode, 201);
    assert.ok(res.json().card.id.startsWith('ic-'));
    assert.equal(res.json().card.sourceTag, 'Q');
  });

  test('GET intent-cards lists by project', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: { actor: 'A', goal: 'G', originalText: 'T' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cards.length, 1);
  });

  test('POST triage sets bucket and A-tag hard gate', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const cardRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: { actor: 'Admin', goal: 'Do X', originalText: 'X', sourceTag: 'A' },
    });
    const cardId = cardRes.json().card.id;

    const triageRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards/${cardId}/triage`,
      headers: H,
      payload: { clarity: 3, groundedness: 3, necessity: 3, coupling: 1, sizeBand: 'S' },
    });
    assert.equal(triageRes.statusCode, 200);
    assert.notEqual(triageRes.json().card.triage.bucket, 'build_now');
    assert.equal(triageRes.json().card.triage.bucket, 'validate_first');
  });

  test('DELETE intent-card returns 204', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const cardRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: { actor: 'A', goal: 'G', originalText: 'T' },
    });
    const cardId = cardRes.json().card.id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${projectId}/intent-cards/${cardId}`,
      headers: H,
    });
    assert.equal(delRes.statusCode, 204);
  });

  // --- Audit Frame routes ---

  test('POST frame creates/updates frame', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/frame`,
      headers: H,
      payload: {
        sponsor: 'CEO',
        motivation: 'Digitize',
        successMetric: 'Review < 2h',
        constraints: '3 months',
        currentWorkflow: 'Excel',
        provenanceMap: 'CEO interview',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().frame.id.startsWith('frame-'));
    assert.equal(res.json().frame.sponsor, 'CEO');
  });

  test('GET frame returns 404 when not set', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/frame`,
      headers: H,
    });
    assert.equal(res.statusCode, 404);
  });

  test('POST frame rejects empty sponsor', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/frame`,
      headers: H,
      payload: { sponsor: '', successMetric: 'X' },
    });
    assert.equal(res.statusCode, 400);
  });

  // --- Ownership isolation ---

  test('GET /api/external-projects/:id rejects cross-user access', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { name: 'private', description: '', sourcePath: '/x' },
    });
    const id = createRes.json().project.id;

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${id}`,
      headers: { 'x-cat-cafe-user': 'other' },
    });
    assert.equal(getRes.statusCode, 404);
  });

  test('DELETE /api/external-projects/:id rejects cross-user delete', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { name: 'private', description: '', sourcePath: '/x' },
    });
    const id = createRes.json().project.id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${id}`,
      headers: { 'x-cat-cafe-user': 'other' },
    });
    assert.equal(delRes.statusCode, 404);
  });

  // --- Intent card projectId isolation ---

  test('GET intent-card rejects cross-project access', async () => {
    const p1 = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'a', description: '', sourcePath: '/a' },
    });
    const p2 = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'b', description: '', sourcePath: '/b' },
    });
    const pid1 = p1.json().project.id;
    const pid2 = p2.json().project.id;

    const cardRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${pid1}/intent-cards`,
      headers: H,
      payload: { actor: 'A', goal: 'G', originalText: 'T' },
    });
    const cardId = cardRes.json().card.id;

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${pid2}/intent-cards/${cardId}`,
      headers: H,
    });
    assert.equal(getRes.statusCode, 404);
  });

  test('PATCH intent-card rejects cross-project mutation', async () => {
    const p1 = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'a', description: '', sourcePath: '/a' },
    });
    const p2 = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'b', description: '', sourcePath: '/b' },
    });

    const cardRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${p1.json().project.id}/intent-cards`,
      headers: H,
      payload: { actor: 'A', goal: 'G', originalText: 'T' },
    });
    const cardId = cardRes.json().card.id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/external-projects/${p2.json().project.id}/intent-cards/${cardId}`,
      headers: H,
      payload: { actor: 'HACKED' },
    });
    assert.equal(patchRes.statusCode, 404);
  });

  // --- Path traversal prevention ---

  test('POST /api/external-projects rejects backlogPath with traversal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: {
        name: 'evil',
        description: '',
        sourcePath: '/tmp/project',
        backlogPath: '../../etc/passwd',
      },
    });
    assert.equal(res.statusCode, 400);
  });

  // --- Cross-user access on sub-routes ---

  test('POST intent-cards rejects cross-user create', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: { 'x-cat-cafe-user': 'other' },
      payload: { actor: 'A', goal: 'G', originalText: 'T' },
    });
    assert.equal(res.statusCode, 404);
  });

  test('POST frame rejects cross-user write', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/frame`,
      headers: { 'x-cat-cafe-user': 'other' },
      payload: { sponsor: 'X', successMetric: 'Y' },
    });
    assert.equal(res.statusCode, 404);
  });

  // --- Missing identity returns 401 ---

  test('POST /api/external-projects without identity returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('GET /api/external-projects without identity returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/external-projects',
    });
    assert.equal(res.statusCode, 401);
  });

  // --- E2E Integration: full Need Audit flow ---

  test('e2e: create project → frame → cards → triage → filter by bucket', async () => {
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'studio-flow', description: 'Client project', sourcePath: '/tmp/sf' },
    });
    assert.equal(projRes.statusCode, 201);
    const projectId = projRes.json().project.id;

    const frameRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/frame`,
      headers: H,
      payload: {
        sponsor: 'CEO',
        motivation: 'Digitize workflow',
        successMetric: 'Review time < 2h',
        constraints: '3 months',
        currentWorkflow: 'Excel sheets',
        provenanceMap: 'CEO interview 2026-03-07',
      },
    });
    assert.equal(frameRes.statusCode, 200);
    assert.equal(frameRes.json().frame.sponsor, 'CEO');

    const qCard = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: {
        actor: 'Admin',
        contextTrigger: 'New order arrives',
        goal: 'Approve within SLA',
        objectState: 'Order approved',
        successSignal: 'Approval < 2h',
        nonGoal: 'Auto-approve',
        originalText: 'Admin needs to approve orders quickly',
        sourceTag: 'Q',
        confidence: 3,
      },
    });
    assert.equal(qCard.statusCode, 201);

    const aCard = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: {
        actor: 'System',
        goal: 'Optimize performance',
        originalText: 'The system should be optimized',
        sourceTag: 'A',
        riskSignals: ['hollow_verbs', 'missing_success_signal'],
      },
    });
    assert.equal(aCard.statusCode, 201);

    const dCard = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: {
        actor: 'Manager',
        goal: 'View team stats',
        originalText: 'Manager dashboard per PRD section 4',
        sourceTag: 'D',
        sourceDetail: 'PRD-V1 section 4.2',
        confidence: 2,
      },
    });
    assert.equal(dCard.statusCode, 201);

    const triageQ = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards/${qCard.json().card.id}/triage`,
      headers: H,
      payload: { clarity: 3, groundedness: 3, necessity: 3, coupling: 1, sizeBand: 'S' },
    });
    assert.equal(triageQ.json().card.triage.bucket, 'build_now');

    const triageA = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards/${aCard.json().card.id}/triage`,
      headers: H,
      payload: { clarity: 3, groundedness: 3, necessity: 3, coupling: 1, sizeBand: 'S' },
    });
    assert.equal(triageA.json().card.triage.bucket, 'validate_first');

    const triageD = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards/${dCard.json().card.id}/triage`,
      headers: H,
      payload: { clarity: 1, groundedness: 2, necessity: 3, coupling: 2, sizeBand: 'M' },
    });
    assert.equal(triageD.json().card.triage.bucket, 'clarify_first');

    const buildNow = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/intent-cards?bucket=build_now`,
      headers: H,
    });
    assert.equal(buildNow.json().cards.length, 1);
    assert.equal(buildNow.json().cards[0].sourceTag, 'Q');

    const validateFirst = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/intent-cards?bucket=validate_first`,
      headers: H,
    });
    assert.equal(validateFirst.json().cards.length, 1);
    assert.equal(validateFirst.json().cards[0].sourceTag, 'A');

    const allCards = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
    });
    assert.equal(allCards.json().cards.length, 3);
    assert.ok(allCards.json().cards.every((/** @type {{ triage: unknown }} */ c) => c.triage !== null));

    const getFrame = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/frame`,
      headers: H,
    });
    assert.equal(getFrame.statusCode, 200);
    assert.equal(getFrame.json().frame.sponsor, 'CEO');
  });

  test('GET intent-cards with bucket filter returns empty for unmatched bucket', async () => {
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = projRes.json().project.id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/intent-cards?bucket=build_now`,
      headers: H,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cards.length, 0);
  });

  test('PATCH intent-card updates fields', async () => {
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = projRes.json().project.id;

    const cardRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: { actor: 'Old', goal: 'G', originalText: 'T' },
    });
    const cardId = cardRes.json().card.id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/external-projects/${projectId}/intent-cards/${cardId}`,
      headers: H,
      payload: { actor: 'New Actor', goal: 'New Goal' },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().card.actor, 'New Actor');
    assert.equal(patchRes.json().card.goal, 'New Goal');
    assert.equal(patchRes.json().card.originalText, 'T');
  });
});
