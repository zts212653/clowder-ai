import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('SIM-Q4 restrained collection fast-path & passage lifecycle', () => {
  let CollectionIndexBuilder;
  let FlatScanner;
  let StructuredScanner;
  let SqliteEvidenceStore;
  let store;
  let dbPath;

  beforeEach(async () => {
    ({ CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js'));
    ({ FlatScanner } = await import('../../dist/domains/memory/FlatScanner.js'));
    ({ StructuredScanner } = await import('../../dist/domains/memory/StructuredScanner.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    dbPath = join(mkdtempSync(join(tmpdir(), 'sim-q4-')), 'test.sqlite');
    store = new SqliteEvidenceStore(dbPath);
    await store.initialize();
  });

  afterEach(() => {
    try {
      store?.close();
    } catch {}
    try {
      unlinkSync(dbPath);
    } catch {}
  });

  const makeManifest = (root, overrides = {}) => ({
    id: 'research:sim-q4',
    kind: 'domain',
    name: 'sim-q4',
    displayName: 'SIM Q4 Test',
    root,
    sensitivity: 'internal',
    scannerLevel: 1,
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-11-26',
    updatedAt: '2026-11-26',
    ...overrides,
  });

  it('Knife 1: FlatScanner skips horizontal rules and pure wikilink nav bars without skipping prose containing wikilinks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-q4-k1-'));
    writeFileSync(
      join(dir, 'hr-doc.md'),
      [
        '---',
        'title: HR Doc',
        '---',
        '# HR Doc',
        '',
        '> Quoted note before separator.',
        '',
        '---',
        '',
        '[[_MOC|Back to MOC]] · [[index|Index]]',
        '',
        'Real opening summary paragraph with [[inline-link|reference]] intact.',
        '',
        '## Details',
        '',
        'Second section body text.',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'prose-link.md'),
      ['# Prose Link', '', 'See [[architecture]] for the real design summary.'].join('\n'),
    );
    mkdirSync(join(dir, '.tools'), { recursive: true });
    writeFileSync(join(dir, '.tools', 'noise.md'), '# Remotion Noise\n\nNoise content.');

    const scanner = new FlatScanner('research:sim-q4', ['**/.tools/**']);
    const results = scanner.discover(dir);

    assert.equal(results.length, 2, 'collection exclude should skip .tools noise');
    const hrDoc = results.find((r) => r.item.sourcePath === 'hr-doc.md');
    const proseDoc = results.find((r) => r.item.sourcePath === 'prose-link.md');

    assert.equal(
      hrDoc?.item.summary,
      'Real opening summary paragraph with [[inline-link|reference]] intact.',
      'summary must skip --- and pure [[wikilink]] nav lines',
    );
    assert.equal(
      proseDoc?.item.summary,
      'See [[architecture]] for the real design summary.',
      'prose containing an inline wikilink must not be skipped',
    );
    assert.deepEqual(
      hrDoc?.passages,
      [],
      'FlatScanner keeps vector-tracked passages empty so external bodies stay lexical-only',
    );
    assert.ok(
      hrDoc?.rawContent.includes('Second section body text.'),
      'FlatScanner preserves full rawContent for body FTS',
    );
  });

  it('Knife 2a: default summary search rescues out-of-distribution body-only correction over superseded draft', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-q4-k2-ood-'));
    writeFileSync(
      join(dir, 'old-draft.md'),
      [
        '---',
        'title: Old Draft',
        'status: superseded',
        'superseded_by: doc/active-correction',
        '---',
        '# Old Draft',
        '',
        'This deprecated proposal uses legacy_m1a_protocol.',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'active-correction.md'),
      [
        '---',
        'title: Current Verification Ledger',
        'status: active',
        '---',
        '# Current Verification Ledger',
        '',
        'Canonical operational decisions for the repository.',
        '',
        '## Upstream Alignment',
        '',
        'Section 2 notes that legacy_m1a_protocol was withdrawn and replaced by three-sentence guidance.',
      ].join('\n'),
    );

    const manifest = makeManifest(dir);
    const builder = new CollectionIndexBuilder(store, manifest, new StructuredScanner(manifest.id));
    await builder.rebuild();

    const bodyCount = store.getDb().prepare('SELECT count(*) AS n FROM evidence_doc_bodies').get().n;
    const passageCount = store.getDb().prepare('SELECT count(*) AS n FROM evidence_passages').get().n;
    assert.equal(bodyCount, 2, `expected 1 lexical body row per doc, got ${bodyCount}`);
    assert.equal(
      passageCount,
      0,
      'external collection lexical bodies must not populate vector-tracked evidence_passages',
    );

    const results = await store.search('legacy_m1a_protocol', { limit: 5 });
    assert.ok(results.length >= 2, `expected both active and superseded docs, got ${results.map((r) => r.anchor)}`);
    assert.equal(
      results[0].anchor,
      'research:sim-q4:doc/active-correction',
      'active body correction must outrank superseded draft on default search',
    );

    // Cross-paragraph multi-term query: terms in different paragraphs still match in 1-row-per-doc body FTS
    const crossPara = await store.search('Canonical three-sentence', { limit: 5 });
    assert.deepEqual(
      crossPara.map((r) => r.anchor),
      ['research:sim-q4:doc/active-correction'],
    );

    // Negative guard: explicit historical archaeology still finds the superseded draft
    const archivedOnly = await store.search('legacy_m1a_protocol', { status: 'superseded', limit: 5 });
    assert.deepEqual(
      archivedOnly.map((r) => r.anchor),
      ['research:sim-q4:doc/old-draft'],
    );
  });

  it('Knife 2b (P2-4): in-process paired SQL spy proves fast-path touches 0 body/passage SQL while body-only fallback touches evidence_doc_body_fts', async () => {
    const memStore = new SqliteEvidenceStore(':memory:');
    await memStore.initialize();
    try {
      assert.equal(memStore.usesIsolatedProcesses(), false, 'must observe SQL inside the same process');
      const dir = mkdtempSync(join(tmpdir(), 'sim-q4-k2-fast-'));
      writeFileSync(
        join(dir, 'canonical-plan.md'),
        [
          '---',
          'title: Canonical Backlog Plan',
          'status: active',
          '---',
          '# Canonical Backlog Plan',
          '',
          'Authoritative master plan for alpha_fastpath_token.',
        ].join('\n'),
      );
      writeFileSync(
        join(dir, 'tangential-notes.md'),
        [
          '---',
          'title: Unrelated Meeting Notes',
          'status: active',
          '---',
          '# Unrelated Meeting Notes',
          '',
          'Weekly logistics.',
          '',
          '## Side Remark',
          '',
          'Mentioned alpha_fastpath_token alpha_fastpath_token and deep_only_positive_control in passing.',
        ].join('\n'),
      );

      const manifest = makeManifest(dir);
      const builder = new CollectionIndexBuilder(memStore, manifest, new StructuredScanner(manifest.id));
      await builder.rebuild();

      let deepSqlCountTotal = 0;
      const db = memStore.getDb();
      const origPrepare = db.prepare.bind(db);
      db.prepare = (sql, ...rest) => {
        if (
          typeof sql === 'string' &&
          /evidence_doc_body_fts|evidence_doc_bodies|passage_fts|evidence_passages/i.test(sql)
        ) {
          deepSqlCountTotal++;
        }
        return origPrepare(sql, ...rest);
      };

      // Positive control 1: strong Stage-1 metadata hit must execute 0 body/passage SQL queries
      const fastResults = await memStore.search('alpha_fastpath_token', { limit: 5 });
      const fastSqlCount = deepSqlCountTotal;
      assert.equal(fastSqlCount, 0, 'Stage-2 body/passage SQL must NOT execute when Stage-1 has a strong active hit');
      assert.deepEqual(
        fastResults.map((r) => r.anchor),
        ['research:sim-q4:doc/canonical-plan'],
      );

      // Positive control 2: body-only query MUST execute evidence_doc_body_fts SQL and find the target doc
      const deepResults = await memStore.search('deep_only_positive_control', { limit: 5 });
      const deepSqlCount = deepSqlCountTotal - fastSqlCount;
      assert.ok(deepSqlCount > 0, `body-only fallback must query evidence_doc_body_fts (got ${deepSqlCount})`);
      assert.deepEqual(
        deepResults.map((r) => r.anchor),
        ['research:sim-q4:doc/tangential-notes'],
      );
    } finally {
      memStore.close();
    }
  });

  it('P2-1: filtered Stage-2 fallback avoids pool starvation when >20 archived passages match the query', async () => {
    const memStore = new SqliteEvidenceStore(':memory:');
    await memStore.initialize();
    try {
      const q = 'starvation_guard_needle';
      await memStore.upsert([
        {
          anchor: 'research:sim-q4:doc/distractor',
          kind: 'research',
          status: 'archived',
          title: 'Archived Noise',
          summary: 'Unrelated overview.',
          updatedAt: '2026-11-26T03:00:00Z',
        },
        {
          anchor: 'research:sim-q4:doc/target',
          kind: 'research',
          status: 'active',
          title: 'Active Target',
          summary: 'Unrelated overview.',
          updatedAt: '2026-11-26T03:00:00Z',
        },
      ]);
      const insert = memStore
        .getDb()
        .prepare(
          'INSERT INTO evidence_passages (doc_anchor, passage_id, content, position, created_at) VALUES (?, ?, ?, ?, ?)',
        );
      for (let i = 0; i < 25; i++) {
        insert.run('research:sim-q4:doc/distractor', `md-${i}`, q, i, '2026-11-26T03:00:00Z');
      }
      insert.run('research:sim-q4:doc/target', 'md-0', `${q} ${'padding '.repeat(80)}`, 0, '2026-11-26T03:00:00Z');

      const activeOnly = await memStore.search(q, { status: 'active', limit: 1 });
      assert.deepEqual(
        activeOnly.map((r) => r.anchor),
        ['research:sim-q4:doc/target'],
        'archived distractor passages must not starve active doc in bounded pool',
      );
    } finally {
      memStore.close();
    }
  });

  it('P2-2: default summary fallback filters by parent updated_at rather than unchanged passage created_at', async () => {
    const memStore = new SqliteEvidenceStore(':memory:');
    await memStore.initialize();
    try {
      await memStore.upsert([
        {
          anchor: 'research:sim-q4:doc/updated-parent',
          kind: 'research',
          status: 'active',
          title: 'Updated Parent',
          summary: 'Summary changed today.',
          updatedAt: '2026-11-26T03:00:00Z',
        },
      ]);
      memStore
        .getDb()
        .prepare(
          'INSERT INTO evidence_passages (doc_anchor, passage_id, content, position, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          'research:sim-q4:doc/updated-parent',
          'md-0',
          'Body retains older_created_body_needle from earlier revision.',
          0,
          '2026-11-01T03:00:00Z',
        );

      const hits = await memStore.search('older_created_body_needle', { dateFrom: '2026-11-20', limit: 5 });
      assert.deepEqual(
        hits.map((r) => r.anchor),
        ['research:sim-q4:doc/updated-parent'],
        'parent updated_at within dateFrom must not be excluded by older passage created_at',
      );
    } finally {
      memStore.close();
    }
  });

  it('P2-3: weak single-term OR metadata hit does not suppress stronger all-terms body hit', async () => {
    const memStore = new SqliteEvidenceStore(':memory:');
    await memStore.initialize();
    try {
      await memStore.upsert([
        {
          anchor: 'research:sim-q4:doc/weak',
          kind: 'research',
          status: 'active',
          title: 'Weak Doc',
          summary: 'Incidental mention of weaktermalpha only.',
          updatedAt: '2026-11-26T03:00:00Z',
        },
        {
          anchor: 'research:sim-q4:doc/strong',
          kind: 'research',
          status: 'active',
          title: 'Strong Body Doc',
          summary: 'Unrelated overview.',
          updatedAt: '2026-11-26T03:00:00Z',
        },
      ]);
      memStore
        .getDb()
        .prepare(
          'INSERT INTO evidence_passages (doc_anchor, passage_id, content, position, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          'research:sim-q4:doc/strong',
          'md-0',
          'Full correction covering both weaktermalpha and weaktermbeta together.',
          0,
          '2026-11-26T03:00:00Z',
        );

      const results = await memStore.search('weaktermalpha weaktermbeta', { limit: 5 });
      assert.equal(
        results[0]?.anchor,
        'research:sim-q4:doc/strong',
        'all-terms body match must outrank single-term OR metadata hit',
      );
    } finally {
      memStore.close();
    }
  });

  it('P2-3b: already-seen partial Stage-1 candidate is promoted without duplicates when its body matches all terms', async () => {
    const memStore = new SqliteEvidenceStore(':memory:');
    await memStore.initialize();
    try {
      await memStore.upsert([
        {
          anchor: 'research:sim-q4:doc/weak-first',
          kind: 'research',
          status: 'active',
          title: 'Heading mentions seenalpha',
          summary: 'Unrelated overview without second token.',
          updatedAt: '2026-11-26T03:00:00Z',
        },
        {
          anchor: 'research:sim-q4:doc/correct',
          kind: 'research',
          status: 'active',
          title: 'Unrelated title',
          summary: 'Summary only mentions seenbeta.',
          updatedAt: '2026-11-26T03:00:00Z',
        },
      ]);
      memStore
        .getDb()
        .prepare(
          'INSERT INTO evidence_passages (doc_anchor, passage_id, content, position, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          'research:sim-q4:doc/correct',
          'md-0',
          'Authoritative body section covers seenalpha and seenbeta together.',
          0,
          '2026-11-26T03:00:00Z',
        );

      const topOne = await memStore.search('seenalpha seenbeta', { limit: 1 });
      assert.deepEqual(
        topOne.map((r) => r.anchor),
        ['research:sim-q4:doc/correct'],
        'limit=1 must promote already-seen Stage-1 candidate whose body matches all terms',
      );

      const topFive = await memStore.search('seenalpha seenbeta', { limit: 5 });
      const anchors = topFive.map((r) => r.anchor);
      assert.equal(anchors[0], 'research:sim-q4:doc/correct');
      assert.equal(new Set(anchors).size, anchors.length, 'promoted results must contain unique anchors only');
      assert.deepEqual(anchors, ['research:sim-q4:doc/correct', 'research:sim-q4:doc/weak-first']);
    } finally {
      memStore.close();
    }
  });

  it('P1-1: failed body replacement leaves source_hash incomplete so next rebuild retries and recovers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-q4-p1-retry-'));
    const file = join(dir, 'policy.md');
    const makeDoc = (word) => `# Policy\n\nStable overview.\n\n## Rule\n\n${word}\n`;
    writeFileSync(file, makeDoc('atomic_old_claim'));

    const manifest = makeManifest(dir);
    const builder = new CollectionIndexBuilder(store, manifest, new StructuredScanner(manifest.id));
    await builder.rebuild();

    const updatedText = makeDoc('atomic_new_claim');
    writeFileSync(file, updatedText);
    store
      .getDb()
      .exec(
        "CREATE TRIGGER fail_new_body BEFORE UPDATE ON evidence_doc_bodies WHEN new.content LIKE '%atomic_new_claim%' BEGIN SELECT RAISE(ABORT, 'injected body failure'); END",
      );

    await assert.rejects(() => builder.rebuild(), /injected body failure/);
    store.getDb().exec('DROP TRIGGER fail_new_body');

    const incompleteDoc = await store.getByAnchor('research:sim-q4:doc/policy');
    assert.notEqual(
      incompleteDoc?.sourceHash,
      createHash('sha256').update(updatedText).digest('hex'),
      'source_hash must not claim completion when body replacement failed',
    );

    const retry = await builder.rebuild();
    assert.equal(retry.indexed, 1, 'next rebuild must retry and re-index incomplete document');
    assert.equal(retry.skipped, 0);
    assert.deepEqual(await store.search('atomic_old_claim', { limit: 5 }), []);
    const recovered = await store.search('atomic_new_claim', { limit: 5 });
    assert.deepEqual(
      recovered.map((r) => r.anchor),
      ['research:sim-q4:doc/policy'],
    );
  });

  it('P1-2: incrementalUpdate enforces SecretScanner fail-closed gate before persisting lexical bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-q4-p1-secret-'));
    const file = join(dir, 'policy.md');
    writeFileSync(file, '# Policy\n\nStable overview.\n\n## Rule\n\nSafe body text.\n');

    const manifest = makeManifest(dir);
    const builder = new CollectionIndexBuilder(store, manifest, new StructuredScanner(manifest.id));
    await builder.rebuild();

    // Synthetic PEM header marker only (not a real key), placed in body below summary
    writeFileSync(
      file,
      '# Policy\n\nStable overview.\n\n## Rule\n\n-----BEGIN PRIVATE KEY-----\nsynthetic_incremental_secret_marker\n',
    );

    await assert.rejects(() => builder.incrementalUpdate([file]), /blocked by SecretScanner/);

    const leakedBodies = store
      .getDb()
      .prepare(
        "SELECT count(*) AS n FROM evidence_doc_bodies WHERE content LIKE '%synthetic_incremental_secret_marker%'",
      )
      .get().n;
    assert.equal(leakedBodies, 0, 'blocked incrementalUpdate must not persist secret bodies');
    assert.deepEqual(await store.search('synthetic_incremental_secret_marker', { limit: 5 }), []);
    assert.equal(
      await store.getByAnchor('research:sim-q4:doc/policy'),
      null,
      'fail-closed secret gate must purge collection entries consistently with rebuild()',
    );
  });

  it('External collection body lifecycle: edit via incrementalUpdate and delete via rebuild invalidate doc and body indexes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-q4-lifecycle-'));
    const file = join(dir, 'living-policy.md');
    writeFileSync(
      file,
      [
        '---',
        'title: Living Policy',
        'status: active',
        '---',
        '# Living Policy',
        '',
        'Current working policy.',
        '',
        '## Budget Rule',
        '',
        'Old rule: legacy_budget_claim_71pct applies to every run.',
      ].join('\n'),
    );

    const manifest = makeManifest(dir);
    const builder = new CollectionIndexBuilder(store, manifest, new StructuredScanner(manifest.id));
    await builder.rebuild();

    const before = await store.search('legacy_budget_claim_71pct', { limit: 5 });
    assert.equal(before.length, 1);
    assert.equal(before[0].anchor, 'research:sim-q4:doc/living-policy');

    writeFileSync(
      file,
      [
        '---',
        'title: Living Policy',
        'status: active',
        '---',
        '# Living Policy',
        '',
        'Current working policy.',
        '',
        '## Budget Rule',
        '',
        'Corrected rule: verified_budget_claim_v2 replaces the retracted estimate.',
      ].join('\n'),
    );
    await builder.incrementalUpdate([file]);

    assert.deepEqual(
      await store.search('legacy_budget_claim_71pct', { limit: 5 }),
      [],
      'corrected old body text must not survive incrementalUpdate',
    );
    const freshAfterEdit = await store.search('verified_budget_claim_v2', { limit: 5 });
    assert.deepEqual(
      freshAfterEdit.map((r) => r.anchor),
      ['research:sim-q4:doc/living-policy'],
    );

    unlinkSync(file);
    await builder.rebuild();

    assert.deepEqual(await store.search('verified_budget_claim_v2', { limit: 5 }), []);
    assert.deepEqual(await store.search('verified_budget_claim_v2', { depth: 'raw', limit: 5 }), []);
    const remainingBodies = store
      .getDb()
      .prepare('SELECT count(*) AS n FROM evidence_doc_bodies WHERE doc_anchor = ?')
      .get('research:sim-q4:doc/living-policy').n;
    assert.equal(remainingBodies, 0, 'removed external document must leave 0 orphan bodies');
  });

  it('V85 P2-1: cross-lane merge prioritizes active passage correction over superseded body hit at limit=1 with unique anchors', async () => {
    const memStore = new SqliteEvidenceStore(':memory:');
    await memStore.initialize();
    try {
      const stamp = '2026-11-26T08:00:00Z';
      await memStore.upsert([
        {
          anchor: 'research:sim-q4:doc/old-body',
          kind: 'research',
          status: 'superseded',
          title: 'Old Body Draft',
          summary: 'Neutral overview.',
          updatedAt: stamp,
        },
        {
          anchor: 'research:sim-q4:doc/current-passage',
          kind: 'research',
          status: 'active',
          title: 'Current Passage Correction',
          summary: 'Neutral overview.',
          updatedAt: stamp,
        },
      ]);
      const db = memStore.getDb();
      db.prepare('INSERT INTO evidence_doc_bodies (doc_anchor, content, updated_at) VALUES (?, ?, ?)').run(
        'research:sim-q4:doc/old-body',
        'cross_lane_priority_token appears in superseded external body.',
        stamp,
      );
      db.prepare(
        'INSERT INTO evidence_passages (doc_anchor, passage_id, content, position, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        'research:sim-q4:doc/current-passage',
        'md-0',
        'cross_lane_priority_token appears in active main-store passage.',
        0,
        stamp,
      );

      const topOne = await memStore.search('cross_lane_priority_token', { limit: 1 });
      assert.deepEqual(
        topOne.map((r) => r.anchor),
        ['research:sim-q4:doc/current-passage'],
        'limit=1 must not let a superseded body hit hide an active passage correction',
      );

      const topFive = await memStore.search('cross_lane_priority_token', { limit: 5 });
      const anchors = topFive.map((r) => r.anchor);
      assert.equal(anchors[0], 'research:sim-q4:doc/current-passage');
      assert.equal(new Set(anchors).size, anchors.length, 'cross-lane merged results must have unique anchors');
      assert.deepEqual(anchors, ['research:sim-q4:doc/current-passage', 'research:sim-q4:doc/old-body']);
    } finally {
      memStore.close();
    }
  });

  it('V85 P2-2: authoritative body retires legacy md-* passages and vectors on update or unchanged rebuild while preserving thread passages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-q4-v85-legacy-md-'));
    const file = join(dir, 'policy.md');
    const stamp = '2026-11-26T08:00:00Z';
    const anchor = 'research:sim-q4:doc/policy';
    const manifest = makeManifest(dir);
    const builder = new CollectionIndexBuilder(store, manifest, new StructuredScanner(manifest.id));
    const { openVectorGeneration } = await import('../../dist/domains/memory/open-vector-generation.js');
    const { passageVectorKey } = await import('../../dist/domains/memory/PassageVectorStore.js');

    writeFileSync(file, '# Policy\n\nNeutral summary.\n\n## Details\n\nretracted_legacy_v1\n');
    await builder.rebuild();

    // Seed an unrelated thread message passage that must NEVER be touched
    await store.upsert([
      {
        anchor: 'thread-keep',
        kind: 'thread',
        status: 'active',
        title: 'Unrelated Thread',
        summary: 'Thread summary.',
        updatedAt: stamp,
      },
    ]);
    const db = store.getDb();
    db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('thread-keep', 'msg-1', 'thread_message_must_survive', 'user', 0, stamp);

    // Simulate a lingering pre-V85 md-0 passage + passage vector on the external doc
    const backend = openVectorGeneration(
      db,
      { modelId: 'fixture', modelRev: '1', dim: 4, generationId: 'g0' },
      { create: true },
    );
    db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, position, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(anchor, 'md-0', 'retracted_legacy_v1 lingering_pre_v85_only', 0, stamp);
    backend.passageVectorStore.upsert(passageVectorKey(anchor, 'md-0'), new Float32Array([1, 0, 0, 0]));

    // Read-side authority fence: even BEFORE rebuild, default summary search excludes md-* superseded by evidence_doc_bodies
    assert.deepEqual(
      await store.search('lingering_pre_v85_only', { limit: 5 }),
      [],
      'read-side fence must ignore legacy md-* terms absent from authoritative evidence_doc_bodies',
    );

    // Ordinary rebuild with unchanged file hash must NOT skip while legacy md-* still exists
    const cleanupRebuild = await builder.rebuild();
    assert.equal(cleanupRebuild.indexed, 1, 'ordinary rebuild must retire lingering md-* even when hash matches');
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM evidence_passages WHERE doc_anchor = ? AND passage_id LIKE 'md-%'")
        .get(anchor).n,
      0,
    );
    assert.equal(backend.passageVectorStore.count(), 0, 'derived legacy md-* passage vector must be invalidated');
    assert.deepEqual(await store.search('lingering_pre_v85_only', { depth: 'raw', limit: 5 }), []);

    // Second rebuild skips cleanly once legacy md-* is retired
    const secondRebuild = await builder.rebuild();
    assert.deepEqual([secondRebuild.indexed, secondRebuild.skipped], [0, 1]);

    // Update file to v2 with another pre-existing md-0 seeded: refresh must retire old md-0 so v1 never revives
    db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, position, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(anchor, 'md-0', 'retracted_legacy_v1', 0, stamp);
    writeFileSync(file, '# Policy\n\nNeutral summary.\n\n## Details\n\nverified_policy_v2\n');
    await builder.rebuild();

    assert.deepEqual(
      (await store.search('verified_policy_v2', { limit: 5 })).map((r) => r.anchor),
      [anchor],
    );
    assert.deepEqual(await store.search('retracted_legacy_v1', { limit: 5 }), []);
    assert.deepEqual(await store.search('retracted_legacy_v1', { depth: 'raw', limit: 5 }), []);

    // Unrelated thread message passage must remain intact
    const survivingThread = db
      .prepare("SELECT count(*) AS n FROM evidence_passages WHERE doc_anchor = 'thread-keep' AND passage_id = 'msg-1'")
      .get().n;
    assert.equal(survivingThread, 1, 'thread message passages must never be deleted');
  });
});
