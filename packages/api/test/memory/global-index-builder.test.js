/**
 * F102 Phase F-4: GlobalIndexBuilder — compiles global knowledge sources
 * (Skills + MEMORY.md entries) into global_knowledge.sqlite
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('GlobalIndexBuilder', () => {
  let GlobalIndexBuilder;
  let SqliteEvidenceStore;
  let tmpDir;

  beforeEach(async () => {
    const mod = await import('../../dist/domains/memory/GlobalIndexBuilder.js');
    GlobalIndexBuilder = mod.GlobalIndexBuilder;
    const storeMod = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    SqliteEvidenceStore = storeMod.SqliteEvidenceStore;
    tmpDir = mkdtempSync(join(tmpdir(), 'global-idx-'));
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes SKILL.md files into global store (AC-F4-1)', async () => {
    mkdirSync(join(tmpDir, 'skills', 'tdd'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'skills', 'tdd', 'SKILL.md'),
      `---\nname: tdd\ndescription: Red-Green-Refactor 测试驱动开发纪律\n---\n\n# TDD（测试驱动开发）\n\nRed-Green-Refactor cycle.`,
    );

    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();

    const builder = new GlobalIndexBuilder({
      skillsRoot: join(tmpDir, 'skills'),
      memoryRoot: '/nonexistent',
      globalStore,
    });

    const result = await builder.rebuild();
    assert.ok(result.docsIndexed >= 1, `expected >=1 indexed, got ${result.docsIndexed}`);

    const items = await globalStore.search('TDD');
    assert.ok(items.length >= 1, 'should find TDD skill');
    assert.equal(items[0].anchor, 'global:skill/tdd');
    assert.equal(items[0].kind, 'plan');

    globalStore.close();
  });

  it('indexes refs/*.md files as decisions (AC-F4-1b)', async () => {
    mkdirSync(join(tmpDir, 'skills', 'refs'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'skills', 'refs', 'shared-rules.md'),
      '# 家规（三猫共用协作规则）\n\n面向终态，不绕路。协作优先。',
    );

    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();

    const builder = new GlobalIndexBuilder({
      skillsRoot: join(tmpDir, 'skills'),
      memoryRoot: '/nonexistent',
      globalStore,
    });

    await builder.rebuild();
    const items = await globalStore.search('家规');
    assert.ok(items.length >= 1, 'should find shared-rules');
    assert.equal(items[0].anchor, 'global:ref/shared-rules');
    assert.equal(items[0].kind, 'decision');

    globalStore.close();
  });

  it('indexes MEMORY.md entries from all projects (AC-F4-2)', async () => {
    const projDir = join(tmpDir, 'projects', '-Users-test-projects-cat-cafe', 'memory');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'MEMORY.md'), '# Index\n- [redis](redis-pitfalls.md)');
    writeFileSync(
      join(projDir, 'redis-pitfalls.md'),
      `---\nname: Redis 踩坑记录\ndescription: ioredis keyPrefix 行为差异\ntype: reference\n---\n\n## ioredis keyPrefix\nkeyPrefix 在 eval 里自动加，在 keys() 里不加。`,
    );
    writeFileSync(
      join(projDir, 'feedback_testing.md'),
      `---\nname: 测试纪律\ndescription: TDD 必须先红后绿\ntype: feedback\n---\n\n先写失败测试再实现。`,
    );

    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();

    const builder = new GlobalIndexBuilder({
      skillsRoot: '/nonexistent',
      memoryRoot: join(tmpDir, 'projects'),
      globalStore,
    });

    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 2, 'should index 2 memory entries (skip MEMORY.md)');

    // reference type → kind='plan'
    const redis = await globalStore.search('keyPrefix');
    assert.ok(redis.length >= 1, 'should find redis pitfalls');
    assert.equal(redis[0].anchor, 'global:memory/Users-test-projects-cat-cafe/redis-pitfalls');
    assert.equal(redis[0].kind, 'plan');

    // feedback type → kind='lesson'
    const feedback = await globalStore.search('TDD');
    assert.ok(feedback.length >= 1, 'should find feedback entry');
    assert.equal(feedback[0].kind, 'lesson');

    globalStore.close();
  });

  it('missing skills/memory dirs degrade gracefully (AC-F4-5)', async () => {
    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();

    const builder = new GlobalIndexBuilder({
      skillsRoot: '/nonexistent/skills',
      memoryRoot: '/nonexistent/projects',
      globalStore,
    });

    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 0);
    assert.equal(result.docsSkipped, 0);

    globalStore.close();
  });

  it('KnowledgeResolver merges project + global via federation (AC-F4-4)', async () => {
    // Project store
    const projectStore = new SqliteEvidenceStore(':memory:');
    await projectStore.initialize();
    await projectStore.upsert([
      {
        anchor: 'F042',
        kind: 'feature',
        status: 'active',
        title: 'Prompt Engineering Audit',
        summary: 'Three-layer information architecture',
        updatedAt: '2026-03-31',
      },
    ]);

    // Global store with a cross-project lesson
    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();
    await globalStore.upsert([
      {
        anchor: 'global:memory/cafe/redis-pitfalls',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix 踩坑记录',
        summary: 'ioredis keyPrefix 在 eval 里自动加',
        updatedAt: '2026-03-31',
      },
    ]);

    const { KnowledgeResolver } = await import('../../dist/domains/memory/KnowledgeResolver.js');
    const resolver = new KnowledgeResolver({ projectStore, globalStore });

    // Search that hits global store
    const result = await resolver.resolve('Redis keyPrefix');
    assert.ok(result.results.length >= 1, 'should find global item');
    assert.deepEqual(result.sources, ['project', 'global']);
    const anchors = result.results.map((r) => r.anchor);
    assert.ok(anchors.includes('global:memory/cafe/redis-pitfalls'));

    projectStore.close();
    globalStore.close();
  });

  it('two projects with same tail segment produce distinct anchors (P1 fix)', async () => {
    // 砚砚复现脚本: -Users-a-proj-cat-app and -Users-b-proj-dog-app both end with "app"
    const projRoot = join(tmpDir, 'projects');
    for (const d of ['-Users-a-proj-cat-app', '-Users-b-proj-dog-app']) {
      const memDir = join(projRoot, d, 'memory');
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, 'note.md'), `---\nname: ${d} Note\ntype: reference\n---\nContent from ${d}`);
    }

    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();

    const builder = new GlobalIndexBuilder({
      skillsRoot: '/nonexistent',
      memoryRoot: projRoot,
      globalStore,
    });

    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 2, 'both projects indexed, no collision');

    // Both must be searchable
    const catHits = await globalStore.search('cat-app');
    assert.ok(catHits.length >= 1, 'cat-app project searchable');
    const dogHits = await globalStore.search('dog-app');
    assert.ok(dogHits.length >= 1, 'dog-app project searchable');

    // Anchors must be distinct
    const db = globalStore.getDb();
    const anchors = db
      .prepare('SELECT anchor FROM evidence_docs')
      .all()
      .map((r) => r.anchor);
    const noteAnchors = anchors.filter((a) => a.includes('note'));
    assert.equal(noteAnchors.length, 2, 'two distinct note anchors');
    assert.notEqual(noteAnchors[0], noteAnchors[1], 'anchors must differ');

    globalStore.close();
  });

  it('rebuild is idempotent — second run same result (AC-F4-3)', async () => {
    mkdirSync(join(tmpDir, 'skills', 'debugging'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'skills', 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Bug diagnosis workflow\n---\n# Debugging',
    );

    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();

    const builder = new GlobalIndexBuilder({
      skillsRoot: join(tmpDir, 'skills'),
      memoryRoot: '/nonexistent',
      globalStore,
    });

    const r1 = await builder.rebuild();
    const r2 = await builder.rebuild();
    assert.equal(r1.docsIndexed, r2.docsIndexed);

    const items = await globalStore.search('debugging');
    assert.ok(items.length >= 1, 'search works after double rebuild');

    globalStore.close();
  });

  it('uses file mtime for updatedAt instead of rebuild timestamp (DF-1)', async () => {
    const projDir = join(tmpDir, 'projects', '-Users-test-cat-cafe', 'memory');
    mkdirSync(projDir, { recursive: true });

    const oldFile = join(projDir, 'old_note.md');
    const newFile = join(projDir, 'new_note.md');

    writeFileSync(oldFile, '---\nname: old-note\ntype: feedback\n---\nOld note content');
    writeFileSync(newFile, '---\nname: new-note\ntype: feedback\n---\nNew note content');

    const oldDate = new Date('2026-01-15T10:00:00Z');
    const newDate = new Date('2026-05-10T14:30:00Z');
    utimesSync(oldFile, oldDate, oldDate);
    utimesSync(newFile, newDate, newDate);

    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();

    const builder = new GlobalIndexBuilder({
      skillsRoot: '/nonexistent',
      memoryRoot: join(tmpDir, 'projects'),
      globalStore,
    });

    await builder.rebuild();

    const oldItems = await globalStore.search('old note');
    const newItems = await globalStore.search('new note');
    assert.ok(oldItems.length >= 1, 'should find old note');
    assert.ok(newItems.length >= 1, 'should find new note');

    const oldUpdatedAt = oldItems[0].updatedAt;
    const newUpdatedAt = newItems[0].updatedAt;

    assert.notEqual(oldUpdatedAt, newUpdatedAt, 'files with different mtimes must have different updatedAt');
    assert.ok(
      new Date(oldUpdatedAt) < new Date(newUpdatedAt),
      `old file (${oldUpdatedAt}) should have earlier updatedAt than new file (${newUpdatedAt})`,
    );
  });

  it('W5: excludes personal memory from global input and re-layers it into the private store', async () => {
    const memoryDir = join(tmpDir, 'projects', '-Users-test-private', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, 'team_method.md'),
      '---\nname: Shared Method\ntype: reference\n---\nA reusable coordination method.',
    );
    writeFileSync(
      join(memoryDir, 'user_preferences.md'),
      '---\nname: Synthetic User Preference\ntype: user\n---\nSYNTHETIC_PRIVATE_PAYLOAD',
    );
    writeFileSync(
      join(memoryDir, 'personal_note.md'),
      '---\nname: Synthetic Personal Note\nscope: personal\n---\nSYNTHETIC_PERSONAL_PAYLOAD',
    );
    writeFileSync(
      join(memoryDir, 's8_hourly_log.md'),
      '---\nname: Synthetic Hourly Log\ntype: reference\n---\nSYNTHETIC_LEGACY_PRIVATE_PAYLOAD',
    );

    const globalStore = new SqliteEvidenceStore(':memory:');
    const personalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();
    await personalStore.initialize();

    // Seed a pre-gate leak. Rebuild must purge it before completing the private projection.
    await globalStore.upsert([
      {
        anchor: 'global:memory/Users-test-private/user_preferences',
        kind: 'lesson',
        status: 'active',
        title: 'Legacy leaked row',
        summary: 'SYNTHETIC_PRIVATE_PAYLOAD',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const builder = new GlobalIndexBuilder({
      skillsRoot: '/nonexistent',
      memoryRoot: join(tmpDir, 'projects'),
      globalStore,
      personalStore,
    });

    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 1, 'only the shared method belongs in the global compiler');
    assert.equal(result.docsSkipped, 3, 'all personal-family files are excluded from global input');
    assert.deepEqual(result.privacyAudit, {
      personalSources: 3,
      purgedFromGlobal: 1,
      reLayeredPrivate: 3,
    });

    assert.equal((await globalStore.search('SYNTHETIC_PRIVATE_PAYLOAD')).length, 0);
    assert.equal((await globalStore.search('SYNTHETIC_PERSONAL_PAYLOAD')).length, 0);
    assert.equal((await globalStore.search('SYNTHETIC_LEGACY_PRIVATE_PAYLOAD')).length, 0);
    assert.equal((await globalStore.search('reusable coordination')).length, 1);

    assert.equal((await personalStore.search('SYNTHETIC_PRIVATE_PAYLOAD')).length, 1);
    assert.equal((await personalStore.search('SYNTHETIC_PERSONAL_PAYLOAD')).length, 1);
    assert.equal((await personalStore.search('SYNTHETIC_LEGACY_PRIVATE_PAYLOAD')).length, 1);

    globalStore.close();
    personalStore.close();
  });

  it('W5: purges a legacy global leak before a private projection failure', async () => {
    const memoryDir = join(tmpDir, 'projects', '-Users-test-private-failure', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, 'user_preferences.md'),
      '---\nname: Synthetic User Preference\ntype: user\n---\nSYNTHETIC_PRIVATE_FAILURE_PAYLOAD',
    );

    const globalStore = new SqliteEvidenceStore(':memory:');
    const personalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();
    await personalStore.initialize();
    await globalStore.upsert([
      {
        anchor: 'global:memory/Users-test-private-failure/user_preferences',
        kind: 'lesson',
        status: 'active',
        title: 'Legacy leaked row',
        summary: 'SYNTHETIC_PRIVATE_FAILURE_PAYLOAD',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    personalStore.upsert = async () => {
      throw new Error('synthetic private projection failure');
    };

    const builder = new GlobalIndexBuilder({
      skillsRoot: '/nonexistent',
      memoryRoot: join(tmpDir, 'projects'),
      globalStore,
      personalStore,
    });

    await assert.rejects(builder.rebuild(), /synthetic private projection failure/);
    assert.equal((await globalStore.search('SYNTHETIC_PRIVATE_FAILURE_PAYLOAD')).length, 0);

    globalStore.close();
    personalStore.close();
  });

  it('W5: personal basenames are excluded even when frontmatter omits personal type', async () => {
    const memoryDir = join(tmpDir, 'projects', '-Users-test-private', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    for (const stem of [
      'user_identity',
      'user_preferences',
      'user_context',
      'user_relationships',
      'user_working_style',
      'user_private_notes',
      's8_hourly_log',
    ]) {
      writeFileSync(join(memoryDir, `${stem}.md`), `---\nname: ${stem}\ntype: reference\n---\nSYNTHETIC ${stem}`);
    }

    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();
    const builder = new GlobalIndexBuilder({
      skillsRoot: '/nonexistent',
      memoryRoot: join(tmpDir, 'projects'),
      globalStore,
    });

    const result = await builder.rebuild();
    assert.equal(result.docsIndexed, 0);
    assert.equal(result.docsSkipped, 7);
    assert.equal(result.privacyAudit.personalSources, 7);
    assert.equal((await globalStore.search('SYNTHETIC')).length, 0);
    globalStore.close();
  });
});
