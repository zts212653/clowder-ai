import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const { visibleTasteMemories } = await import('../../dist/routes/taste-browse-model.js');

// Original behavior regressions from Astra final_seal #5227, source1398.
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mod = (path) => import(`${root}/dist/${path}.js`);
const { git, remoteFile, divergeAndStagePrimary } = await import(`${root}/test/taste-publication-fixtures.js`);
const { FileTasteRepository } = await mod('domains/taste/services/TasteRepository');
const { TasteMemoryReader } = await mod('domains/memory/taste/TasteMemoryReader');
const { TasteMemoryLifecycleStore } = await mod('domains/memory/taste/TasteMemoryLifecycleStore');
const { tasteMemoryId, tasteDocumentAnchor } = await mod('domains/memory/taste/taste-memory-identity');
const { SqliteEvidenceStore } = await mod('domains/memory/SqliteEvidenceStore');
const { CatCafeScanner } = await mod('domains/memory/CatCafeScanner');
const { IndexBuilder } = await mod('domains/memory/IndexBuilder');

import { fixture, original, owner, revision, sourcePath } from '../helpers/published-taste-fixture.js';

test('public correction success immediately exposes its new canonical revision', async () => {
  const f = await fixture();
  try {
    assert.ok(await f.reader.read({ ownerUserId: owner, sourcePath }));
    const unicodePath = 'docs/taste/vignettes/审查中文.md';
    writeFileSync(join(f.primary, unicodePath), original.replaceAll('Zebramemoria', 'Unicode fixture'));
    git(f.primary, ['add', unicodePath]);
    git(f.primary, ['commit', '-m', 'seed approved Unicode vignette']);
    git(f.primary, ['push', 'origin', 'main']);
    divergeAndStagePrimary(f);
    const dirtyBefore = git(f.primary, ['status', '--porcelain']);
    const receipt = await f.service.executeOwnerAction(owner, tasteMemoryId(sourcePath), sourcePath, {
      action: 'correct',
      requestId: 'astra-correct-001',
      expectedRevision: revision(original),
      patch: { scene: 'New approved scene' },
    });
    const remote = remoteFile(f, sourcePath);
    const after = await f.reader.read({ ownerUserId: owner, sourcePath });
    console.log(
      JSON.stringify({
        case: 'public-correct',
        receipt,
        remoteHasNew: remote.includes('New approved scene'),
        localHasOld: readFileSync(join(f.primary, sourcePath), 'utf8').includes('Old scene'),
        readAfter: after,
      }),
    );
    assert.equal(receipt.outcome, 'applied');
    assert.equal(
      after?.payload.scene,
      'New approved scene',
      'success must make the new revision readable without manual main synchronization',
    );
    assert.equal(git(f.primary, ['status', '--porcelain']), dirtyBefore);
    const recreated = new TasteMemoryReader(new FileTasteRepository(f.runtime), owner, { lifecycle: f.store });
    assert.equal((await recreated.read({ ownerUserId: owner, sourcePath }))?.revision, receipt.revision);
    assert.equal(
      (await visibleTasteMemories(f.repository, owner, false, f.store)).find((entry) => entry.sourcePath === sourcePath)
        ?.payload.scene,
      'New approved scene',
    );
    assert.ok((await f.repository.publishedSnapshot()).list);
    assert.ok((await (await f.repository.publishedSnapshot()).list()).includes(unicodePath));
    const second = await f.service.executeOwnerAction(owner, tasteMemoryId(sourcePath), sourcePath, {
      action: 'correct',
      requestId: `second-correct-${'2'.repeat(32)}`,
      expectedRevision: receipt.revision,
      patch: { scene: 'Second approved scene' },
    });
    assert.equal(second.outcome, 'applied');
    assert.equal((await recreated.read({ ownerUserId: owner, sourcePath }))?.payload.scene, 'Second approved scene');
  } finally {
    await f.evidence.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('hard-forgotten public Taste cannot be restored by the real scanner and index rebuild', async () => {
  const f = await fixture();
  try {
    const builder = new IndexBuilder(
      f.evidence,
      join(f.primary, 'docs'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new CatCafeScanner(),
    );
    await builder.rebuild({ force: true });
    assert.ok((await f.evidence.search('Zebramemoria')).length);
    const receipt = await f.service.executeOwnerAction(owner, tasteMemoryId(sourcePath), sourcePath, {
      action: 'hard_forget',
      requestId: 'astra-forget-001',
      expectedRevision: revision(original),
      confirmed: true,
    });
    assert.equal(receipt.outcome, 'applied');
    assert.equal((await f.evidence.search('Zebramemoria')).length, 0);
    await builder.rebuild({ force: true });
    const hits = await f.evidence.search('Zebramemoria');
    console.log(
      JSON.stringify({
        case: 'forget-then-reindex',
        receipt,
        tasteRead: await f.reader.read({ ownerUserId: owner, sourcePath }),
        hits,
      }),
    );
    assert.equal(
      hits.length,
      0,
      'a successful hard forget must survive real index rebuilding from still-present source bytes',
    );
  } finally {
    await f.evidence.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('legacy SQL writers and reopening cannot resurrect forgotten Taste documents or passages', async () => {
  const f = await fixture({ durable: true });
  const legacy = new Database(join(f.root, 'evidence.sqlite'));
  let reopened;
  try {
    const builder = new IndexBuilder(
      f.evidence,
      join(f.primary, 'docs'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new CatCafeScanner(),
    );
    await builder.rebuild({ force: true });
    const anchor = tasteDocumentAnchor(sourcePath);
    const insert = legacy.prepare(
      "INSERT INTO evidence_docs(anchor,kind,status,title,summary,source_path,source_hash,updated_at) VALUES (?, 'doc', 'active', 'Taste', 'Zebramemoria', 'taste/vignettes/astra-public.md', ?, '2026-10-06')",
    );
    const passage = legacy.prepare(
      "INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES (?, 'md-legacy', 'Zebramemoria', '2026-10-06')",
    );
    const forgotten = await f.service.executeOwnerAction(owner, tasteMemoryId(sourcePath), sourcePath, {
      action: 'hard_forget',
      requestId: `legacy-forget-${'1'.repeat(32)}`,
      expectedRevision: revision(original),
      confirmed: true,
    });
    assert.equal(forgotten.outcome, 'applied');
    insert.run(anchor, revision(original).slice(7, 23));
    passage.run(anchor);
    assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM evidence_docs WHERE anchor=?').get(anchor).n, 0);
    assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM evidence_passages WHERE doc_anchor=?').get(anchor).n, 0);
    insert.run('unrelated', 'other-hash'); // same source path is fenced even under a different anchor
    assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM evidence_docs WHERE anchor='unrelated'").get().n, 0);
    for (const { name } of legacy
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'taste_%'")
      .all()) {
      legacy.exec(`DROP TRIGGER ${name}`);
    }
    insert.run(anchor, revision(original).slice(7, 23));
    passage.run(anchor);
    assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM evidence_docs WHERE anchor=?').get(anchor).n, 1);
    await f.evidence.close();
    reopened = new SqliteEvidenceStore(join(f.root, 'evidence.sqlite'));
    await reopened.initialize();
    assert.equal((await reopened.search('Zebramemoria')).length, 0);
    assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM evidence_passages WHERE doc_anchor=?').get(anchor).n, 0);
    insert.run(anchor, revision(original).slice(7, 23));
    assert.equal((await reopened.search('Zebramemoria')).length, 0);
  } finally {
    legacy.close();
    await reopened?.close();
    await f.evidence.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('published recall follows correction and forget without restart or changing dirty main', async () => {
  const f = await fixture({ durable: true });
  const { PublishedDocumentSource } = await mod('domains/memory/PublishedDocumentSource');
  const { PublishedDocumentIndex } = await mod('domains/memory/PublishedDocumentIndex');
  const source = new PublishedDocumentSource(f.primary, {
    ownerUserId: owner,
    lifecycle: f.store,
    lifecycleRevision: () =>
      JSON.stringify(
        f.evidence
          .getDb()
          .prepare('SELECT status, projected_revision FROM taste_memory_lifecycle ORDER BY source_path')
          .all(),
      ),
  });
  const projection = new PublishedDocumentIndex(source, f.evidence);
  const builder = new IndexBuilder(
    f.evidence,
    join(f.primary, 'docs'),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new CatCafeScanner(),
    undefined,
    projection,
  );
  try {
    await builder.rebuild({ deferThreadIndexing: true });
    const beforeHit = (await f.evidence.search('Zebramemoria'))[0];
    assert.ok(beforeHit);
    assert.match(beforeHit.drillDown.params.path, /^cat-cafe:\/\/published\//);
    assert.equal((await projection.read(beforeHit.anchor, beforeHit.sourceHash)).status, 'ready');
    const snapshot = source.snapshot.bind(source);
    const interruptedCommand = {
      action: 'correct',
      requestId: 'f332-rolled-back',
      expectedRevision: revision(original),
      patch: { scene: 'not committed' },
    };
    source.snapshot = async (...args) => {
      const pinned = await snapshot(...args);
      source.snapshot = snapshot;
      f.store.prepareAction({
        ownerUserId: owner,
        sourcePath,
        memoryId: tasteMemoryId(sourcePath),
        command: interruptedCommand,
        currentStatus: 'active',
        currentRevision: revision(original),
      });
      return pinned;
    };
    await builder.refreshPublishedDocuments();
    assert.equal((await f.evidence.search('Zebramemoria')).length, 0, 'a prepared correction suppresses recall');
    f.store.rollbackPrepared(
      owner,
      sourcePath,
      interruptedCommand.requestId,
      f.store.commandDigest(interruptedCommand),
    );
    await builder.refreshPublishedDocuments();
    assert.ok(
      (await f.evidence.search('Zebramemoria')).length,
      'a rolled-back action is repaired even when its source revision equals the old checkpoint',
    );
    divergeAndStagePrimary(f);
    const dirty = git(f.primary, ['status', '--porcelain']);
    const corrected = await f.service.executeOwnerAction(owner, tasteMemoryId(sourcePath), sourcePath, {
      action: 'correct',
      requestId: 'f332-correction',
      expectedRevision: revision(original),
      patch: { scene: 'CorrectedQuasar published scene' },
    });
    assert.equal(corrected.outcome, 'applied');
    assert.notEqual((await projection.read(beforeHit.anchor, beforeHit.sourceHash)).status, 'ready');
    await builder.refreshPublishedDocuments();
    const updated = (await f.evidence.search('CorrectedQuasar', { depth: 'raw' }))[0];
    assert.ok(updated, 'the newly approved revision must survive the existing lifecycle write fence');
    assert.match((await projection.read(updated.anchor, updated.sourceHash)).content, /CorrectedQuasar/);
    assert.equal(projection.getStatus().state, 'up_to_date');
    const forgotten = await f.service.executeOwnerAction(owner, tasteMemoryId(sourcePath), sourcePath, {
      action: 'hard_forget',
      requestId: 'f332-forget',
      expectedRevision: corrected.revision,
      confirmed: true,
    });
    assert.equal(forgotten.outcome, 'applied');
    await builder.refreshPublishedDocuments();
    await builder.rebuild({ force: true, deferThreadIndexing: true });
    assert.equal((await f.evidence.search('CorrectedQuasar')).length, 0);
    assert.equal((await projection.read(updated.anchor, updated.sourceHash)).status, 'unavailable');
    assert.equal(git(f.primary, ['status', '--porcelain']), dirty);
  } finally {
    await projection.stop();
    f.evidence.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
