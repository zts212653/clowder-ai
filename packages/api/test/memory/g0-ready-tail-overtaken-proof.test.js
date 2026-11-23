import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inspectCohortAdmission,
  inspectCohortRecovery,
  isServableCohortTail,
} from '../../dist/domains/memory/embedding-cohort-recovery.js';
import { initializeVectorBackend } from '../../dist/domains/memory/embedding-lifecycle-backend.js';
import { generationInvalidationState } from '../../dist/domains/memory/vector-generation-invalidation.js';
import { vectorGenerationTables } from '../../dist/domains/memory/vector-generation-tables.js';
import { append, cohortFixture, model } from './g0-ready-tail-fixture.js';

// A coverage proof is overtaken by any commit. What overtook it may be a new source, which a
// completed G0 serves around, or a quarantine, which closes the store. Admission may not guess.

const quarantined = (store) => generationInvalidationState(store.getDb(), vectorGenerationTables('g0')).quarantined;

/** A restart in which `disturb` runs once, after the primary store is bound and while the second is prepared. */
async function restartDisturbedWhilePreparingSecondStore(t, disturb) {
  const f = await cohortFixture(t, { stores: 2 });
  const [primary, collection] = f.stores;
  const first = f.boot();
  assert.equal((await first.lifecycle.activate('on', { rebuildLegacyModel: model.modelId })).ok, true);
  assert.deepEqual([f.registry(primary), f.registry(collection)], ['ready', 'ready']);
  first.lifecycle.deactivate();

  let disturbed = false;
  const { lifecycle } = f.boot(undefined, {
    initializeVectorBackend: async (...args) => {
      const backend = await initializeVectorBackend(...args);
      if (args[0] === collection && !disturbed) {
        disturbed = true;
        disturb(f, primary);
      }
      return backend;
    },
  });
  const activation = await lifecycle.activate('on', { rebuildLegacyModel: model.modelId });
  assert.equal(disturbed, true);
  return { f, primary, lifecycle, activation };
}

test('a source arriving on a bound store while another store is prepared does not refuse the cohort', async (t) => {
  const { f, primary, lifecycle, activation } = await restartDisturbedWhilePreparingSecondStore(t, (_, store) => {
    store
      .getDb()
      .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)')
      .run('initial-0', 'p-late', 'initial-0 piano passage late', '2026-11-16');
  });

  assert.deepEqual([activation.ok, lifecycle.getStatus()], [true, 'ready']);
  assert.equal(f.coverage(primary).missingPassages, 1, 'admitted with the new source still unembedded');
  for (const store of f.stores) {
    const found = await f.byVector(store);
    assert.equal(found.meta.degraded, false);
    assert.ok(found.anchors.includes('initial-0'));
  }
});

test('a store quarantined while another store is prepared is not published, and the retry recovers it', async (t) => {
  // Same interleaving, but what overtakes the primary store's proof is another connection that
  // fails to load sqlite-vec and quarantines the store.
  const { f, primary, lifecycle, activation } = await restartDisturbedWhilePreparingSecondStore(t, (fixture, store) =>
    fixture.quarantineFromAnotherConnection(store),
  );

  assert.equal(quarantined(primary), true);
  assert.deepEqual(
    [activation.ok, lifecycle.getFailureReason()],
    [false, 'generation_not_ready'],
    'the primary store is read again, found quarantined, and the cohort is refused',
  );
  assert.equal((await f.byVector(primary)).meta.degradeReason, 'passage_embedding_unavailable');
  // The lifecycle's own 30 s retry is armed (private field: the timer is the only trace of it).
  assert.ok(lifecycle.recoveryTimer, 'a refused cohort schedules the existing recovery');

  // What that timer runs. Reconciliation clears the quarantine, and the cohort is admitted.
  const recovered = await lifecycle.activate('on', { rebuildLegacyModel: model.modelId });
  assert.deepEqual([recovered.ok, lifecycle.getStatus()], [true, 'ready']);
  assert.equal(quarantined(primary), false);
  for (const store of f.stores) {
    const found = await f.byVector(store);
    assert.equal(found.meta.degraded, false);
    assert.ok(found.anchors.includes('initial-0'));
  }
});

test('an overtaken store is read again, and the first inspection never decides on the overtaken proof', async (t) => {
  const f = await cohortFixture(t);
  const first = f.boot();
  assert.equal((await first.lifecycle.activate('on', { rebuildLegacyModel: model.modelId })).ok, true);
  first.lifecycle.deactivate();
  await append(f.store, 'tail', 1);

  // A source commits while the coverage read is in flight (the read runs in a worker process).
  // The proof that comes back is overtaken; the one handed to admission is a second, current read.
  const reading = inspectCohortAdmission(f.store, model, {}, () => true);
  f.store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)')
    .run('tail-0', 'p-late', 'tail-0 piano passage late', '2026-11-16');
  const proof = await reading;
  assert.deepEqual(
    [proof.isCurrent(), proof.coverage.missingPassages, isServableCohortTail(f.store.getDb(), model, proof)],
    [true, 3, true],
    'an ordinary write costs another look, not a repair cycle',
  );

  // The liveness callback is the only seam between the read and the decision. Its last call on an
  // undisturbed pass is that point; a quarantine landing there leaves a proof that still says "tail".
  const inspect = async (disturb = () => {}) => {
    let calls = 0;
    const state = await inspectCohortRecovery(
      [f.store],
      model,
      true,
      () => {
        calls++;
        disturb(calls);
        return true;
      },
      true,
    );
    return { state, calls };
  };
  const undisturbed = await inspect();
  assert.equal(undisturbed.state, 'ready', 'a completed G0 with a tail of 1 document and 3 passages');
  const withQuarantine = await inspect((call) => {
    if (call === undisturbed.calls) f.quarantineFromAnotherConnection();
  });
  assert.equal(quarantined(f.store), true);
  assert.equal(withQuarantine.state, 'repair', 'a quarantined store is not admitted as a tail');
});
