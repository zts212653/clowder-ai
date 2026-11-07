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

  it('F314-18: legal YAML spellings of a personal marker stay out of the global store', async () => {
    const memoryDir = join(tmpDir, 'projects', '-Users-test-yaml-variants', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    // Neutral basenames: only the header can make these private.
    const personal = {
      'probe-crlf.md': '---\r\nname: CRLF\r\nscope: personal\r\n---\r\nSYNTHETIC_CRLF_PAYLOAD',
      'probe-double-quoted.md': '---\nname: Double quoted\nscope: "personal"\n---\nSYNTHETIC_DQ_PAYLOAD',
      'probe-type-user.md': '---\nname: Quoted user type\ntype: "user"\n---\nSYNTHETIC_TYPE_PAYLOAD',
      'probe-single-quoted.md': "---\nname: Single quoted\nsensitivity: 'Private'\n---\nSYNTHETIC_SQ_PAYLOAD",
      'probe-bom.md': '﻿---\nname: BOM\nscope: personal\n---\nSYNTHETIC_BOM_PAYLOAD',
      'probe-list.md': '---\nname: List\nscope: [personal]\n---\nSYNTHETIC_LIST_PAYLOAD',
      // Not valid YAML (unquoted ": " in a plain scalar); the marker must still count.
      'probe-broken.md':
        '---\nname: Broken\nmemo: Note: colon inside\nscope: "personal"\n---\nSYNTHETIC_BROKEN_PAYLOAD',
      // Review of #6457: the same broken field next to other legal spellings of the marker.
      'probe-broken-comment.md':
        '---\nname: Synthetic review\nmemo: Note: colon inside\nscope: personal # keep private\n---\nSYNTHETIC_RVCOMMENT_PAYLOAD',
      'probe-broken-flow-list.md':
        '---\nname: Synthetic review\nmemo: Note: colon inside\nscope: [personal]\n---\nSYNTHETIC_RVFLOW_PAYLOAD',
      'probe-broken-block-list.md':
        '---\nname: Synthetic review\nmemo: Note: colon inside\nscope:\n  - personal\n---\nSYNTHETIC_RVBLOCK_PAYLOAD',
      'probe-broken-quoted-key.md':
        '---\nname: Synthetic review\nmemo: Note: colon inside\n"scope": "personal"\n---\nSYNTHETIC_RVQKEY_PAYLOAD',
      // Re-review: whole-document context (an alias to an earlier anchor, an explicit `? key` entry).
      'probe-broken-anchor.md':
        '---\nname: Synthetic review\nclassification: &privacy personal\nmemo: Note: colon inside\nscope: *privacy\n---\nSYNTHETIC_RVANCHOR_PAYLOAD',
      'probe-broken-explicit-key.md':
        '---\nname: Synthetic review\nmemo: Note: colon inside\n? scope\n: personal\n---\nSYNTHETIC_RVEXPLICIT_PAYLOAD',
      // A privacy field whose value cannot be read stays personal rather than leaking.
      'probe-broken-unresolved.md':
        '---\nname: Synthetic review\nmemo: Note: colon inside\nscope: *missing\n---\nSYNTHETIC_RVUNRESOLVED_PAYLOAD',
      'probe-broken-marker-itself.md':
        '---\nname: Synthetic review\nscope: personal: oops\n---\nSYNTHETIC_RVUNREADABLE_PAYLOAD',
      // Valid YAML, but a privacy value that is neither text nor a flat list of text.
      'probe-nested-list.md': '---\nname: Synthetic review\nscope: [[personal]]\n---\nSYNTHETIC_RVNESTED_PAYLOAD',
    };
    for (const [file, content] of Object.entries(personal)) writeFileSync(join(memoryDir, file), content);
    writeFileSync(
      join(memoryDir, 'probe-shared.md'),
      '---\r\nname: "Shared CRLF Method"\r\ntype: reference\r\n---\r\nSYNTHETIC_SHARED_PAYLOAD',
    );
    // A broken header is not private by itself: without a marker it stays shared.
    writeFileSync(
      join(memoryDir, 'probe-shared-broken.md'),
      '---\nname: Shared broken memo\nmemo: Note: colon inside\ntype: reference\n---\nSYNTHETIC_SHAREDBROKEN_PAYLOAD',
    );
    writeFileSync(
      join(memoryDir, 'probe-shared-broken-scope.md'),
      '---\nname: Shared broken scope\nmemo: Note: colon inside\nscope: team\n---\nSYNTHETIC_SHAREDSCOPE_PAYLOAD',
    );
    writeFileSync(
      join(memoryDir, 'probe-shared-scope-list.md'),
      '---\nname: Shared scope list\nscope: [team, shared]\n---\nSYNTHETIC_SHAREDLIST_PAYLOAD',
    );

    const globalStore = new SqliteEvidenceStore(':memory:');
    const personalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();
    await personalStore.initialize();
    const builder = new GlobalIndexBuilder({
      skillsRoot: '/nonexistent',
      memoryRoot: join(tmpDir, 'projects'),
      globalStore,
      personalStore,
    });

    const result = await builder.rebuild();
    assert.equal(result.privacyAudit.personalSources, Object.keys(personal).length);
    for (const payload of [
      'CRLF',
      'DQ',
      'TYPE',
      'SQ',
      'BOM',
      'LIST',
      'BROKEN',
      'RVCOMMENT',
      'RVFLOW',
      'RVBLOCK',
      'RVQKEY',
      'RVANCHOR',
      'RVEXPLICIT',
      'RVUNRESOLVED',
      'RVUNREADABLE',
      'RVNESTED',
    ]) {
      const marker = `SYNTHETIC_${payload}_PAYLOAD`;
      assert.equal((await globalStore.search(marker)).length, 0, `${marker} leaked into the global store`);
      assert.equal((await personalStore.search(marker)).length, 1, `${marker} missing from the personal store`);
    }
    const shared = await globalStore.search('SYNTHETIC_SHARED_PAYLOAD');
    assert.equal(shared.length, 1);
    assert.equal(shared[0].title, 'Shared CRLF Method');
    const sharedBroken = await globalStore.search('SYNTHETIC_SHAREDBROKEN_PAYLOAD');
    assert.equal(sharedBroken.length, 1);
    assert.equal(sharedBroken[0].title, 'Shared broken memo');
    assert.equal((await personalStore.search('SYNTHETIC_SHAREDBROKEN_PAYLOAD')).length, 0);
    assert.equal((await globalStore.search('SYNTHETIC_SHAREDSCOPE_PAYLOAD')).length, 1);
    assert.equal((await personalStore.search('SYNTHETIC_SHAREDSCOPE_PAYLOAD')).length, 0);
    assert.equal((await globalStore.search('SYNTHETIC_SHAREDLIST_PAYLOAD')).length, 1);
    assert.equal((await personalStore.search('SYNTHETIC_SHAREDLIST_PAYLOAD')).length, 0);

    globalStore.close();
    personalStore.close();
  });
  it('F314-18: a privacy list that refers to itself neither aborts the rebuild nor keeps the old global row', async () => {
    const memoryDir = join(tmpDir, 'projects', '-Users-test-cyclic-scope', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const file = join(memoryDir, 'neutral-probe.md');
    const globalStore = new SqliteEvidenceStore(':memory:');
    const personalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();
    await personalStore.initialize();
    const builder = new GlobalIndexBuilder({
      skillsRoot: '/nonexistent',
      memoryRoot: join(tmpDir, 'projects'),
      globalStore,
      personalStore,
    });

    // Review of #6457: the alias makes the list's first item the list itself.
    for (const header of [
      'scope: &s [*s, personal]',
      'scope: &s [personal, *s]',
      'memo: Note: colon inside\nscope: &s [*s, personal]',
    ]) {
      writeFileSync(file, '---\nname: Synthetic review\ntype: reference\n---\nSYNTHETIC_CYCLE_PAYLOAD');
      await builder.rebuild();
      assert.equal((await globalStore.search('SYNTHETIC_CYCLE_PAYLOAD')).length, 1, 'starts as a shared row');

      writeFileSync(file, `---\nname: Synthetic review\n${header}\n---\nSYNTHETIC_CYCLE_PAYLOAD`);
      await builder.rebuild();
      assert.equal((await globalStore.search('SYNTHETIC_CYCLE_PAYLOAD')).length, 0, `${header}: old global row kept`);
      assert.equal((await personalStore.search('SYNTHETIC_CYCLE_PAYLOAD')).length, 1, `${header}: not personal`);
    }

    globalStore.close();
    personalStore.close();
  });
});
