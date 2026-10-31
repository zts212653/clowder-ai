import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const { visibleTasteMemories } = await import('../../dist/routes/taste-browse-model.js');

// Original behavior regressions from Astra final_seal #5227, source1398.
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mod = (path) => import(`${root}/dist/${path}.js`);
const { createRemoteFixture, git, remoteFile, divergeAndStagePrimary } = await import(
  `${root}/test/taste-publication-fixtures.js`
);
const { FileTasteRepository } = await mod('domains/taste/services/TasteRepository');
const { TasteMemoryReader } = await mod('domains/memory/taste/TasteMemoryReader');
const { TasteMemoryLifecycleService } = await mod('domains/memory/taste/TasteMemoryLifecycleService');
const { TasteMemoryLifecycleStore } = await mod('domains/memory/taste/TasteMemoryLifecycleStore');
const { TasteMemoryProjectionWriter } = await mod('domains/memory/taste/TasteMemoryProjectionWriter');
const { tasteMemoryId, tasteDocumentAnchor } = await mod('domains/memory/taste/taste-memory-identity');
const { OwnerMemoryActionCoordinator, InMemoryOwnerMemoryActionReceiptStore } = await mod(
  'domains/memory/owner/OwnerMemoryActionCoordinator',
);
const { SessionMutex } = await mod('domains/cats/services/agents/invocation/SessionMutex');
const { SqliteEvidenceStore } = await mod('domains/memory/SqliteEvidenceStore');
const { CatCafeScanner } = await mod('domains/memory/CatCafeScanner');
const { IndexBuilder } = await mod('domains/memory/IndexBuilder');
const sourcePath = 'docs/taste/vignettes/astra-public.md';
const owner = 'astra-review-owner';
const original =
  '---\nwhen: 2026-10-06\nquotes: ["Zebramemoria"]\nscene: "Zebramemoria Old scene"\ntags: ["public"]\ndimension: visual-quality\nprivacy: public\n---\n';
const revision = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
async function fixture({ durable = false } = {}) {
  const f = createRemoteFixture();
  mkdirSync(join(f.primary, 'docs/taste/vignettes'), { recursive: true });
  writeFileSync(join(f.primary, sourcePath), original);
  git(f.primary, ['add', sourcePath]);
  git(f.primary, ['commit', '-m', 'seed existing public memory']);
  git(f.primary, ['push', 'origin', 'main']);
  const evidence = new SqliteEvidenceStore(durable ? join(f.root, 'evidence.sqlite') : ':memory:');
  await evidence.initialize();
  const store = new TasteMemoryLifecycleStore(evidence.getDb());
  const repository = new FileTasteRepository(f.runtime);
  const reader = new TasteMemoryReader(repository, owner, { lifecycle: store });
  const service = new TasteMemoryLifecycleService({
    store,
    writer: new TasteMemoryProjectionWriter(repository),
    coordinator: new OwnerMemoryActionCoordinator({
      store: new InMemoryOwnerMemoryActionReceiptStore(),
      lock: new SessionMutex(),
    }),
    targetLock: new SessionMutex(),
    lockKey: () => repository.approvalLockKey(),
    invalidateDerived: ({ sourcePath }) => evidence.deleteByAnchor(tasteDocumentAnchor(sourcePath)),
  });
  return { ...f, evidence, store, reader, service, repository };
}
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
