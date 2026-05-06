import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('MaterializationService', () => {
  let tmpDir;
  let markersDir;
  let queue;
  let service;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-mat-${randomUUID().slice(0, 8)}`);
    markersDir = join(tmpDir, 'docs', 'markers');
    mkdirSync(markersDir, { recursive: true });
    mkdirSync(join(tmpDir, 'docs', 'lessons'), { recursive: true });

    const { MarkerQueue } = await import('../../dist/domains/memory/MarkerQueue.js');
    const { MaterializationService } = await import('../../dist/domains/memory/MaterializationService.js');

    queue = new MarkerQueue(markersDir);
    service = new MaterializationService(queue, join(tmpDir, 'docs'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('canMaterialize returns true for approved markers', async () => {
    const marker = await queue.submit({
      content: 'A lesson learned',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    assert.equal(await service.canMaterialize(marker.id), false);

    await queue.transition(marker.id, 'approved');
    assert.equal(await service.canMaterialize(marker.id), true);
  });

  it('materialize creates .md file and transitions marker', async () => {
    const marker = await queue.submit({
      content: 'Redis 6399 is sacred — never touch it in dev',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    await queue.transition(marker.id, 'approved');

    const result = await service.materialize(marker.id);
    assert.ok(result.outputPath);
    assert.ok(result.anchor);

    // Marker should be transitioned to materialized
    const markers = await queue.list({ status: 'materialized' });
    assert.equal(markers.length, 1);
  });

  it('materialize returns committed and reindexed status', async () => {
    const marker = await queue.submit({
      content: 'Test committed/reindexed fields',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    await queue.transition(marker.id, 'approved');
    const result = await service.materialize(marker.id);
    assert.equal(typeof result.committed, 'boolean');
    assert.equal(typeof result.reindexed, 'boolean');
  });

  it('creates missing subdirectory', async () => {
    // Don't pre-create docs/researchs/ — let service do it
    const marker = await queue.submit({
      content: 'Research note about memory',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'research',
    });
    await queue.transition(marker.id, 'approved');
    const result = await service.materialize(marker.id);
    assert.ok(existsSync(result.outputPath));
  });

  it('handles file-exists conflict with unique suffix', async () => {
    const marker = await queue.submit({
      content: 'First lesson',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    await queue.transition(marker.id, 'approved');
    const r1 = await service.materialize(marker.id);

    // Create another marker and manually place a file at the expected path
    const marker2 = await queue.submit({
      content: 'Second lesson',
      source: 'opus:t2',
      status: 'captured',
      targetKind: 'lesson',
    });
    await queue.transition(marker2.id, 'approved');
    const expectedPath = join(tmpDir, 'docs', 'lessons', `lesson-${marker2.id}.md`);
    writeFileSync(expectedPath, 'existing content');
    const r2 = await service.materialize(marker2.id);
    assert.notEqual(r1.outputPath, r2.outputPath);
    assert.notEqual(r2.outputPath, expectedPath);
    assert.ok(existsSync(r2.outputPath));
  });

  it('commits the materialized file to git', async () => {
    // Init a git repo in tmpDir so commit can work
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    };
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tmpDir, env: gitEnv, stdio: 'pipe' });
    const marker = await queue.submit({
      content: 'Committed lesson',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    await queue.transition(marker.id, 'approved');
    const result = await service.materialize(marker.id);
    assert.equal(result.committed, true);
    const log = execSync('git log --oneline -1', { cwd: tmpDir }).toString();
    assert.ok(log.includes('materialize'));
  });

  it('triggers incrementalUpdate after writing file', async () => {
    const { MaterializationService } = await import('../../dist/domains/memory/MaterializationService.js');
    let reindexedPaths = [];
    const mockIndexBuilder = {
      incrementalUpdate: async (paths) => {
        reindexedPaths = paths;
      },
    };
    const svcWithIndex = new MaterializationService(queue, join(tmpDir, 'docs'), mockIndexBuilder);
    const marker = await queue.submit({
      content: 'Reindexed lesson',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    await queue.transition(marker.id, 'approved');
    const result = await svcWithIndex.materialize(marker.id);
    assert.equal(result.reindexed, true);
    assert.equal(reindexedPaths.length, 1);
    assert.ok(reindexedPaths[0].includes('lesson'));
  });

  it('reindexed is false when no indexBuilder provided', async () => {
    const marker = await queue.submit({
      content: 'No reindex lesson',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    await queue.transition(marker.id, 'approved');
    const result = await service.materialize(marker.id);
    assert.equal(result.reindexed, false);
  });

  it('committed is false when not in a git repo', async () => {
    // tmpDir has no .git — commit should gracefully fail
    // Remove .git if somehow present
    rmSync(join(tmpDir, '.git'), { recursive: true, force: true });
    const marker = await queue.submit({
      content: 'No git lesson',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    await queue.transition(marker.id, 'approved');
    const result = await service.materialize(marker.id);
    assert.equal(result.committed, false);
    assert.ok(existsSync(result.outputPath)); // file still written
  });

  it('rejects invalid targetKind at runtime', async () => {
    const marker = await queue.submit({
      content: 'Malicious content',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    await queue.transition(marker.id, 'approved');
    // Manually tamper targetKind after approval (simulates YAML file tampering)
    const markers = await queue.list({ status: 'approved' });
    const m = markers.find((x) => x.id === marker.id);
    m.targetKind = '"; echo PWNED; echo "';
    // Patch list to return tampered marker
    const origList = queue.list.bind(queue);
    queue.list = async (filter) => {
      const all = await origList(filter);
      const found = all.find((x) => x.id === marker.id);
      if (found) found.targetKind = '"; echo PWNED; echo "';
      return all;
    };
    await assert.rejects(() => service.materialize(marker.id), {
      message: /invalid.*kind/i,
    });
  });

  it('maps targetKind to correct directory name', async () => {
    const marker = await queue.submit({
      content: 'Research about memory',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'research',
    });
    await queue.transition(marker.id, 'approved');
    const result = await service.materialize(marker.id);
    // Must be docs/research/ not docs/researchs/
    assert.ok(result.outputPath.includes('/research/'), `Expected /research/ in ${result.outputPath}`);
    assert.ok(!result.outputPath.includes('/researchs/'), `Must not contain /researchs/ in ${result.outputPath}`);
  });

  it('materialize throws for non-approved marker', async () => {
    const marker = await queue.submit({
      content: 'Test',
      source: 'opus:t1',
      status: 'captured',
    });

    await assert.rejects(() => service.materialize(marker.id), {
      message: /not approved/i,
    });
  });

  it('materialize tags frontmatter with collection metadata when marker has targetCollectionId (F186 AC-A10)', async () => {
    const { readFileSync } = await import('node:fs');
    const marker = await queue.submit({
      content: 'A method extracted from lexander world',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
      sourceCollectionId: 'world:lexander',
      targetCollectionId: 'global:methods',
    });
    await queue.transition(marker.id, 'approved');

    const result = await service.materialize(marker.id);
    const md = readFileSync(result.outputPath, 'utf-8');
    assert.ok(md.includes('target_collection: global:methods'), 'frontmatter should contain target_collection');
    assert.ok(md.includes('source_collection: world:lexander'), 'frontmatter should contain source_collection');
  });

  it('materialize omits collection fields when marker has no targetCollectionId (backwards compat)', async () => {
    const { readFileSync } = await import('node:fs');
    const marker = await queue.submit({
      content: 'Legacy lesson without collection routing',
      source: 'opus:t1',
      status: 'captured',
      targetKind: 'lesson',
    });
    await queue.transition(marker.id, 'approved');

    const result = await service.materialize(marker.id);
    const md = readFileSync(result.outputPath, 'utf-8');
    assert.ok(!md.includes('target_collection'), 'should not have target_collection');
    assert.ok(!md.includes('source_collection'), 'should not have source_collection');
  });

  it('e2e: submit → approve → materialize → .md exists + marker=materialized + reindexed', async () => {
    const { MaterializationService } = await import('../../dist/domains/memory/MaterializationService.js');
    let reindexedPaths = [];
    const mockIndexBuilder = {
      incrementalUpdate: async (paths) => {
        reindexedPaths = paths;
      },
    };

    // Init git repo for commit
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    };
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tmpDir, env: gitEnv, stdio: 'pipe' });

    const fullService = new MaterializationService(queue, join(tmpDir, 'docs'), mockIndexBuilder);

    // Submit
    const marker = await queue.submit({
      content: 'E2e: Redis 6399 lesson from memory hub',
      source: 'opus:e2e',
      status: 'captured',
      targetKind: 'lesson',
    });
    assert.equal(marker.status, 'captured');

    // Approve
    await queue.transition(marker.id, 'approved');
    const approved = (await queue.list({ status: 'approved' })).find((m) => m.id === marker.id);
    assert.ok(approved);

    // Materialize
    const result = await fullService.materialize(marker.id);

    // Verify .md file exists
    assert.ok(existsSync(result.outputPath));
    assert.ok(result.outputPath.includes('lesson'));
    assert.ok(result.anchor.includes(marker.id));

    // Verify git committed
    assert.equal(result.committed, true);
    const log = execSync('git log --oneline', { cwd: tmpDir }).toString();
    assert.ok(log.includes('materialize'));

    // Verify reindexed
    assert.equal(result.reindexed, true);
    assert.equal(reindexedPaths.length, 1);

    // Verify marker status is materialized
    const materialized = (await queue.list({ status: 'materialized' })).find((m) => m.id === marker.id);
    assert.ok(materialized);
  });
});
