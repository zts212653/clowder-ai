import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('Distillation routes', () => {
  let distillationRoutes, SqliteEvidenceStore, DistillationService;

  before(async () => {
    ({ distillationRoutes } = await import('../../dist/routes/distillation-routes.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    ({ DistillationService } = await import('../../dist/domains/memory/distillation-service.js'));
  });

  async function buildApp() {
    const projectStore = new SqliteEvidenceStore(':memory:');
    await projectStore.initialize();
    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();
    const distillationService = new DistillationService(projectStore, globalStore);
    await distillationService.initialize();

    const app = Fastify();
    await app.register(distillationRoutes, { evidenceStore: projectStore, distillationService });
    return { app, projectStore, globalStore, distillationService };
  }

  it('PATCH /api/evidence/:anchor/generalizable sets true', async () => {
    const { app, projectStore } = await buildApp();
    await projectStore.upsert([
      {
        anchor: 'lesson-1',
        kind: 'lesson',
        status: 'active',
        title: 'Redis pitfall',
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/evidence/lesson-1/generalizable',
      payload: { generalizable: true },
    });
    assert.equal(res.statusCode, 200);

    const item = await projectStore.getByAnchor('lesson-1');
    assert.equal(item.generalizable, true);
    await app.close();
  });

  it('PATCH /api/evidence/:anchor/generalizable sets false', async () => {
    const { app, projectStore } = await buildApp();
    await projectStore.upsert([
      {
        anchor: 'lesson-2',
        kind: 'lesson',
        status: 'active',
        title: 'Private context',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/evidence/lesson-2/generalizable',
      payload: { generalizable: false },
    });
    assert.equal(res.statusCode, 200);

    const item = await projectStore.getByAnchor('lesson-2');
    assert.equal(item.generalizable, false);
    await app.close();
  });

  it('PATCH returns 404 for missing anchor', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/evidence/nonexistent/generalizable',
      payload: { generalizable: true },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  it('POST /api/distillation/nominate creates pending candidate', async () => {
    const { app, projectStore } = await buildApp();
    await projectStore.upsert([
      {
        anchor: 'lesson-nom',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix pitfall in test-project',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/distillation/nominate',
      payload: { anchor: 'lesson-nom', projectPath: '/home/user/test-project' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'pending');
    assert.ok(body.id);
    await app.close();
  });

  it('POST /api/distillation/nominate rejects non-generalizable', async () => {
    const { app, projectStore } = await buildApp();
    await projectStore.upsert([
      {
        anchor: 'lesson-priv',
        kind: 'lesson',
        status: 'active',
        title: 'Private',
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/distillation/nominate',
      payload: { anchor: 'lesson-priv', projectPath: '/tmp/proj' },
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('POST /api/distillation/:id/review approves candidate', async () => {
    const { app, projectStore, globalStore } = await buildApp();
    await projectStore.upsert([
      {
        anchor: 'lesson-approve',
        kind: 'lesson',
        status: 'active',
        title: 'Generalizable pattern',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const nomRes = await app.inject({
      method: 'POST',
      url: '/api/distillation/nominate',
      payload: { anchor: 'lesson-approve', projectPath: '/tmp/proj' },
    });
    const { id } = JSON.parse(nomRes.payload);

    const res = await app.inject({
      method: 'POST',
      url: `/api/distillation/${id}/review`,
      payload: { decision: 'approve', reviewerId: 'codex' },
    });
    assert.equal(res.statusCode, 200);

    const global = await globalStore.getByAnchor(`distilled:${id}`);
    assert.ok(global);
    assert.equal(global.kind, 'lesson');
    await app.close();
  });

  it('POST /api/distillation/nominate deidentifies using request projectPath', async () => {
    const { app, projectStore } = await buildApp();
    // Evidence title references an EXTERNAL project path — different from buildApp's default
    await projectStore.upsert([
      {
        anchor: 'lesson-ext',
        kind: 'lesson',
        status: 'active',
        title: 'Bug found in /external/other-project/src/api.ts',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    await app.inject({
      method: 'POST',
      url: '/api/distillation/nominate',
      payload: { anchor: 'lesson-ext', projectPath: '/external/other-project' },
    });

    const candRes = await app.inject({ method: 'GET', url: '/api/distillation/candidates' });
    const body = JSON.parse(candRes.payload);
    const candidate = body.candidates.find((c) => c.anchor === 'lesson-ext');
    // Must sanitize using the REQUEST's projectPath, not the constructor default
    assert.ok(
      !candidate.sanitizedTitle.includes('/external/other-project'),
      `Expected projectPath to be sanitized but got: "${candidate.sanitizedTitle}"`,
    );
    assert.ok(candidate.sanitizedTitle.includes('[PROJECT]'));
    await app.close();
  });

  it('POST /api/distillation/nominate rejects non-lesson/decision kind', async () => {
    const { app, projectStore } = await buildApp();
    await projectStore.upsert([
      {
        anchor: 'feat-item',
        kind: 'feature',
        status: 'active',
        title: 'A feature spec',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/distillation/nominate',
      payload: { anchor: 'feat-item', projectPath: '/tmp/proj' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('kind'));
    await app.close();
  });

  it('PATCH /api/evidence/:anchor/generalizable rejects non-lesson/decision kind', async () => {
    const { app, projectStore } = await buildApp();
    await projectStore.upsert([
      {
        anchor: 'session-item',
        kind: 'session',
        status: 'active',
        title: 'A session log',
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/evidence/session-item/generalizable',
      payload: { generalizable: true },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('kind'));
    await app.close();
  });

  it('POST /api/distillation/nominate sanitizes person names via blocklist', async () => {
    const { app, projectStore } = await buildApp();
    await projectStore.upsert([
      {
        anchor: 'lesson-name',
        kind: 'lesson',
        status: 'active',
        title: 'Alice reported redis timeout in staging',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    await app.inject({
      method: 'POST',
      url: '/api/distillation/nominate',
      payload: { anchor: 'lesson-name', projectPath: '/tmp/proj', personNames: ['Alice'] },
    });

    const candRes = await app.inject({ method: 'GET', url: '/api/distillation/candidates' });
    const body = JSON.parse(candRes.payload);
    const candidate = body.candidates.find((c) => c.anchor === 'lesson-name');
    assert.ok(
      !candidate.sanitizedTitle.includes('Alice'),
      `Expected person name to be sanitized but got: "${candidate.sanitizedTitle}"`,
    );
    assert.ok(candidate.sanitizedTitle.includes('[PERSON]'));
    await app.close();
  });

  it('GET /api/distillation/candidates returns pending list', async () => {
    const { app, projectStore } = await buildApp();
    await projectStore.upsert([
      {
        anchor: 'l1',
        kind: 'lesson',
        status: 'active',
        title: 'One',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
      {
        anchor: 'l2',
        kind: 'lesson',
        status: 'active',
        title: 'Two',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    await app.inject({
      method: 'POST',
      url: '/api/distillation/nominate',
      payload: { anchor: 'l1', projectPath: '/tmp/p' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/distillation/nominate',
      payload: { anchor: 'l2', projectPath: '/tmp/p' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/distillation/candidates' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.candidates.length, 2);
    await app.close();
  });
});
