import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('DistillationService', () => {
  let DistillationService, SqliteEvidenceStore;

  before(async () => {
    ({ DistillationService } = await import('../../dist/domains/memory/distillation-service.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
  });

  async function createFixture() {
    const projectStore = new SqliteEvidenceStore(':memory:');
    await projectStore.initialize();
    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();
    const svc = new DistillationService(projectStore, globalStore);
    await svc.initialize();
    return { svc, projectStore, globalStore };
  }

  it('nominate creates a pending candidate from generalizable item', async () => {
    const { svc, projectStore } = await createFixture();
    await projectStore.upsert([
      {
        anchor: 'lesson-redis',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix pitfall in test-project',
        summary: 'eval commands ignore keyPrefix in ioredis',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const candidate = await svc.nominate('lesson-redis', '/home/user/test-project');
    assert.equal(candidate.status, 'pending');
    assert.ok(candidate.id);
    assert.ok(!candidate.evidence.sanitizedTitle.includes('test-project'));
  });

  it('nominate rejects items without generalizable=true', async () => {
    const { svc, projectStore } = await createFixture();
    await projectStore.upsert([
      {
        anchor: 'lesson-private',
        kind: 'lesson',
        status: 'active',
        title: 'Private context',
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    await assert.rejects(() => svc.nominate('lesson-private', '/tmp/proj'), { message: /not marked as generalizable/ });
  });

  it('nominate rejects non-existent anchor', async () => {
    const { svc } = await createFixture();
    await assert.rejects(() => svc.nominate('nonexistent', '/tmp/proj'), { message: /not found/ });
  });

  it('nominate is idempotent for same anchor', async () => {
    const { svc, projectStore } = await createFixture();
    await projectStore.upsert([
      {
        anchor: 'lesson-dup',
        kind: 'lesson',
        status: 'active',
        title: 'Duplicate test',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const c1 = await svc.nominate('lesson-dup', '/tmp/proj');
    const c2 = await svc.nominate('lesson-dup', '/tmp/proj');
    assert.equal(c1.id, c2.id);
  });

  it('approve writes deidentified content to global store', async () => {
    const { svc, projectStore, globalStore } = await createFixture();
    await projectStore.upsert([
      {
        anchor: 'lesson-global',
        kind: 'lesson',
        status: 'active',
        title: 'Generalizable pattern',
        summary: 'Works across projects',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const candidate = await svc.nominate('lesson-global', '/tmp/proj');
    await svc.approve(candidate.id, 'codex');

    const pending = await svc.listPending();
    assert.equal(pending.length, 0);

    const global = await globalStore.getByAnchor(`distilled:${candidate.id}`);
    assert.ok(global);
    assert.equal(global.kind, 'lesson');
    assert.equal(global.title, 'Generalizable pattern');
  });

  it('reject removes candidate from pending', async () => {
    const { svc, projectStore } = await createFixture();
    await projectStore.upsert([
      {
        anchor: 'lesson-reject',
        kind: 'lesson',
        status: 'active',
        title: 'Should be rejected',
        generalizable: true,
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    const candidate = await svc.nominate('lesson-reject', '/tmp/proj');
    await svc.reject(candidate.id, 'codex');

    const pending = await svc.listPending();
    assert.equal(pending.length, 0);
  });

  it('listPending returns only pending candidates', async () => {
    const { svc, projectStore } = await createFixture();
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

    await svc.nominate('l1', '/tmp/proj');
    const c2 = await svc.nominate('l2', '/tmp/proj');
    await svc.approve(c2.id, 'opus');

    const pending = await svc.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].evidence.sanitizedTitle, 'One');
  });
});
