import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('SIM-Q4 restrained collection fast-path & cross-lane invalidation', () => {
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
    assert.ok((hrDoc?.passages.length ?? 0) >= 2, 'FlatScanner should emit markdown document passages');
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
    // Out-of-distribution normal doc: NO hand-stuffed topics, NO mention in title/summary —
    // correction appears ONLY in body Section 2.
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
    const scanner = new StructuredScanner(manifest.id);
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    await builder.rebuild();

    // Verify passages were persisted
    const passageCount = store.getDb().prepare('SELECT count(*) AS n FROM evidence_passages').get().n;
    assert.ok(passageCount >= 2, `expected persisted passages, got ${passageCount}`);

    // Default depth='summary' search (no depth:'raw'!) must find active correction ahead of superseded draft
    const results = await store.search('legacy_m1a_protocol', { limit: 5 });
    assert.ok(results.length >= 2, `expected both active and superseded docs, got ${results.map((r) => r.anchor)}`);
    assert.equal(
      results[0].anchor,
      'research:sim-q4:doc/active-correction',
      'active body correction must outrank superseded draft on default search',
    );

    // Negative guard: explicit historical archaeology still finds the superseded draft
    const archivedOnly = await store.search('legacy_m1a_protocol', { status: 'superseded', limit: 5 });
    assert.deepEqual(
      archivedOnly.map((r) => r.anchor),
      ['research:sim-q4:doc/old-draft'],
    );
  });

  it('Knife 2b: fast-path protection does not invoke passage fallback or perturb ranking when Stage-1 has active hits', async () => {
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
        'Mentioned alpha_fastpath_token alpha_fastpath_token alpha_fastpath_token in passing.',
      ].join('\n'),
    );

    const manifest = makeManifest(dir);
    const builder = new CollectionIndexBuilder(store, manifest, new StructuredScanner(manifest.id));
    await builder.rebuild();

    let passageCalls = 0;
    const origSearchPassages = store.searchPassages.bind(store);
    store.searchPassages = (...args) => {
      passageCalls++;
      return origSearchPassages(...args);
    };

    const results = await store.search('alpha_fastpath_token', { limit: 5 });
    assert.equal(passageCalls, 0, 'Stage-2 passage search must NOT run when Stage-1 already found an active hit');
    assert.deepEqual(
      results.map((r) => r.anchor),
      ['research:sim-q4:doc/canonical-plan'],
    );
  });

  it('Knife 2c: zero-hit Stage-1 falls back to native FTS5 passages while respecting scope and status filters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-q4-k2-zero-'));
    writeFileSync(
      join(dir, 'deep-active.md'),
      [
        '---',
        'title: Deep Active Guide',
        'status: active',
        '---',
        '# Deep Active Guide',
        '',
        'High-level overview.',
        '',
        '## Deep Section',
        '',
        'Unique deep phrase obsidian_backfill_needle lives only in section two.',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'deep-archived.md'),
      [
        '---',
        'title: Deep Archived Guide',
        'status: archived',
        '---',
        '# Deep Archived Guide',
        '',
        'Old overview.',
        '',
        '## Deep Section',
        '',
        'Archived copy also mentions obsidian_backfill_needle.',
      ].join('\n'),
    );

    const manifest = makeManifest(dir);
    const builder = new CollectionIndexBuilder(store, manifest, new StructuredScanner(manifest.id));
    await builder.rebuild();

    const activeOnly = await store.search('obsidian_backfill_needle', { status: 'active', limit: 5 });
    assert.deepEqual(
      activeOnly.map((r) => r.anchor),
      ['research:sim-q4:doc/deep-active'],
    );
  });

  it('Knife 3 (G6-4): cross-lane correction and forgetting immediately invalidate both doc and passage indexes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-q4-g64-'));
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

    // Before correction: body-only old claim is discoverable via default search
    const before = await store.search('legacy_budget_claim_71pct', { limit: 5 });
    assert.equal(before.length, 1);
    assert.equal(before[0].anchor, 'research:sim-q4:doc/living-policy');

    // Step A: Edit/correct file via incrementalUpdate -> old body claim must disappear immediately
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

    const staleAfterEdit = await store.search('legacy_budget_claim_71pct', { limit: 5 });
    assert.deepEqual(staleAfterEdit, [], 'corrected old passage text must not survive incrementalUpdate');
    const freshAfterEdit = await store.search('verified_budget_claim_v2', { limit: 5 });
    assert.equal(freshAfterEdit.length, 1);
    assert.equal(freshAfterEdit[0].anchor, 'research:sim-q4:doc/living-policy');

    // Step B: Forget/delete file and rebuild -> both doc and passage indexes must be completely empty
    unlinkSync(file);
    await builder.rebuild();

    const afterDeleteSummary = await store.search('verified_budget_claim_v2', { limit: 5 });
    const afterDeleteRaw = await store.search('verified_budget_claim_v2', { depth: 'raw', limit: 5 });
    assert.deepEqual(afterDeleteSummary, []);
    assert.deepEqual(afterDeleteRaw, []);
    const remainingPassages = store
      .getDb()
      .prepare('SELECT count(*) AS n FROM evidence_passages WHERE doc_anchor = ?')
      .get('research:sim-q4:doc/living-policy').n;
    assert.equal(remainingPassages, 0, 'forgotten document must leave 0 orphan passages');
  });
});
