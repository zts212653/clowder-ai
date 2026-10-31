import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { buildActionSuccessorFence } from '../../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from '../../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { claimActionSuccessor } from '../../dist/domains/ball-custody/action-successor-state-machine.js';
import { ContextSourceAdmission } from '../../dist/domains/memory/cue/ContextSourceAdmission.js';
import {
  CONTEXT_SOURCE_OPPORTUNITY_SCHEMA,
  ContextSourceOpportunityStore,
} from '../../dist/domains/memory/cue/ContextSourceOpportunityStore.js';

const databases = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(CONTEXT_SOURCE_OPPORTUNITY_SCHEMA);
  const store = new ContextSourceOpportunityStore(db);
  const source = { id: 'source', userId: 'owner', threadId: 'thread', catId: null, content: 'A natural task.' };
  const thread = { id: 'thread', createdBy: 'owner', projectPath: '/project' };
  const admission = new ContextSourceAdmission({
    store,
    messages: { getById: async () => source },
    threads: { get: async () => thread },
    tasks: { get: async () => null, listByThread: async () => [] },
  });
  const input = {
    scope: { ownerUserId: 'owner', threadId: 'thread', invocationId: 'invocation' },
    consumerCatId: 'cat',
    exactSourceMessageId: 'source',
    ownerAuthProvenance: 'strict',
    ingress: { kind: 'owner', sourceMessageId: 'source' },
    now: 1000,
    decision: {
      scopeKey: 'owner::cat::thread',
      contextEpoch: 1,
      contextMode: 'cold',
      lastTransitionRef: 'native',
      consumedCompactionEventIds: [],
      boundRuntimeSessionId: 'runtime',
      transition: 'scope_first_seen',
      normalizedDisposition: {
        state: 'fresh',
        reason: 'no_prior_session',
        evidenceRef: 'native',
        runtimeSessionId: 'runtime',
      },
    },
  };
  return { db, store, source, thread, admission, input };
}

test('epoch identity cannot be borrowed from a different owner, cat or thread', async () => {
  for (const scopeKey of ['other::cat::thread', 'owner::other::thread', 'owner::cat::other']) {
    const f = fixture();
    f.input.decision.scopeKey = scopeKey;
    assert.equal(await f.admission.prepare(f.input), null);
  }
});

test('hidden whispers cannot mint an opportunity for another cat', async () => {
  const f = fixture();
  Object.assign(f.source, { visibility: 'whisper', whisperTo: ['another-cat'] });
  assert.equal(await f.admission.prepare(f.input), null);
});

test('normalized fresh evidence cannot name a different runtime binding', async () => {
  const f = fixture();
  f.input.decision.normalizedDisposition.runtimeSessionId = 'foreign-runtime';
  assert.equal(await f.admission.prepare(f.input), null);
});

test('three normalized fresh reasons admit; cold/unknown/resume/carrier do not create', async () => {
  for (const reason of ['no_prior_session', 'resume_rejected', 'resume_failed']) {
    const f = fixture();
    f.input.decision.normalizedDisposition.reason = reason;
    assert.equal((await f.admission.prepare(f.input))?.kind, 'fresh_context_sources');
  }
  for (const transition of ['unknown', 'binding_mismatch', 'resumed', 'context_compaction_replay']) {
    const f = fixture();
    f.input.decision.transition = transition;
    assert.equal(await f.admission.prepare(f.input), null);
  }
  const f = fixture();
  f.input.decision.normalizedDisposition.reason = 'carrier_forces_fresh';
  assert.equal(await f.admission.prepare(f.input), null);
});

test('uncommitted retry preserves id and expiry, commit prevents another presentation', async () => {
  const f = fixture();
  const first = await f.admission.prepare(f.input);
  assert.ok(first);
  f.input.decision.transition = 'resumed';
  f.input.decision.normalizedDisposition = {
    state: 'resumed',
    reason: 'resume_confirmed',
    evidenceRef: 'resume',
    runtimeSessionId: 'runtime',
  };
  const second = await f.admission.prepare({ ...f.input, now: 2000 });
  assert.deepEqual(second, first);
  const record = f.store.find('owner::cat::thread', 1, 'source', 'cat');
  f.store.markProviderCommitted(record.opportunityId, 'generation');
  assert.equal(await f.admission.prepare(f.input), null);
});

test('different source cannot inherit uncommitted cold; bindings/expiry are rechecked', async () => {
  const f = fixture();
  const first = await f.admission.prepare(f.input);
  assert.ok(first);
  f.source.id = 'later';
  f.input.ingress.sourceMessageId = 'later';
  f.input.exactSourceMessageId = 'later';
  assert.equal(await f.admission.prepare(f.input), null);
  f.source.id = 'source';
  const record = f.store.find('owner::cat::thread', 1, 'source', 'cat');
  assert.equal(await f.admission.validate(record.opportunityId, f.input.scope, 'cat', 2000), true);
  f.thread.projectPath = '/changed';
  assert.equal(await f.admission.validate(record.opportunityId, f.input.scope, 'cat', 2000), false);
  f.thread.projectPath = '/project';
  assert.equal(await f.admission.validate(record.opportunityId, f.input.scope, 'cat', 301000), false);
});

test('replaced and exact authoritative compaction admit, runtime mismatch/replay do not', async () => {
  for (const transition of ['replaced', 'context_compacted']) {
    const f = fixture();
    f.input.decision.transition = transition;
    f.input.decision.normalizedDisposition = {
      state: 'replaced',
      reason: 'runtime_replaced',
      evidenceRef: 'replacement',
      runtimeSessionId: 'runtime',
    };
    f.input.decision.consumedCompactionEventIds = ['stable-provider-event'];
    const first = await f.admission.prepare(f.input);
    assert.ok(first);
    assert.deepEqual(await f.admission.prepare({ ...f.input, now: 2000 }), first, transition);
  }
  const f = fixture();
  f.input.decision.transition = 'replaced';
  f.input.decision.normalizedDisposition = {
    state: 'replaced',
    reason: 'runtime_replaced',
    evidenceRef: 'replacement',
    runtimeSessionId: 'wrong',
  };
  assert.equal(await f.admission.prepare(f.input), null);
});

function authorizedFixture() {
  const f = fixture();
  f.source.catId = 'sender';
  f.source.from = { kind: 'agent', catId: 'sender' };
  const task = {
    id: 'task',
    kind: 'work',
    ownerCatId: 'cat',
    threadId: 'thread',
    userId: 'owner',
    status: 'doing',
    updatedAt: 500,
  };
  const lease = claimActionSuccessor(null, {
    leaseId: 'lease',
    tenantScope: 'owner',
    subjectRef: 'subject:task:task',
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['cat'],
    dispatchId: 'dispatch',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread',
    predecessorCatId: 'sender',
    predecessorThreadId: 'sender-thread',
    issuerStandingEvidenceRef: 'message:source',
    evidenceRefs: ['message:source'],
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: 'subject:task:task',
      predicate: { kind: 'task_done' },
    }),
    now: 1000,
  }).lease;
  lease.dispatchDeliveredMessageId = 'source';
  f.input.ingress = {
    kind: 'queue_agent',
    sourceMessageId: 'source',
    actionSuccessorFence: buildActionSuccessorFence(lease, 'dispatch'),
  };
  f.admission = new ContextSourceAdmission({
    store: f.store,
    messages: { getById: async () => f.source },
    threads: { get: async () => f.thread },
    tasks: { get: async () => task, listByThread: async () => [task] },
    leases: { get: async () => lease },
  });
  return { ...f, task, lease };
}

test('real structured implement lease plus exact Task is required and revalidated', async () => {
  const f = authorizedFixture();
  const seed = await f.admission.prepare(f.input);
  assert.equal(seed?.kind, 'authorized_task_sources');
  const record = f.store.find('owner::cat::thread', 1, 'source', 'cat');
  assert.equal(await f.admission.validate(record.opportunityId, f.input.scope, 'cat', 2000), true);
  f.task.status = 'done';
  assert.equal(await f.admission.validate(record.opportunityId, f.input.scope, 'cat', 2000), false);
});

test('equivalent fence field order survives persistence and same-source retry', async () => {
  const f = authorizedFixture();
  const original = f.input.ingress.actionSuccessorFence;
  // Redis Lua cjson does not preserve JavaScript object insertion order.
  f.input.ingress.actionSuccessorFence = {
    dispatchId: original.dispatchId,
    generation: original.generation,
    leaseId: original.leaseId,
    invocationLineageRef: original.invocationLineageRef,
    terminalPredicateDigest: original.terminalPredicateDigest,
  };
  assert.deepEqual(f.input.ingress.actionSuccessorFence, original);
  const first = await f.admission.prepare(f.input);
  assert.equal(first?.kind, 'authorized_task_sources');
  const record = f.store.find('owner::cat::thread', 1, 'source', 'cat');
  assert.equal(await f.admission.validate(record.opportunityId, f.input.scope, 'cat', 2000), true);
  f.input.ingress.actionSuccessorFence = original;
  assert.deepEqual(await f.admission.prepare({ ...f.input, now: 2000 }), first);
});

test('every persisted fence field remains part of the final authority identity', async () => {
  for (const key of ['leaseId', 'generation', 'dispatchId', 'terminalPredicateDigest', 'invocationLineageRef']) {
    const f = authorizedFixture();
    await f.admission.prepare(f.input);
    const record = f.store.find('owner::cat::thread', 1, 'source', 'cat');
    const ingress = record.ingress;
    ingress.actionSuccessorFence[key] = key === 'generation' ? 2 : 'changed';
    f.db
      .prepare('UPDATE memory_cue_context_opportunities SET ingress_json=? WHERE opportunity_id=?')
      .run(JSON.stringify(ingress), record.opportunityId);
    assert.equal(await f.admission.validate(record.opportunityId, f.input.scope, 'cat', 2000), false, key);
  }
});

for (const [name, mutate] of [
  [
    'strict only/FYI',
    (f) => {
      delete f.input.ingress.actionSuccessorFence;
    },
  ],
  [
    'wrong generation',
    (f) => {
      f.lease.generation += 1;
    },
  ],
  [
    'wrong digest',
    (f) => {
      f.input.ingress.actionSuccessorFence.terminalPredicateDigest = 'wrong';
    },
  ],
  [
    'wrong source',
    (f) => {
      f.lease.dispatchDeliveredMessageId = 'another-message';
    },
  ],
  [
    'wrong tenant',
    (f) => {
      f.lease.tenantScope = 'another-owner';
    },
  ],
  [
    'wrong cat',
    (f) => {
      f.lease.holderCatIds = ['other'];
    },
  ],
  [
    'wrong thread',
    (f) => {
      f.lease.holderThreadId = 'other';
    },
  ],
  [
    'terminal lease',
    (f) => {
      f.lease.status = 'completed';
    },
  ],
  [
    'terminal Task',
    (f) => {
      f.task.status = 'done';
    },
  ],
  [
    'compat owner',
    (f) => {
      f.input.ownerAuthProvenance = 'compatibility_fallback';
    },
  ],
  [
    'external connector',
    (f) => {
      f.source.source = { connector: 'external', label: 'External', icon: '' };
    },
  ],
])
  test(`${name} has zero task opportunities`, async () => {
    const f = authorizedFixture();
    mutate(f);
    assert.equal(await f.admission.prepare(f.input), null);
  });
