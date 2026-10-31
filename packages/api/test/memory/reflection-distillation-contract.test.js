import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DistillationService } from '../../dist/domains/memory/distillation-service.js';
import { GlobalIndexBuilder } from '../../dist/domains/memory/GlobalIndexBuilder.js';
import { MemoryReflectionStore } from '../../dist/domains/memory/MemoryReflectionStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

test('F271 decision candidate reaches the durable compiler only after explicit generalizable marking', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f271-f152-contract-'));
  const projectStore = new SqliteEvidenceStore(join(root, 'project.sqlite'));
  const globalStore = new SqliteEvidenceStore(join(root, 'global.sqlite'));
  try {
    await projectStore.initialize();
    await globalStore.initialize();
    const reflectionStore = new MemoryReflectionStore(projectStore);

    const accepted = await reflectionStore.acceptBatch({
      ownerUserId: 'owner-1',
      catId: 'codex-sol',
      householdLocalDate: '2026-07-26',
      createdAt: '2026-07-26T12:00:00.000Z',
      budget: 5,
      outputs: [
        {
          kind: 'decision',
          destination: 'public_evidence',
          normalizedClaim: 'Approved reusable truths are materialized before the global index is rebuilt.',
          reason: 'The owner selected one durable compiler path.',
          sourceRef: {
            threadId: 'thread-source',
            sessionId: 'session-source',
            eventNo: 8,
          },
        },
      ],
    });
    const projectionRef = accepted.accepted[0].projectionRef;
    const projected = await projectStore.getByAnchor(projectionRef);
    assert.equal(projected?.kind, 'decision');
    assert.equal(projected?.authority, 'candidate');
    assert.equal(projected?.activation, 'pull_only');
    assert.equal(projected?.generalizable, undefined);

    await assert.rejects(async () => {
      const failClosed = new DistillationService(projectStore, globalStore, {
        distilledRoot: join(root, 'distilled-truths'),
      });
      await failClosed.initialize();
      await failClosed.nominate(projectionRef, root);
    }, /not marked as generalizable/);

    await projectStore.upsert([{ ...projected, generalizable: true }]);
    const distilledRoot = join(root, 'distilled-truths');
    const distillation = new DistillationService(projectStore, globalStore, { distilledRoot });
    await distillation.initialize();
    const candidate = await distillation.nominate(projectionRef, root);
    await distillation.approve(candidate.id, 'reviewer-1');

    const skillsRoot = join(root, 'skills');
    const memoryRoot = join(root, 'memory');
    mkdirSync(skillsRoot);
    mkdirSync(memoryRoot);
    const compiler = new GlobalIndexBuilder({
      skillsRoot,
      memoryRoot,
      globalStore,
      distilledRoot,
    });
    await compiler.rebuild();

    const durable = await globalStore.getByAnchor(`distilled:${candidate.id}`);
    assert.equal(durable?.kind, 'decision');
    assert.match(durable?.summary ?? '', /materialized before the global index/);
  } finally {
    projectStore.close();
    globalStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
