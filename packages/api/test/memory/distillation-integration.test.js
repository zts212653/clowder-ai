import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('Distillation integration: end-to-end flow', () => {
  let SqliteEvidenceStore, DeidentificationService, DistillationService;

  before(async () => {
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    ({ DeidentificationService } = await import('../../dist/domains/memory/deidentification-service.js'));
    ({ DistillationService } = await import('../../dist/domains/memory/distillation-service.js'));
  });

  it('full pipeline: create → mark → nominate → approve → global search', async () => {
    // 1. Setup dual stores
    const projectStore = new SqliteEvidenceStore(':memory:');
    await projectStore.initialize();
    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();

    // 2. Create a lesson in project store
    await projectStore.upsert([
      {
        anchor: 'lesson-redis-prefix',
        kind: 'lesson',
        status: 'active',
        title: 'ioredis keyPrefix does not apply to eval commands in acme-billing',
        summary:
          'When using eval/evalsha, ioredis skips the keyPrefix. Use explicit prefix in Lua scripts. Found at /home/dev/acme-billing/src/cache.ts',
        keywords: ['redis', 'ioredis', 'keyPrefix', 'eval'],
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);

    // 3. Mark as generalizable
    const item = await projectStore.getByAnchor('lesson-redis-prefix');
    assert.ok(item);
    await projectStore.upsert([{ ...item, generalizable: true }]);

    // Verify fail-closed: unmarked item stays undefined
    await projectStore.upsert([
      {
        anchor: 'lesson-private',
        kind: 'lesson',
        status: 'active',
        title: 'Internal billing quirk',
        updatedAt: '2026-04-10T00:00:00Z',
      },
    ]);
    const priv = await projectStore.getByAnchor('lesson-private');
    assert.equal(priv.generalizable, undefined, 'fail-closed: unmarked = undefined');

    // 4. Nominate via DistillationService
    const svc = new DistillationService(projectStore, globalStore);
    await svc.initialize();

    const candidate = await svc.nominate('lesson-redis-prefix', '/home/dev/acme-billing');
    assert.equal(candidate.status, 'pending');

    // Verify deidentification
    assert.ok(!candidate.evidence.sanitizedTitle.includes('acme-billing'));
    assert.ok(candidate.evidence.sanitizedTitle.includes('[PROJECT]'));
    assert.ok(!candidate.evidence.sanitizedSummary.includes('/home/dev/acme-billing'));
    assert.ok(candidate.evidence.sanitizedSummary.includes('[PROJECT]'));
    assert.ok(candidate.evidence.removedPatterns.length > 0);

    // Technical terms preserved
    assert.ok(candidate.evidence.sanitizedTitle.includes('ioredis'));
    assert.ok(candidate.evidence.sanitizedSummary.includes('Lua scripts'));
    assert.deepEqual(candidate.evidence.sanitizedKeywords, ['redis', 'ioredis', 'keyPrefix', 'eval']);

    // Private item cannot be nominated
    await assert.rejects(() => svc.nominate('lesson-private', '/home/dev/acme-billing'), {
      message: /not marked as generalizable/,
    });

    // 5. Approve → writes to global store
    await svc.approve(candidate.id, 'codex');

    const pending = await svc.listPending();
    assert.equal(pending.length, 0, 'no pending after approve');

    // 6. Global store has the distilled lesson
    const global = await globalStore.getByAnchor(`distilled:${candidate.id}`);
    assert.ok(global, 'distilled item exists in global store');
    assert.equal(global.kind, 'lesson');
    assert.ok(!global.title.includes('acme-billing'), 'project name removed from global');
    assert.ok(global.title.includes('ioredis'), 'technical terms preserved in global');

    // 7. Global search finds the distilled knowledge
    const results = await globalStore.search('ioredis keyPrefix eval');
    assert.ok(results.length >= 1, 'global search returns distilled lesson');
    assert.equal(results[0].anchor, `distilled:${candidate.id}`);
  });
});
