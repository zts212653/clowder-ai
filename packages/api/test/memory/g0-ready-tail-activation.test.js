import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isServableCohortTail } from '../../dist/domains/memory/embedding-cohort-recovery.js';
import { append, cohortFixture, model } from './g0-ready-tail-fixture.js';

// 2026-11-16, boot92: the vector index held 561,679 of 562,018 passage vectors, yet every semantic
// search fell back to lexical for the fifteen minutes it took the startup admission to see a store
// with exactly zero unembedded sources. Minutes later the same store served searches with a tail of
// 217 unembedded passages, because nothing re-inspects coverage once the index is bound.
//
// Searches here use a word that occurs in no fixture text, so every hit comes from a stored vector.

const fromIndexed = (anchors) => anchors.length > 0 && anchors.every((anchor) => anchor.startsWith('initial-'));

test('a completed G0 keeps serving its vectors while a restart catches up the unembedded tail', async (t) => {
  const f = await cohortFixture(t);

  // Day one: the explicit rebuild completes and registers the cohort as ready.
  const first = f.boot();
  assert.equal((await first.lifecycle.activate('on', { rebuildLegacyModel: model.modelId })).ok, true);
  assert.equal(f.registry(), 'ready');
  assert.equal(f.coverage().ready, true);

  // Ordinary operation: new content arrives ahead of its vectors and searches keep their vectors.
  await append(f.store, 'tail', 1);
  const tail = f.coverage();
  assert.deepEqual(
    [tail.ready, tail.missingDocuments, tail.missingPassages, tail.orphanDocuments, tail.orphanPassages],
    [false, 1, 2, 0, 0],
  );
  const steady = await f.byVector();
  assert.equal(steady.meta.degraded, false, 'steady state already serves vectors with this tail outstanding');
  assert.ok(fromIndexed(steady.anchors), 'the 12 indexed documents answer; the unembedded one cannot yet');

  // Restart with the same database and the same tail. The encoder is busy, as it is for minutes
  // when thousands of sources arrived while the process was down.
  first.lifecycle.deactivate();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const encoderBusy = new Promise((resolve) => {
    entered = resolve;
  });
  const second = f.boot(async (texts) => {
    if (!texts.some((text) => text.includes('tail-'))) return; // the search's own query still encodes
    entered();
    await held;
  });
  t.after(() => release());
  // The service-ready reconciler always names the configured model, as index.ts does.
  const activation = second.lifecycle.activate('on', { rebuildLegacyModel: model.modelId });
  await Promise.race([activation, encoderBusy]);

  const during = await f.byVector();
  assert.deepEqual(
    [during.meta.degraded, during.meta.degradeReason ?? null],
    [false, null],
    'the 36 vectors that were valid before the restart must stay searchable while 3 new sources wait',
  );
  assert.ok(fromIndexed(during.anchors), 'the hits are vector hits on the sources indexed before the restart');
  assert.equal((await activation).ok, true);
  assert.equal(second.lifecycle.getStatus(), 'ready');

  // The tail is still owed, and the ordinary incremental path pays it: nothing is silently adopted.
  release();
  await second.lifecycle.catchUpAfterReady();
  for (let i = 0; i < 200 && !f.coverage().ready; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.coverage().ready, true, 'the unembedded tail is completed after activation');
  assert.ok(second.encoded.some((text) => text.includes('tail-0')));
  assert.ok((await f.byVector()).anchors.includes('tail-0'), 'and its vectors are then searchable');
});

test('a replacement that never completed stays closed across the same restart', async (t) => {
  const f = await cohortFixture(t);

  // The rebuild is interrupted after a few sources: the registry still says building.
  let seen = 0;
  const first = f.boot(async (texts) => {
    seen += texts.length;
    if (seen > 6) throw new Error('encoder stopped mid-build');
  });
  assert.equal((await first.lifecycle.activate('on', { rebuildLegacyModel: model.modelId })).ok, false);
  assert.equal(f.registry(), 'building');
  const partial = f.coverage();
  assert.ok(partial.missingDocuments + partial.missingPassages > 0);
  first.lifecycle.deactivate();

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const encoderBusy = new Promise((resolve) => {
    entered = resolve;
  });
  const second = f.boot(async (texts) => {
    if (!texts.some((text) => text.includes('initial'))) return;
    entered();
    await held;
  });
  t.after(() => release());
  const activation = second.lifecycle.activate('on', { rebuildLegacyModel: model.modelId });
  await Promise.race([activation, encoderBusy]);

  const during = await f.byVector();
  assert.deepEqual(
    [during.meta.degraded, during.meta.degradeReason, during.anchors],
    [true, 'passage_embedding_unavailable', []],
    'a half-built replacement is never published',
  );
  release();
  assert.equal((await activation).ok, true);
  assert.equal(f.registry(), 'ready');
  const complete = await f.byVector();
  assert.equal(complete.meta.degraded, false);
  assert.ok(fromIndexed(complete.anchors));
});

test('tail admission is limited to a current proof of a completed, sole G0 with no orphan vectors', async (t) => {
  const f = await cohortFixture(t);
  assert.equal((await f.boot().lifecycle.activate('on', { rebuildLegacyModel: model.modelId })).ok, true);
  await append(f.store, 'tail', 1);
  const db = f.store.getDb();
  const coverage = f.coverage();
  const servable = (m = model, c = coverage, isCurrent = () => true) =>
    isServableCohortTail(db, m, { coverage: c, isCurrent });
  assert.equal(servable(), true);
  assert.equal(
    servable(model, coverage, () => false),
    false,
    'a proof overtaken by a commit: what overtook it may be a quarantine',
  );

  for (const reason of ['tables_unavailable', 'quarantined', 'identity_mismatch', 'registry_not_ready'])
    assert.equal(servable(model, { ...coverage, reason }), false, reason);
  assert.equal(servable(model, { ...coverage, orphanPassages: 1 }), false, 'orphan passage vectors');
  assert.equal(servable(model, { ...coverage, orphanDocuments: 1 }), false, 'orphan document vectors');
  assert.equal(servable({ ...model, modelId: 'another-model' }), false, 'another identity');
  assert.equal(servable({ ...model, generationId: 'g1', representationFingerprint: 'f'.repeat(64) }), false, 'G1');

  const withRegistry = (sql, expected, why) => {
    db.exec('SAVEPOINT registry');
    try {
      db.exec(sql);
      assert.equal(servable(), expected, why);
    } finally {
      db.exec('ROLLBACK TO registry; RELEASE registry');
    }
  };
  withRegistry("UPDATE vector_generations SET state='building' WHERE id='g0'", false, 'a replacement in progress');
  withRegistry(
    "UPDATE vector_generations SET fingerprint='other' WHERE id='g0'",
    false,
    'registered for another identity',
  );
  withRegistry(
    "DELETE FROM vector_generations WHERE id='g0'",
    false,
    'unregistered legacy G0 has its own incremental path',
  );
  withRegistry("INSERT INTO vector_generations VALUES('g1','x','ready')", false, 'G1 was completed: may be a switch');
  withRegistry(
    "INSERT INTO vector_generations VALUES('g1','x','building')",
    true,
    'a G1 that never completed changes nothing',
  );
});
