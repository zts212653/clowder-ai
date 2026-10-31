// F152 Phase C: Red tests for durable distillation supply chain
// Proves AC-C1 (generalizable survives rebuild) and AC-C3 (candidate + approved output survive)

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

const TEST_DISTILLED_ROOT = join(tmpdir(), `distilled-truths-test-${process.pid}`);

describe('F152 Phase C: Durable distillation supply chain', () => {
  let SqliteEvidenceStore, DistillationService, GlobalIndexBuilder;

  before(async () => {
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    ({ DistillationService } = await import('../../dist/domains/memory/distillation-service.js'));
    ({ GlobalIndexBuilder } = await import('../../dist/domains/memory/GlobalIndexBuilder.js'));
    // Clean up test distilled root
    rmSync(TEST_DISTILLED_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DISTILLED_ROOT, { recursive: true });
  });

  // ── AC-C1: generalizable marker survives index rebuild ──────────────

  describe('AC-C1: generalizable survives rebuild', () => {
    it('upsert without generalizable preserves existing true value', async () => {
      const store = new SqliteEvidenceStore(':memory:');
      await store.initialize();

      // Step 1: Insert item WITH generalizable=true
      await store.upsert([
        {
          anchor: 'lesson-redis-pitfall',
          kind: 'lesson',
          status: 'active',
          title: 'Redis keyPrefix pitfall',
          summary: 'eval commands ignore keyPrefix',
          generalizable: true,
          updatedAt: '2026-04-10T00:00:00Z',
        },
      ]);

      const before = await store.getByAnchor('lesson-redis-pitfall');
      assert.equal(before.generalizable, true, 'initially marked true');

      // Step 2: Upsert same anchor WITHOUT generalizable (simulates rebuild)
      await store.upsert([
        {
          anchor: 'lesson-redis-pitfall',
          kind: 'lesson',
          status: 'active',
          title: 'Redis keyPrefix pitfall (updated)',
          summary: 'eval commands ignore keyPrefix (updated)',
          updatedAt: '2026-04-11T00:00:00Z',
        },
      ]);

      // Step 3: generalizable must still be true
      const after = await store.getByAnchor('lesson-redis-pitfall');
      assert.equal(after.generalizable, true, 'generalizable must survive upsert without explicit value');
    });

    it('upsert with explicit generalizable=false overrides existing true', async () => {
      const store = new SqliteEvidenceStore(':memory:');
      await store.initialize();

      await store.upsert([
        {
          anchor: 'lesson-explicit-override',
          kind: 'lesson',
          status: 'active',
          title: 'Override test',
          generalizable: true,
          updatedAt: '2026-04-10T00:00:00Z',
        },
      ]);

      // Explicit false must override
      await store.upsert([
        {
          anchor: 'lesson-explicit-override',
          kind: 'lesson',
          status: 'active',
          title: 'Override test',
          generalizable: false,
          updatedAt: '2026-04-11T00:00:00Z',
        },
      ]);

      const item = await store.getByAnchor('lesson-explicit-override');
      assert.equal(item.generalizable, false, 'explicit false must override');
    });
  });

  // ── AC-C3: candidates persist across service re-creation ────────────

  describe('AC-C3: persistent candidate queue', () => {
    it('candidates survive DistillationService re-creation', async () => {
      const projectStore = new SqliteEvidenceStore(':memory:');
      await projectStore.initialize();
      const globalStore = new SqliteEvidenceStore(':memory:');
      await globalStore.initialize();

      // Seed a generalizable item
      await projectStore.upsert([
        {
          anchor: 'lesson-persist-test',
          kind: 'lesson',
          status: 'active',
          title: 'Persistence test lesson',
          summary: 'Tests that candidates persist',
          generalizable: true,
          updatedAt: '2026-07-26T00:00:00Z',
        },
      ]);

      // Create service, nominate a candidate
      const svc1 = new DistillationService(projectStore, globalStore);
      await svc1.initialize();
      const candidate = await svc1.nominate('lesson-persist-test', '/tmp/test-project');
      assert.equal(candidate.status, 'pending');

      // Create a NEW service instance (simulates process restart)
      const svc2 = new DistillationService(projectStore, globalStore);
      await svc2.initialize();

      // Candidate must still be listed
      const pending = await svc2.listPending();
      assert.equal(pending.length, 1, 'candidate must survive service re-creation');
      assert.equal(pending[0].anchor, 'lesson-persist-test');
      assert.equal(pending[0].id, candidate.id);
    });
  });

  // ── AC-C3: approved output survives GlobalIndexBuilder.rebuild() ────

  describe('AC-C3: approved output survives rebuild', () => {
    it('approved distilled truth survives GlobalIndexBuilder.rebuild()', async () => {
      const globalStore = new SqliteEvidenceStore(':memory:');
      await globalStore.initialize();

      // Pre-populate with a distilled truth (simulates approve → materialize → compile)
      await globalStore.upsert([
        {
          anchor: 'distilled:test-uuid-123',
          kind: 'lesson',
          status: 'active',
          title: 'Distilled: ioredis keyPrefix pitfall',
          summary: 'eval commands ignore keyPrefix in ioredis',
          updatedAt: '2026-07-26T00:00:00Z',
        },
      ]);

      // Verify it exists before rebuild
      const beforeRebuild = await globalStore.getByAnchor('distilled:test-uuid-123');
      assert.ok(beforeRebuild, 'distilled truth exists before rebuild');

      // Write a materialized truth file for the compiler to discover
      const truthFile = join(TEST_DISTILLED_ROOT, 'test-uuid-123.md');
      const truthContent = [
        '---',
        'type: distilled',
        'kind: lesson',
        'approved_by: codex',
        'approved_at: 2026-07-26T00:00:00Z',
        '---',
        '',
        '# ioredis keyPrefix pitfall',
        '',
        'eval commands ignore keyPrefix in ioredis.',
        '',
      ].join('\n');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(truthFile, truthContent);

      // Rebuild global index (with distilledRoot pointing to our truth files)
      const emptySkillsRoot = join(tmpdir(), `empty-skills-${process.pid}`);
      mkdirSync(emptySkillsRoot, { recursive: true });
      const emptyMemoryRoot = join(tmpdir(), `empty-memory-${process.pid}`);
      mkdirSync(emptyMemoryRoot, { recursive: true });

      const builder = new GlobalIndexBuilder({
        skillsRoot: emptySkillsRoot,
        memoryRoot: emptyMemoryRoot,
        globalStore,
        distilledRoot: TEST_DISTILLED_ROOT,
      });

      await builder.rebuild();

      // Distilled truth must survive rebuild
      const afterRebuild = await globalStore.getByAnchor('distilled:test-uuid-123');
      assert.ok(afterRebuild, 'distilled truth must survive GlobalIndexBuilder.rebuild()');
      assert.equal(afterRebuild.title, 'ioredis keyPrefix pitfall');
      assert.equal(afterRebuild.kind, 'lesson');
    });
  });

  // ── P1 fix: rejected candidate allows re-nomination ────────────────

  describe('Re-nomination after rejection', () => {
    it('rejected candidate can be re-nominated with fresh deidentification', async () => {
      const projectStore = new SqliteEvidenceStore(':memory:');
      await projectStore.initialize();
      const globalStore = new SqliteEvidenceStore(':memory:');
      await globalStore.initialize();

      await projectStore.upsert([
        {
          anchor: 'lesson-retry-test',
          kind: 'lesson',
          status: 'active',
          title: 'Retry test lesson',
          summary: 'Tests that rejected candidates can be re-nominated',
          generalizable: true,
          updatedAt: '2026-07-26T00:00:00Z',
        },
      ]);

      const svc = new DistillationService(projectStore, globalStore);
      await svc.initialize();

      // Nominate and reject
      const first = await svc.nominate('lesson-retry-test', '/tmp/test-project');
      assert.equal(first.status, 'pending');
      await svc.reject(first.id, 'reviewer-1');

      // Re-nominate must succeed with a new candidate (not return the rejected one)
      const second = await svc.nominate('lesson-retry-test', '/tmp/test-project');
      assert.equal(second.status, 'pending', 're-nomination must create pending candidate');
      assert.notEqual(second.id, first.id, 're-nomination must have a new id');

      // Only the new candidate should be in pending list
      const pending = await svc.listPending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].id, second.id);
    });
  });

  // ── dataDir contract: distilledRoot follows custom dataDir ──────────

  describe('dataDir contract', () => {
    it('DistillationService materializes into custom distilledRoot, not hardcoded ~/.cat-cafe/', async () => {
      const projectStore = new SqliteEvidenceStore(':memory:');
      await projectStore.initialize();
      const globalStore = new SqliteEvidenceStore(':memory:');
      await globalStore.initialize();

      // Use a custom distilledRoot (simulates non-default dataDir)
      const customRoot = join(tmpdir(), `custom-distilled-${process.pid}`);

      await projectStore.upsert([
        {
          anchor: 'lesson-datadir-test',
          kind: 'lesson',
          status: 'active',
          title: 'dataDir contract test',
          summary: 'Verifies distilledRoot follows dataDir',
          generalizable: true,
          updatedAt: '2026-07-26T00:00:00Z',
        },
      ]);

      const svc = new DistillationService(projectStore, globalStore, { distilledRoot: customRoot });
      await svc.initialize();

      const candidate = await svc.nominate('lesson-datadir-test', '/tmp/custom-project');
      await svc.approve(candidate.id, 'reviewer');

      // Truth file must be in the custom root, not ~/.cat-cafe/distilled-truths/
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(customRoot);
      assert.ok(files.length >= 1, 'materialized file must land in custom distilledRoot');
      assert.ok(
        files.some((f) => f.endsWith('.md')),
        'truth file must be .md',
      );
    });
  });

  // ── Full chain: mark → nominate → approve → rebuild → search ────────

  describe('Full chain: durable end-to-end', () => {
    it('approved truth is searchable after GlobalIndexBuilder rebuild', async () => {
      const projectStore = new SqliteEvidenceStore(':memory:');
      await projectStore.initialize();
      const globalStore = new SqliteEvidenceStore(':memory:');
      await globalStore.initialize();

      // 1. Create lesson + mark generalizable
      await projectStore.upsert([
        {
          anchor: 'lesson-chain-test',
          kind: 'lesson',
          status: 'active',
          title: 'Chain test: API migration pattern',
          summary: 'Always check backward compatibility before API version bump',
          generalizable: true,
          updatedAt: '2026-07-26T00:00:00Z',
        },
      ]);

      // 2. Nominate + approve
      const distilledRoot = join(tmpdir(), `chain-distilled-${process.pid}`);
      mkdirSync(distilledRoot, { recursive: true });

      const svc = new DistillationService(projectStore, globalStore, { distilledRoot });
      await svc.initialize();

      const candidate = await svc.nominate('lesson-chain-test', '/tmp/chain-project');
      await svc.approve(candidate.id, 'opus');

      // 3. Verify materialized truth file exists
      const truthFiles = (await import('node:fs')).readdirSync(distilledRoot);
      assert.ok(truthFiles.length >= 1, 'materialized truth file must exist');

      // 4. Rebuild global index
      const emptySkillsRoot = join(tmpdir(), `chain-skills-${process.pid}`);
      mkdirSync(emptySkillsRoot, { recursive: true });
      const emptyMemoryRoot = join(tmpdir(), `chain-memory-${process.pid}`);
      mkdirSync(emptyMemoryRoot, { recursive: true });

      const builder = new GlobalIndexBuilder({
        skillsRoot: emptySkillsRoot,
        memoryRoot: emptyMemoryRoot,
        globalStore,
        distilledRoot,
      });

      await builder.rebuild();

      // 5. Search must find the distilled truth
      const results = await globalStore.search('API migration backward compatibility');
      assert.ok(results.length >= 1, 'distilled truth must be searchable after rebuild');
      const match = results.find((r) => r.anchor.startsWith('distilled:'));
      assert.ok(match, 'search result must have distilled: anchor prefix');
    });
  });
});
