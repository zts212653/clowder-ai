import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import '../helpers/setup-cat-registry.js';

const { MessageStore, deriveGrowingSourceMessageRevision } = await import(
  '../../dist/domains/cats/services/stores/ports/MessageStore.js'
);
const { CustodyOfferService } = await import('../../dist/domains/growing/CustodyOfferService.js');
const { CustodyOpportunityCohortStore } = await import('../../dist/domains/growing/CustodyOpportunityCohortStore.js');
const { CustodyOpportunityRuntime, startCustodyOpportunityObservation } = await import(
  '../../dist/domains/growing/CustodyOpportunityRuntime.js'
);
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { EntrustedWorkLifecycleService } = await import('../../dist/domains/growing/EntrustedWorkLifecycleService.js');
const databases = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(t) {
  let now = 1_789_000_000_000;
  // Task owner writes and injected service clocks must share the same timeline.
  t.mock.method(Date, 'now', () => now);
  const db = new Database(':memory:');
  databases.push(db);
  const cohorts = new CustodyOpportunityCohortStore(db);
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const deps = { cohorts, messages, tasks, policyVersion: 'frozen-policy-v1', now: () => now };
  const runtime = new CustodyOpportunityRuntime(deps);
  runtime.register('owner');
  const addSource = (content, offset = 1, owner = 'owner') => {
    now += offset;
    return messages.append({ userId: owner, threadId: 'thread', catId: null, timestamp: now, content });
  };
  const offers = new CustodyOfferService(messages, undefined, { now: () => now });
  const lifecycle = new EntrustedWorkLifecycleService(tasks, { now: () => now });
  async function admit(source, key = source.id) {
    return lifecycle.admitOrResume({
      task: {
        threadId: 'thread',
        userId: source.userId,
        title: 'Presentation',
        why: 'Source',
        createdBy: 'codex-sol',
        ownerCatId: 'codex-sol',
      },
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:${source.id}`],
        intendedOutcome: 'Ready presentation',
        idempotencyKey: key,
      },
      closure: { condition: 'Final artifact approved', expectedSignal: 'artifact:final' },
    });
  }
  async function offer(source) {
    return offers.recordPendingOffer({
      sourceMessageId: source.id,
      sourceMessageRevision: deriveGrowingSourceMessageRevision(source),
      offerId: `offer:${source.id}`,
      policyVersion: 'custody-recognition-v1',
      reasonCode: 'future_deliverable',
    });
  }
  return {
    db,
    deps,
    runtime,
    messages,
    tasks,
    addSource,
    admit,
    offer,
    offers,
    lifecycle,
    now: () => now,
    advance: (delta) => {
      now += delta;
    },
  };
}

test('source-owned recognition time is recorded once and preserved by offer replay', async () => {
  const messages = new MessageStore();
  const source = messages.append({
    userId: 'owner',
    threadId: 'thread',
    catId: null,
    timestamp: 1_789_000_000_000,
    content: 'Tomorrow we need a presentation',
  });
  let now = source.timestamp + 100;
  const service = new CustodyOfferService(messages, undefined, { now: () => now });
  const input = {
    sourceMessageId: source.id,
    sourceMessageRevision: deriveGrowingSourceMessageRevision(source),
    offerId: 'offer',
    policyVersion: 'custody-recognition-v1',
    reasonCode: 'future_deliverable',
  };
  const recorded = await service.recordPendingOffer(input);
  assert.equal(recorded.offer.recognizedAt, now);
  now += 500;
  const replay = await service.recordPendingOffer(input);
  assert.equal(replay.offer.recognizedAt, now - 500);
  const changedTime = messages.compareAndTransitionCustodyOffer(source.id, {
    expectedSourceMessageRevision: input.sourceMessageRevision,
    expectedOffer: replay.offer,
    nextOffer: {
      ...replay.offer,
      recognizedAt: now,
      disposition: 'declined',
      actorRef: 'user:owner',
      dispositionAt: now,
    },
  });
  assert.equal(changedTime.kind, 'invalid_transition');
});

test('prospective registration excludes old sources and survives restart without resetting the window', async (t) => {
  const f = fixture(t);
  const original = f.runtime.register('owner');
  const old = f.messages.append({
    userId: 'owner',
    threadId: 'thread',
    catId: null,
    timestamp: original.startedAt - 1,
    content: 'Old presentation',
  });
  await f.admit(old);
  const fresh = f.addSource('Please prepare a presentation');
  const admitted = await f.admit(fresh);
  f.advance(1000);
  const restarted = new CustodyOpportunityRuntime({ ...f.deps, cohorts: new CustodyOpportunityCohortStore(f.db) });
  const read = await restarted.read('owner');
  assert.deepEqual(read.cohort, original);
  assert.equal(read.measurement.episodes.length, 1);
  assert.equal(read.measurement.episodes[0].source.subjectRef, `message:${fresh.id}`);
  assert.equal(read.measurement.episodes[0].policyDisposition, 'auto_admit');
  assert.equal(read.measurement.episodes[0].custody.taskRef.subjectRef, admitted.ownerRef);
  assert.equal(read.readiness, 'collecting');
});

test('real owner offer, human decline and sampled silent windows share one denominator without invented TN', async (t) => {
  const f = fixture(t);
  const offered = f.addSource('We have a presentation to prepare');
  const result = await f.offer(offered);
  f.advance(10);
  await f.offers.refuseOffer({
    sourceMessageId: offered.id,
    sourceMessageRevision: result.offer.sourceMessageRevision,
    offerId: result.offer.offerId,
    disposition: 'declined',
    actorRef: 'user:owner',
    dispositionAt: f.now(),
  });
  const silent = f.addSource('明天见，先聊聊');
  f.addSource('Private other owner message', 1, 'other-owner');
  f.advance(3_600_001);
  const read = await f.runtime.read('owner');
  assert.equal(read.measurement.state, 'valid');
  const episodes = read.measurement.episodes;
  assert.equal(episodes.length, 2);
  const action = episodes.find((episode) => episode.policyDisposition === 'offer');
  assert.equal(action.userDisposition.result, 'decline');
  assert.equal(action.candidate.exposedAt, result.offer.recognizedAt);
  const silence = episodes.find((episode) => episode.source.subjectRef === `message:${silent.id}`);
  assert.equal(silence.policyDisposition, 'uninformed_silence');
  assert.equal(silence.candidate.state, 'not_exposed');
  assert.equal(read.measurement.vector.silence.trueNegativeEligible, 0);
  assert.equal(read.measurement.vector.denominator.totalEpisodes, 2);
  assert.equal(JSON.stringify(read).includes('Private other owner'), false);
  assert.equal(JSON.stringify(read).includes('We have a presentation'), false);
});

test('frozen refs-only evidence is immutable while live reads follow typed Task outcomes', async (t) => {
  const f = fixture(t);
  const source = f.addSource('A presentation for review');
  const admission = await f.admit(source);
  const frozen = await f.runtime.freeze('owner');
  assert.equal(f.runtime.readFrozen('other-owner', frozen.snapshotRef), null);
  f.advance(20);
  await f.lifecycle.close({
    taskId: admission.ownerRef.replace('task:item:', ''),
    expectedRevision: 1,
    closure: {
      state: 'satisfied',
      condition: 'Final artifact approved',
      expectedSignal: 'artifact:final',
      evidenceRefs: ['artifact:approved:v2'],
    },
  });
  const live = await f.runtime.read('owner');
  assert.deepEqual(live.measurement.episodes[0].delayedOutcome, {
    state: 'available',
    outcomeRefs: ['artifact:approved:v2'],
  });
  assert.deepEqual(f.runtime.readFrozen('owner', frozen.snapshotRef), frozen.snapshot);
  assert.equal(f.tasks.listByKind('work').length, 1, 'measurement never creates product work');
});

test('legacy missing exposure, policy changes and unavailable sources remain explicit evidence gaps', async (t) => {
  const f = fixture(t);
  const source = f.addSource('A plausible obligation');
  const offer = await f.offer(source);
  const altered = structuredClone(f.messages.getById(source.id));
  delete altered.extra.custodyOfferV1.recognizedAt;
  const runtime = new CustodyOpportunityRuntime({
    ...f.deps,
    messages: {
      async listOwnerMessageWindowSlice() {
        return { messages: [altered], hasMore: false };
      },
    },
  });
  const read = await runtime.read('owner');
  assert.equal(read.readiness, 'insufficient_evidence');
  assert.equal(read.coverageGaps[0].reason, 'candidate_exposure_unverified');
  assert.equal(read.measurement.episodes.length, 0);
  await f.admit(source);
  assert.equal(
    (await runtime.read('owner')).coverageGaps[0]?.reason,
    'candidate_exposure_unverified',
    'a later Task admission cannot backfill an unknown offer exposure timestamp',
  );
  for (const mutation of [{ recall: true }, { _tombstone: true }, { deletedAt: f.now() }]) {
    Object.assign(altered, mutation);
    const unavailable = await runtime.read('owner');
    assert.equal(unavailable.coverageGaps[0].reason, 'source_unavailable');
    assert.equal(unavailable.measurement.episodes.length, 0);
    for (const key of Object.keys(mutation)) delete altered[key];
  }
  const revised = new CustodyOpportunityRuntime({ ...f.deps, policyVersion: 'frozen-policy-v2' });
  f.advance(50);
  assert.notEqual(revised.register('owner').cohortRef, read.cohort.cohortRef);
  assert.equal(offer.offer.policyVersion, 'custody-recognition-v1');
});

test('twenty terminal episodes with five offers and five silent windows request calibration without granting utility', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 5; index++) await f.offer(f.addSource('A plausible future presentation'));
  for (let index = 0; index < 10; index++) await f.admit(f.addSource('Please prepare the presentation'));
  for (let index = 0; index < 5; index++) f.addSource('明天见，先聊聊');
  assert.equal(await f.runtime.reconcile('owner'), null, 'pending outcomes cannot mature the cohort');
  f.advance(7 * 86_400_000);
  const ref = await f.runtime.reconcile('owner');
  const snapshot = f.runtime.readFrozen('owner', ref);
  assert.equal(snapshot.measurement.episodes.length, 20);
  assert.equal(snapshot.readiness, 'needs_calibration');
  assert.equal(snapshot.actionability, 'requires_independent_calibration_and_cvo_outcome');
  assert.equal(snapshot.measurement.vector.silence.trueNegativeEligible, 0);
  assert.equal(
    snapshot.measurement.episodes.every((episode) => episode.delayedOutcome.state === 'missing'),
    true,
  );
});

test('the time fallback captures one durable insufficient-evidence review receipt, not a PASS', async (t) => {
  const f = fixture(t);
  f.advance(30 * 86_400_000);
  const ref = await f.runtime.reconcile('owner');
  const again = await new CustodyOpportunityRuntime(f.deps).reconcile('owner');
  assert.equal(again, ref);
  const snapshot = f.runtime.readFrozen('owner', ref);
  assert.equal(snapshot.readiness, 'insufficient_evidence');
  assert.equal(snapshot.actionability, 'requires_independent_calibration_and_cvo_outcome');
  assert.equal((await f.runtime.read('owner')).reviewSnapshotRef, ref);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM f310_custody_cohort_snapshots').get().count, 1);
});

test('bounded source reads cannot silently report complete cohort coverage', async (t) => {
  const f = fixture(t);
  const sources = [f.addSource('明天一'), f.addSource('明天二'), f.addSource('明天三')];
  const slice = f.messages.listOwnerMessageWindowSlice('owner', sources[0].timestamp, sources[2].timestamp, 2);
  assert.equal(slice.hasMore, true);
  assert.equal(slice.messages.length, 2);
  assert.throws(() => f.messages.listOwnerMessageWindowSlice('owner', 0, f.now(), 0), /limit/);
  const runtime = new CustodyOpportunityRuntime({
    ...f.deps,
    messages: {
      async listOwnerMessageWindowSlice() {
        return slice;
      },
    },
  });
  f.advance(3_600_001);
  const read = await runtime.read('owner');
  assert.equal(read.readiness, 'insufficient_evidence');
  assert.equal(read.coverageGaps[0].reason, 'source_window_capped');
});

test('Task updates after snapshot capture remain gaps until a fresh read', async (t) => {
  const f = fixture(t);
  const source = f.addSource('Please prepare a presentation');
  const admitted = await f.admit(source);
  const runtime = new CustodyOpportunityRuntime({
    ...f.deps,
    tasks: {
      async listByKind(kind) {
        f.advance(1);
        await f.lifecycle.update({
          taskId: admitted.ownerRef.replace('task:item:', ''),
          expectedRevision: 1,
          status: 'doing',
        });
        return f.tasks.listByKind(kind);
      },
    },
  });
  const raced = await runtime.read('owner');
  assert.deepEqual(raced.coverageGaps, [
    { sourceRef: `message:${source.id}`, reason: 'owner_changed_during_snapshot' },
  ]);
  assert.equal(raced.measurement.episodes.length, 0);
  const fresh = await f.runtime.read('owner');
  assert.deepEqual(fresh.coverageGaps, []);
  assert.equal(fresh.measurement.episodes.length, 1);
});

test('runtime observer time and event triggers coalesce and stop after close', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const observer = startCustodyOpportunityObservation({
    ownerUserId: 'owner',
    intervalMs: 5,
    runtime: {
      register() {},
      async reconcile() {
        calls++;
        await pending;
        return null;
      },
    },
    onError(error) {
      throw error;
    },
    onReviewDue() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  release();
  await observer.close();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1);
});
