import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { profileUserRelativePath } from '@cat-cafe/shared/profile-contract';
import Database from 'better-sqlite3';

describe('SIM-Q4 narrowed slice — summary fidelity & external-only document body storage', () => {
  let CollectionIndexBuilder;
  let CollectionSecretRejectionError;
  let FlatScanner;
  let LibraryCatalog;
  let MarkerQueue;
  let MaterializationService;
  let SqliteEvidenceStore;
  let BUILTIN_COLLECTION_IDS;
  let isExternalCollectionForBodyStorage;
  let registerPrivateAndExternalCollections;
  let refreshCanonicalProfileIndex;
  let saveExternalCollection;
  let CURRENT_SCHEMA_VERSION;
  let store;
  let dbPath;
  let tempDirs;

  const makeTempDir = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  beforeEach(async () => {
    tempDirs = [];
    ({ CollectionIndexBuilder, CollectionSecretRejectionError } = await import(
      '../../dist/domains/memory/CollectionIndexBuilder.js'
    ));
    ({ FlatScanner } = await import('../../dist/domains/memory/FlatScanner.js'));
    ({ LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js'));
    ({ MarkerQueue } = await import('../../dist/domains/memory/MarkerQueue.js'));
    ({ MaterializationService } = await import('../../dist/domains/memory/MaterializationService.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    ({ BUILTIN_COLLECTION_IDS, isExternalCollectionForBodyStorage, saveExternalCollection } = await import(
      '../../dist/domains/memory/external-collections.js'
    ));
    ({ registerPrivateAndExternalCollections, refreshCanonicalProfileIndex } = await import(
      '../../dist/domains/memory/private-collection-bindings.js'
    ));
    ({ CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js'));
    dbPath = join(makeTempDir('sim-q4-'), 'test.sqlite');
    store = new SqliteEvidenceStore(dbPath);
    await store.initialize();
  });

  afterEach(() => {
    try {
      store?.close();
    } catch {}
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  const makeManifest = (root, overrides = {}) => ({
    id: 'research:sim-q4',
    kind: 'research',
    name: 'sim-q4',
    displayName: 'SIM Q4 Test',
    root,
    sensitivity: 'internal',
    scannerLevel: 0,
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-11-26',
    updatedAt: '2026-11-26',
    ...overrides,
  });

  const queryBodyFtsAnchors = (db, matchExpr) =>
    db
      .prepare(
        `SELECT b.doc_anchor AS anchor
         FROM evidence_doc_body_fts f
         JOIN evidence_doc_bodies b ON b.rowid = f.rowid
         WHERE evidence_doc_body_fts MATCH ?`,
      )
      .all(matchExpr)
      .map((row) => row.anchor);

  it('Summary fidelity: FlatScanner skips --- separators and pure wikilink nav bars while preserving inline-link prose and collection excludes', () => {
    const dir = makeTempDir('sim-q4-summary-');
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
    writeFileSync(join(dir, '.tools', 'noise.md'), '# Tool Noise\n\nNoise content.');

    const scannerWithExclude = new FlatScanner('research:sim-q4', ['**/.tools/**']);
    const results = scannerWithExclude.discover(dir);

    assert.equal(results.length, 2, 'collection exclude config should skip .tools noise');
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

    // .tools exclusion stays in collection exclude config rather than hardcoded in FlatScanner.
    const scannerWithoutExclude = new FlatScanner('research:sim-q4');
    const unfiltered = scannerWithoutExclude.discover(dir);
    assert.equal(unfiltered.length, 3, 'FlatScanner must not hardcode .tools exclusion globally');
  });

  it('Scope boundary: CollectionIndexBuilder defaults storeDocumentBodies=false so generic & profile callers never persist full bodies', async () => {
    const dir = makeTempDir('sim-q4-default-off-');
    const file = join(dir, 'note.md');
    writeFileSync(file, '# Private Note\n\nShort summary.\n\n## Hidden Body\n\nbody_only_generic_token_991.\n');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner(manifest.id);
    const builder = new CollectionIndexBuilder(store, manifest, scanner);

    const rebuilt = await builder.rebuild();
    assert.equal(rebuilt.blocked, false);
    assert.equal(rebuilt.indexed, 1);

    const db = store.getDb();
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM evidence_doc_bodies').get().n,
      0,
      'default CollectionIndexBuilder.rebuild must not write evidence_doc_bodies',
    );

    writeFileSync(file, '# Private Note\n\nUpdated summary.\n\n## Hidden Body\n\nbody_only_generic_token_992.\n');
    await builder.incrementalUpdate([file]);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM evidence_doc_bodies').get().n,
      0,
      'default CollectionIndexBuilder.incrementalUpdate must not write evidence_doc_bodies',
    );
  });

  it('Scope boundary: domain:user-profile stays excluded from evidence_doc_bodies while external collections opt in cleanly', async () => {
    const dataDir = makeTempDir('sim-q4-data-');
    const userId = 'user-profile-scope-test';
    const profileDir = join(dataDir, ...profileUserRelativePath(userId).split('/'));
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'profile.md'),
      '# User Profile\n\nSummary line.\n\n## Private Details\n\nprofile_full_body_secret_sentinel.\n',
    );

    const extRoot = makeTempDir('sim-q4-ext-');
    writeFileSync(
      join(extRoot, 'guide.md'),
      '# External Guide\n\nExternal summary.\n\n## Deep Section\n\nexternal_body_sentinel_774.\n',
    );
    const extManifest = makeManifest(extRoot, {
      id: 'research:ext-body-only',
      name: 'ext-body-only',
      indexPolicy: { autoRebuild: true },
    });
    saveExternalCollection(dataDir, extManifest);

    assert.equal(isExternalCollectionForBodyStorage({ id: 'domain:user-profile' }, dataDir), false);
    assert.equal(isExternalCollectionForBodyStorage({ id: 'project:cat-cafe' }, dataDir), false);
    assert.equal(isExternalCollectionForBodyStorage({ id: 'global:methods' }, dataDir), false);
    assert.equal(isExternalCollectionForBodyStorage({ id: 'domain:personal-memory' }, dataDir), false);
    assert.equal(isExternalCollectionForBodyStorage({ id: 'research:not-persisted' }, dataDir), false);
    assert.equal(isExternalCollectionForBodyStorage(extManifest, undefined), false);
    assert.equal(isExternalCollectionForBodyStorage(extManifest, dataDir), true);
    assert.ok(BUILTIN_COLLECTION_IDS.has('domain:user-profile'));

    const catalog = new LibraryCatalog();
    const stores = new Map();
    await registerPrivateAndExternalCollections({
      catalog,
      stores,
      externalManifests: [extManifest],
      dataDir,
      privateUserId: userId,
      now: '2026-11-26T00:00:00Z',
    });

    try {
      const profileStore = stores.get('domain:user-profile');
      assert.ok(profileStore, 'canonical profile collection should register');
      assert.equal(
        profileStore.getDb().prepare('SELECT count(*) AS n FROM evidence_doc_bodies').get().n,
        0,
        'registerCanonicalProfile must not write full bodies into evidence_doc_bodies',
      );

      writeFileSync(
        join(profileDir, 'profile.md'),
        '# User Profile\n\nRefreshed summary.\n\n## Private Details\n\nprofile_refreshed_body_sentinel.\n',
      );
      const refreshed = await refreshCanonicalProfileIndex(stores, catalog, { dataDir, userId });
      assert.equal(refreshed.status, 'refreshed');
      assert.equal(
        profileStore.getDb().prepare('SELECT count(*) AS n FROM evidence_doc_bodies').get().n,
        0,
        'refreshCanonicalProfileIndex must not write full bodies into evidence_doc_bodies',
      );

      const extStore = stores.get(extManifest.id);
      assert.ok(extStore, 'external collection should register');
      const extDb = extStore.getDb();
      assert.deepEqual(
        queryBodyFtsAnchors(extDb, 'external_body_sentinel_774'),
        [`${extManifest.id}:doc/guide`],
        'external collection startup autoRebuild must populate evidence_doc_bodies and FTS5',
      );
      assert.equal(
        extDb.prepare('SELECT count(*) AS n FROM evidence_passages').get().n,
        0,
        'external body storage must stay decoupled from vector-tracked evidence_passages',
      );
    } finally {
      for (const s of stores.values()) {
        try {
          s.close();
        } catch {}
      }
    }
  });

  it('Storage lifecycle: full rebuild, incremental update, empty-body clear, delete/purge, and default summary search isolation', async () => {
    const dir = makeTempDir('sim-q4-lifecycle-');
    const fileA = join(dir, 'alpha.md');
    const fileB = join(dir, 'beta.md');
    const contentA = [
      '---',
      'title: Alpha Doc',
      '---',
      '# Alpha Doc',
      '',
      'Alpha summary only.',
      '',
      '## Body',
      '',
      'alpha_body_token_v1 unique_phrase_one.',
    ].join('\n');
    writeFileSync(fileA, contentA);
    writeFileSync(fileB, '# Beta Doc\n\nBeta summary.\n\n## Body\n\nbeta_body_token_v1.\n');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner(manifest.id);
    const builder = new CollectionIndexBuilder(store, manifest, scanner, undefined, {
      storeDocumentBodies: true,
    });

    const first = await builder.rebuild();
    assert.equal(first.blocked, false);
    assert.equal(first.indexed, 2);
    assert.equal(first.skipped, 0);

    const db = store.getDb();
    const anchorA = `${manifest.id}:doc/alpha`;
    const anchorB = `${manifest.id}:doc/beta`;
    const bodyRowA = db.prepare('SELECT content FROM evidence_doc_bodies WHERE doc_anchor = ?').get(anchorA);
    assert.ok(bodyRowA?.content.includes('alpha_body_token_v1'));
    assert.ok(!bodyRowA?.content.includes('title: Alpha Doc'), 'YAML frontmatter should be stripped from stored body');
    assert.deepEqual(queryBodyFtsAnchors(db, 'alpha_body_token_v1'), [anchorA]);
    assert.deepEqual(queryBodyFtsAnchors(db, 'beta_body_token_v1'), [anchorB]);

    const docA = await store.getByAnchor(anchorA);
    assert.equal(docA?.sourceHash, createHash('sha256').update(contentA).digest('hex'));

    // Default summary search must NOT silently fall back into evidence_doc_bodies in this narrow slice.
    const defaultSummarySearch = await store.search('alpha_body_token_v1');
    assert.equal(
      defaultSummarySearch.length,
      0,
      'narrow storage slice must not add default summary search body fallback or reranking',
    );

    // Second non-force rebuild skips unchanged docs when body and source_hash are consistent.
    const second = await builder.rebuild();
    assert.equal(second.indexed, 0);
    assert.equal(second.skipped, 2);

    // Incremental update replaces stored body + FTS5 cleanly.
    const updatedContentA = '# Alpha Doc\n\nAlpha summary only.\n\n## Body\n\nalpha_body_token_v2.\n';
    writeFileSync(fileA, updatedContentA);
    await builder.incrementalUpdate([fileA]);
    assert.deepEqual(queryBodyFtsAnchors(db, 'alpha_body_token_v1'), []);
    assert.deepEqual(queryBodyFtsAnchors(db, 'alpha_body_token_v2'), [anchorA]);
    assert.equal(
      (await store.getByAnchor(anchorA))?.sourceHash,
      createHash('sha256').update(updatedContentA).digest('hex'),
    );

    // Clearing body content to frontmatter-only deletes the stale evidence_doc_bodies row + FTS entry.
    writeFileSync(fileA, '---\ntitle: Alpha Doc\n---\n');
    await builder.incrementalUpdate([fileA]);
    assert.equal(db.prepare('SELECT content FROM evidence_doc_bodies WHERE doc_anchor = ?').get(anchorA), undefined);
    assert.deepEqual(queryBodyFtsAnchors(db, 'alpha_body_token_v2'), []);

    // Deleting a file on disk + rebuild removes both evidence_docs and evidence_doc_bodies/FTS.
    unlinkSync(fileB);
    await builder.rebuild();
    assert.equal(await store.getByAnchor(anchorB), null);
    assert.equal(db.prepare('SELECT content FROM evidence_doc_bodies WHERE doc_anchor = ?').get(anchorB), undefined);
    assert.deepEqual(queryBodyFtsAnchors(db, 'beta_body_token_v1'), []);

    // Direct store deletion APIs (deleteByAnchor, removeBySourcePrefix, removeByPack) also clean bodies.
    writeFileSync(fileA, '# Alpha Doc\n\nSummary.\n\n## Body\n\nalpha_cleanup_token.\n');
    await builder.rebuild();
    assert.deepEqual(queryBodyFtsAnchors(db, 'alpha_cleanup_token'), [anchorA]);
    store.removeBySourcePrefix('alpha');
    assert.equal(db.prepare('SELECT count(*) AS n FROM evidence_doc_bodies WHERE doc_anchor = ?').get(anchorA).n, 0);
    assert.deepEqual(queryBodyFtsAnchors(db, 'alpha_cleanup_token'), []);

    await builder.rebuild();
    db.prepare('UPDATE evidence_docs SET pack_id = ? WHERE anchor = ?').run('pack-cleanup-1', anchorA);
    await store.deleteByPackId('pack-cleanup-1');
    assert.equal(db.prepare('SELECT count(*) AS n FROM evidence_doc_bodies WHERE doc_anchor = ?').get(anchorA).n, 0);
    assert.deepEqual(queryBodyFtsAnchors(db, 'alpha_cleanup_token'), []);
  });

  it('Atomicity: transaction failure during body publish leaves source_hash NULL and next non-force rebuild retries cleanly', async () => {
    const dir = makeTempDir('sim-q4-tx-retry-');
    const file = join(dir, 'retry-doc.md');
    const content = '# Retry Doc\n\nRetry summary.\n\n## Body\n\ntx_retry_body_token_505.\n';
    writeFileSync(file, content);

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner(manifest.id);
    const builder = new CollectionIndexBuilder(store, manifest, scanner, undefined, {
      storeDocumentBodies: true,
    });
    const anchor = `${manifest.id}:doc/retry-doc`;
    const db = store.getDb();

    // Inject a one-shot trigger failure inside the body transaction to simulate mid-publish failure.
    db.exec(`
      CREATE TRIGGER fail_body_once BEFORE INSERT ON evidence_doc_bodies
      BEGIN
        SELECT RAISE(ABORT, 'simulated_body_tx_failure');
      END;
    `);

    await assert.rejects(() => builder.rebuild(), /simulated_body_tx_failure/);

    assert.equal(
      db.prepare('SELECT source_hash FROM evidence_docs WHERE anchor = ?').get(anchor)?.source_hash,
      null,
      'failed body transaction must leave source_hash NULL so rebuild will retry',
    );
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM evidence_doc_bodies WHERE doc_anchor = ?').get(anchor).n,
      0,
      'rolled-back body transaction must not leave partial body rows',
    );

    db.exec('DROP TRIGGER fail_body_once;');

    const recovered = await builder.rebuild({ force: false });
    assert.equal(recovered.blocked, false);
    assert.equal(recovered.indexed, 1, 'non-force rebuild must retry NULL source_hash doc');
    assert.equal(recovered.skipped, 0);
    assert.equal(
      (await store.getByAnchor(anchor))?.sourceHash,
      createHash('sha256').update(content).digest('hex'),
      'successful retry must commit final source_hash atomically with body',
    );
    assert.deepEqual(queryBodyFtsAnchors(db, 'tx_retry_body_token_505'), [anchor]);
  });

  it('Per-document SecretScanner rejection: incrementalUpdate isolates offending doc, preserves sibling docs, throws observable error, and recovers after remediation', async () => {
    const dir = makeTempDir('sim-q4-secret-per-doc-');
    const siblingFile = join(dir, 'sibling.md');
    const batchCleanFile = join(dir, 'batch-clean.md');
    const offendingFile = join(dir, 'offending.md');

    writeFileSync(siblingFile, '# Sibling\n\nExisting safe doc.\n\n## Body\n\nsibling_safe_body_token.\n');
    writeFileSync(
      offendingFile,
      [
        '---',
        'supersedes: [doc/sibling]',
        '---',
        '# Offending',
        '',
        'Initially clean version.',
        '',
        '## Body',
        '',
        'offending_clean_body_token.',
      ].join('\n'),
    );

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner(manifest.id);
    const builder = new CollectionIndexBuilder(store, manifest, scanner, undefined, {
      storeDocumentBodies: true,
    });

    const initial = await builder.rebuild();
    assert.equal(initial.indexed, 2);

    const db = store.getDb();
    const siblingAnchor = `${manifest.id}:doc/sibling`;
    const batchCleanAnchor = `${manifest.id}:doc/batch-clean`;
    const offendingAnchor = `${manifest.id}:doc/offending`;
    assert.deepEqual(queryBodyFtsAnchors(db, 'offending_clean_body_token'), [offendingAnchor]);

    // Introduce a secret into offendingFile while also updating a clean file in the same batch.
    writeFileSync(batchCleanFile, '# Batch Clean\n\nClean sibling in same batch.\n\n## Body\n\nbatch_clean_token.\n');
    writeFileSync(
      offendingFile,
      [
        '---',
        'supersedes: [doc/sibling]',
        '---',
        '# Offending',
        '',
        'Leaked credential update.',
        '',
        ['token = gh', 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'].join(''),
      ].join('\n'),
    );

    let caught;
    try {
      await builder.incrementalUpdate([batchCleanFile, offendingFile]);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof CollectionSecretRejectionError, 'must throw observable CollectionSecretRejectionError');
    assert.equal(caught.code, 'COLLECTION_SECRET_REJECTED');
    assert.deepEqual(caught.rejectedAnchors, [offendingAnchor]);
    assert.ok(caught.secretFindings.length >= 1);

    // Offending doc must have NO doc row, NO body row, NO FTS entry, and NO stale supersedes edge.
    assert.equal(await store.getByAnchor(offendingAnchor), null);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM evidence_doc_bodies WHERE doc_anchor = ?').get(offendingAnchor).n,
      0,
    );
    assert.deepEqual(queryBodyFtsAnchors(db, 'offending_clean_body_token'), []);
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM edges WHERE from_anchor = ? AND relation = 'supersedes'")
        .get(offendingAnchor).n,
      0,
      'rejected doc must not retain stale supersedes edges',
    );

    // Both pre-existing sibling and clean doc in the same batch must remain intact and usable.
    assert.ok(await store.getByAnchor(siblingAnchor), 'pre-existing sibling doc must NOT be purged');
    assert.deepEqual(queryBodyFtsAnchors(db, 'sibling_safe_body_token'), [siblingAnchor]);
    assert.ok(await store.getByAnchor(batchCleanAnchor), 'clean doc in same batch must still be indexed');
    assert.deepEqual(queryBodyFtsAnchors(db, 'batch_clean_token'), [batchCleanAnchor]);

    // Recoverability: removing the secret lets incrementalUpdate re-index cleanly.
    const fixedContent = '# Offending\n\nRemediated summary.\n\n## Body\n\noffending_recovered_body_token.\n';
    writeFileSync(offendingFile, fixedContent);
    await builder.incrementalUpdate([offendingFile]);
    assert.equal(
      (await store.getByAnchor(offendingAnchor))?.sourceHash,
      createHash('sha256').update(fixedContent).digest('hex'),
    );
    assert.deepEqual(queryBodyFtsAnchors(db, 'offending_recovered_body_token'), [offendingAnchor]);
  });

  it('MaterializationService observability: secret rejection surfaces reindexError without purging collection', async () => {
    const rootDir = makeTempDir('sim-q4-mat-');
    const queue = new MarkerQueue(makeTempDir('sim-q4-markers-'));
    writeFileSync(join(rootDir, 'existing.md'), '# Existing\n\nKeep me intact.\n\n## Body\n\nkeep_me_intact_881.\n');

    const manifest = makeManifest(rootDir);
    const scanner = new FlatScanner(manifest.id);
    const builder = new CollectionIndexBuilder(store, manifest, scanner, undefined, {
      storeDocumentBodies: true,
    });
    await builder.rebuild();

    const marker = await queue.submit({
      content: ['Leaked lesson ', 'gh', 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'].join(''),
      source: 'neo:test',
      status: 'captured',
      targetKind: 'lesson',
      targetCollectionId: manifest.id,
    });
    await queue.transition(marker.id, 'approved');

    const svc = new MaterializationService(queue, rootDir);
    const result = await svc.materialize(marker.id, {
      targetRoot: rootDir,
      indexBuilder: builder,
    });

    assert.equal(result.reindexed, false, 'secret-rejected materialization must not report reindexed=true');
    assert.match(
      result.reindexError ?? '',
      /SecretScanner/,
      'MaterializationService must surface SecretScanner rejection via reindexError instead of swallowing it',
    );
    assert.ok(
      await store.getByAnchor(`${manifest.id}:doc/existing`),
      'existing sibling doc in collection must remain intact after rejected materialization',
    );
    assert.deepEqual(queryBodyFtsAnchors(store.getDb(), 'keep_me_intact_881'), [`${manifest.id}:doc/existing`]);
  });

  it('Migration upgrade & idempotent reopen: upgrades pre-body V84 DB and preserves data across repeated opens', async () => {
    const upgradeDbPath = join(makeTempDir('sim-q4-mig-'), 'legacy-v84.sqlite');
    const seedStore = new SqliteEvidenceStore(upgradeDbPath);
    await seedStore.initialize();
    await seedStore.upsert([
      {
        anchor: 'research:legacy:doc/preexisting',
        kind: 'research',
        status: 'active',
        title: 'Preexisting V84 Doc',
        summary: 'Must survive upgrade intact.',
        sourcePath: 'preexisting.md',
        updatedAt: '2026-11-26T00:00:00Z',
        authority: 'validated',
      },
    ]);
    // Simulate a pre-upgrade V84 database by dropping the new body table/FTS/triggers and reverting schema_version.
    const raw = seedStore.getDb();
    raw.exec(`
      DROP TRIGGER IF EXISTS evidence_doc_bodies_ai;
      DROP TRIGGER IF EXISTS evidence_doc_bodies_ad;
      DROP TRIGGER IF EXISTS evidence_doc_bodies_au;
      DROP TABLE IF EXISTS evidence_doc_body_fts;
      DROP TABLE IF EXISTS evidence_doc_bodies;
      DELETE FROM schema_version WHERE version >= 85;
    `);
    seedStore.close();

    // Verify raw SQLite DB is strictly at V84 without evidence_doc_bodies before reopening.
    const inspectBefore = new Database(upgradeDbPath, { readonly: true });
    assert.equal(inspectBefore.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 84);
    assert.equal(
      inspectBefore.prepare("SELECT name FROM sqlite_master WHERE name = 'evidence_doc_bodies'").get(),
      undefined,
    );
    inspectBefore.close();

    // First open upgrades V84 -> CURRENT_SCHEMA_VERSION cleanly.
    const upgraded = new SqliteEvidenceStore(upgradeDbPath);
    await upgraded.initialize();
    assert.ok(await upgraded.getByAnchor('research:legacy:doc/preexisting'), 'pre-existing doc must survive upgrade');
    assert.equal(
      upgraded.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v,
      CURRENT_SCHEMA_VERSION,
    );
    upgraded
      .getDb()
      .prepare('INSERT INTO evidence_doc_bodies (doc_anchor, content, updated_at) VALUES (?, ?, ?)')
      .run('research:legacy:doc/preexisting', 'upgraded_body_persistence_token', '2026-11-26T00:00:00Z');
    assert.deepEqual(queryBodyFtsAnchors(upgraded.getDb(), 'upgraded_body_persistence_token'), [
      'research:legacy:doc/preexisting',
    ]);
    upgraded.close();

    // Second open is strictly idempotent: no duplicate schema_version rows and body/FTS stay intact.
    const reopened = new SqliteEvidenceStore(upgradeDbPath);
    await reopened.initialize();
    const versionRows = reopened
      .getDb()
      .prepare('SELECT count(*) AS n FROM schema_version WHERE version = ?')
      .get(CURRENT_SCHEMA_VERSION).n;
    assert.equal(versionRows, 1, 'reopening upgraded DB must not duplicate schema_version entries');
    assert.deepEqual(queryBodyFtsAnchors(reopened.getDb(), 'upgraded_body_persistence_token'), [
      'research:legacy:doc/preexisting',
    ]);
    reopened.close();
  });

  it('#2085 compatibility: first external body/summary rewrite isolates stale vectors once, then zero-change reboot stays active', async () => {
    const dataDir = makeTempDir('sim-q4-2085-compat-');
    const extRoot = makeTempDir('sim-q4-2085-root-');
    const docFile = join(extRoot, 'note.md');
    writeFileSync(
      docFile,
      [
        '# Compat Note',
        '',
        '---',
        '',
        '[[_MOC]]',
        '',
        'Real summary paragraph.',
        '',
        'Deep compat_body_token_2085.',
      ].join('\n'),
    );

    const extManifest = makeManifest(extRoot, {
      id: 'research:compat-2085',
      name: 'compat-2085',
      status: 'active',
      indexPolicy: { autoRebuild: true },
    });
    saveExternalCollection(dataDir, extManifest);

    // Pre-seed collection store with a broken `---` summary + physical doc_vectors (pre-rewrite state).
    const storePath = join(dataDir, 'library', 'research-compat-2085', 'evidence.sqlite');
    mkdirSync(join(dataDir, 'library', 'research-compat-2085'), { recursive: true });
    const seed = new SqliteEvidenceStore(storePath, undefined, {
      sourceRoot: extRoot,
      sourceRef: extManifest.id,
    });
    await seed.initialize();
    await seed.upsert([
      {
        anchor: `${extManifest.id}:doc/note`,
        kind: 'research',
        status: 'active',
        title: 'Compat Note',
        summary: '---',
        sourcePath: 'note.md',
        sourceHash: 'pre-rewrite-old-hash',
        updatedAt: '2026-11-26T00:00:00Z',
        authority: 'validated',
      },
    ]);
    // Seed real G0 vector tables so hasVectorGeneration(db) and vector invalidation run end-to-end.
    const { openVectorGeneration } = await import('../../dist/domains/memory/open-vector-generation.js');
    openVectorGeneration(
      seed.getDb(),
      { id: 'test-model', dim: 4, version: '1', generationId: 'g0' },
      { create: true },
    );
    seed.close();

    // First boot: summary fidelity + body backfill rewrites the doc -> lexicalChanged=true -> status becomes 'stale'.
    const catalog1 = new LibraryCatalog();
    const stores1 = new Map();
    await registerPrivateAndExternalCollections({
      catalog: catalog1,
      stores: stores1,
      externalManifests: [extManifest],
      dataDir,
      now: '2026-11-26T00:00:00Z',
    });
    try {
      assert.equal(
        catalog1.get(extManifest.id)?.status,
        'stale',
        'first body/summary rewrite on vector-bearing collection must isolate vectors as stale',
      );
      const s1 = stores1.get(extManifest.id);
      assert.equal((await s1.getByAnchor(`${extManifest.id}:doc/note`))?.summary, 'Real summary paragraph.');
      assert.deepEqual(queryBodyFtsAnchors(s1.getDb(), 'compat_body_token_2085'), [`${extManifest.id}:doc/note`]);
      assert.equal(s1.getDb().prepare('SELECT count(*) AS n FROM evidence_passages').get().n, 0);
    } finally {
      for (const s of stores1.values()) s.close();
    }

    // Second boot (after vectors are marked active again with no file changes): skips unchanged doc & stays active.
    const catalog2 = new LibraryCatalog();
    const stores2 = new Map();
    await registerPrivateAndExternalCollections({
      catalog: catalog2,
      stores: stores2,
      externalManifests: [{ ...extManifest, status: 'active' }],
      dataDir,
      now: '2026-11-26T00:00:00Z',
    });
    try {
      assert.equal(
        catalog2.get(extManifest.id)?.status,
        'active',
        'unchanged reboot with body already populated must skip rewrite and stay active',
      );
    } finally {
      for (const s of stores2.values()) s.close();
    }
  });
});
