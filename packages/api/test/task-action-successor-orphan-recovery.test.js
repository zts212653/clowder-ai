import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { TaskActionSuccessorOrphanRecovery } from '../dist/domains/ball-custody/TaskActionSuccessorOrphanRecovery.js';
import { buildCallbackPostMessageIdempotencyKey } from '../dist/domains/cats/services/agents/routing/callback-message-idempotency.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { retiredHash } from './helpers/retired-turn-execution-fixture.js';

const redis = ownedRedisFixture('f167-721-legacy-recovery');
const taskId = 'task-721';
const ownerThreadId = 'thread-owner';
const childThreadId = 'thread-approved-child';
const ownerCatId = 'codex-astra';
const holderCatId = 'codex-sol';
const clientMessageId = 'old-task-721-carrier';

function task(overrides = {}) {
  return {
    id: taskId,
    kind: 'work',
    threadId: ownerThreadId,
    subjectKey: 'entrusted:task-721',
    title: 'Recover orphan carrier',
    ownerCatId,
    status: 'doing',
    why: 'same approved child continues Task721',
    createdBy: ownerCatId,
    createdAt: 1,
    updatedAt: 100,
    userId: 'user-1',
    entrustedWork: {
      revision: 12,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:human-source'],
        idempotencyKey: 'task-721-admission',
        receiptRef: 'receipt:task-721',
        admittedAt: 1,
      },
      developmentScope: {
        featureRef: 'feature:F167',
        phaseKey: 'R',
        workUnitRef: `task:work:${taskId}`,
        acceptedSourceRef: 'file:docs/features/F167-a2a-chain-quality.md',
        acceptedRevision: 'a'.repeat(40),
      },
      intendedOutcome: 'Recover a committed orphan action carrier exactly once',
      time: {},
      artifactRefs: [],
      closure: { state: 'open', condition: 'merged and loaded', expectedSignal: 'task_done', evidenceRefs: [] },
    },
    ...overrides,
  };
}

function lease(overrides = {}) {
  const subjectRef = `subject:task:${taskId}`;
  return {
    leaseId: 'lease-task-721',
    key: `user-1|${subjectRef}|implement|implementer`,
    tenantScope: 'user-1',
    subjectRef,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [holderCatId],
    dispatchId: `cross-post:${clientMessageId}`,
    claimOrigin: 'structured_transfer',
    holderThreadId: childThreadId,
    predecessorCatId: ownerCatId,
    predecessorThreadId: ownerThreadId,
    issuerStandingEvidenceRef: `callback:old:${clientMessageId}`,
    generation: 3,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef,
      predicate: { kind: 'task_done' },
    }),
    evidenceRefs: [
      `callback:old:${clientMessageId}`,
      `proposal:proposal-721:approved:thread:${childThreadId}:cat:${holderCatId}`,
    ],
    returnTransitions: [],
    replacementTransitions: [],
    orphanCarrierRecoveryTransitions: [],
    revision: 5,
    createdAt: 1,
    updatedAt: 100,
    ...overrides,
  };
}

function admission(current = lease()) {
  return {
    tenantScope: 'user-1',
    actorCatId: ownerCatId,
    sourceThreadId: ownerThreadId,
    targetThreadId: childThreadId,
    holderCatIds: [holderCatId],
    dispatchId: 'cross-post:recover-task-721',
    evidenceRef: 'callback:new:recover-task-721',
    now: 200,
    action: {
      subjectRef: current.subjectRef,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      terminalPredicate: { kind: 'task_done' },
    },
  };
}

async function fixture(overrides = {}) {
  const messages = new MessageStore();
  const source = (
    await messages.appendIdempotent({
      threadId: childThreadId,
      userId: 'user-1',
      from: { kind: 'agent', catId: ownerCatId },
      content: 'Implement Task721 in the approved child',
      mentions: [holderCatId],
      origin: 'callback',
      timestamp: 50,
      deliveryStatus: 'queued',
      idempotencyKey: buildCallbackPostMessageIdempotencyKey(ownerCatId, clientMessageId),
      extra: {
        crossPost: { sourceThreadId: ownerThreadId, sourceInvocationId: 'owner-invocation' },
        targetCats: [holderCatId],
        stream: { invocationId: 'owner-parent', turnInvocationId: 'owner-invocation' },
      },
    })
  ).message;
  await messages.markDelivered(source.id, 60);
  const currentTask = task();
  const currentLease = lease();
  const commits = [];
  const adopted = [];
  const warnings = [];
  const deps = {
    logger: { warn: (...args) => warnings.push(args) },
    tasks: {
      async get(id) {
        return id === taskId ? currentTask : null;
      },
    },
    messages,
    queue: {
      async listAllDurable() {
        return [];
      },
      async adoptCommittedAdmission(entries, message) {
        adopted.push({ entries, message });
        return entries;
      },
    },
    invocationRecords: {
      async scanAll() {
        return [];
      },
    },
    turnExecutions: {
      async listBySource() {
        return [];
      },
    },
    delegates: {
      async getForTask() {
        return [
          {
            catId: holderCatId,
            threadId: childThreadId,
            evidenceRef: `proposal:proposal-721:approved:thread:${childThreadId}:cat:${holderCatId}`,
          },
        ];
      },
    },
    atomicStore: {
      async commit(input) {
        commits.push(input);
        return { outcome: 'committed', lease: input.nextLease };
      },
    },
    ...overrides,
  };
  const service = new TaskActionSuccessorOrphanRecovery(deps);
  return { service, deps, source, currentTask, currentLease, commits, adopted, warnings };
}

describe('Task ActionSuccessor orphan carrier recovery', () => {
  test('requires current Task/delegate truth and admits the original source on a new fenced generation', async () => {
    const f = await fixture();
    const result = await f.service.recover({
      lease: f.currentLease,
      admissionInput: admission(f.currentLease),
      ownerAuthProvenance: 'strict',
      parentInvocationId: 'owner-parent',
    });

    assert.equal(result.outcome, 'recovered');
    assert.equal(result.messageId, f.source.id);
    assert.equal(result.lease.generation, 4);
    assert.equal(f.commits.length, 1);
    assert.equal(f.commits[0].task.entrustedWork.revision, 12);
    assert.equal(f.commits[0].entry.payload.sourceRecordId, f.source.id);
    assert.equal(f.commits[0].entry.execution.actionSuccessorFence.generation, 4);
    assert.equal(f.adopted.length, 1);
  });

  test('recovers through the real Redis source reader with a retired history row, but refuses relevant legacy coverage', async () => {
    const client = redis.client('f167-721-recovery:');
    const turns = new RedisTurnExecutionStore(client);
    const unrelated = retiredHash('unrelated');
    await client.hset('turnexec:record:unrelated', unrelated);
    const f = await fixture({ turnExecutions: turns });
    const request = { lease: f.currentLease, admissionInput: admission(f.currentLease), ownerAuthProvenance: 'strict' };
    assert.equal((await f.service.recover(request)).outcome, 'recovered');
    assert.equal(f.commits.length, 1);
    assert.equal(f.adopted.length, 1);
    assert.deepEqual(await client.hgetall('turnexec:record:unrelated'), unrelated);
    const relevant = retiredHash('relevant', {
      userId: 'user-1',
      threadId: childThreadId,
      catId: holderCatId,
      causal: { triggerMessageId: f.source.id, freshnessSupplementId: 'old-supplement' },
    });
    await client.hset('turnexec:record:relevant', relevant);
    assert.deepEqual(await f.service.recover(request), { outcome: 'refused', reason: 'execution_unreadable' });
    assert.equal(f.commits.length, 1);
    assert.equal(f.adopted.length, 1);
    assert.equal(f.warnings[0]?.[0].stage, 'turn_executions');
    assert.deepEqual(await client.hgetall('turnexec:record:relevant'), relevant);
  });

  test('refuses missing execution readers instead of treating an empty Queue as proof', async () => {
    const f = await fixture({ invocationRecords: {} });
    const result = await f.service.recover({
      lease: f.currentLease,
      admissionInput: admission(f.currentLease),
      ownerAuthProvenance: 'strict',
    });
    assert.deepEqual(result, { outcome: 'refused', reason: 'execution_unreadable' });
    assert.equal(f.commits.length, 0);
    assert.equal(f.warnings[0]?.[0].stage, 'invocation_records');
  });

  test('names every failing execution reader without exposing source content or committing recovery', async () => {
    for (const [dependency, method, stage] of [
      ['queue', 'listAllDurable', 'queue_ledger'],
      ['invocationRecords', 'scanAll', 'invocation_records'],
      ['turnExecutions', 'listBySource', 'turn_executions'],
    ]) {
      const f = await fixture();
      const failure = new Error('read unavailable');
      f.deps[dependency][method] = () => {
        throw failure;
      };
      assert.deepEqual(
        await f.service.recover({
          lease: f.currentLease,
          admissionInput: admission(f.currentLease),
          ownerAuthProvenance: 'strict',
        }),
        { outcome: 'refused', reason: 'execution_unreadable' },
      );
      assert.equal(f.commits.length, 0);
      assert.equal(f.warnings.length, 1);
      const [details] = f.warnings[0];
      assert.equal(details.stage, stage);
      assert.equal(details.err, failure);
      assert.equal(details.leaseId, f.currentLease.leaseId);
      assert.equal(details.generation, f.currentLease.generation);
      assert.equal(details.sourceMessageId, f.source.id);
      assert.equal(JSON.stringify(details).includes(f.source.content), false);
    }
  });

  test('refuses a legacy source scan that cannot reach the lease boundary', async () => {
    let scanPages = 0;
    const f = await fixture({
      messages: {
        async getByIdempotencyKey() {
          return null;
        },
        async getByThreadBeforeBounded() {
          scanPages++;
          return {
            messages: [],
            scannedCount: 200,
            storageRoundTrips: 1,
            exhausted: false,
            nextCursor: { timestamp: 500, id: `still-newer-than-the-lease-${scanPages}` },
          };
        },
      },
    });
    assert.deepEqual(
      await f.service.recover({
        lease: f.currentLease,
        admissionInput: admission(f.currentLease),
        ownerAuthProvenance: 'strict',
      }),
      { outcome: 'refused', reason: 'source_scan_incomplete' },
    );
    assert.equal(scanPages, 25);
    assert.equal(f.commits.length, 0);
  });

  test('refuses any pending carrier or exact execution instead of starting a second writer', async () => {
    const pending = await fixture();
    pending.deps.queue.listAllDurable = async () => [
      {
        payload: { sourceRecordId: pending.source.id },
        execution: {},
      },
    ];
    assert.deepEqual(
      await pending.service.recover({
        lease: pending.currentLease,
        admissionInput: admission(pending.currentLease),
        ownerAuthProvenance: 'strict',
      }),
      { outcome: 'refused', reason: 'carrier_state_present' },
    );

    const running = await fixture();
    running.deps.invocationRecords.scanAll = async () => [
      {
        id: 'parent-execution',
        threadId: childThreadId,
        userId: 'user-1',
        userMessageId: running.source.id,
        targetCats: [holderCatId],
        status: 'running',
        idempotencyKey: `action-successor:${running.source.id}:${holderCatId}`,
        actionLeaseCarrier: {
          kind: 'action_successor',
          leaseId: running.currentLease.leaseId,
          generation: running.currentLease.generation,
        },
        createdAt: 100,
        updatedAt: 100,
      },
    ];
    assert.deepEqual(
      await running.service.recover({
        lease: running.currentLease,
        admissionInput: admission(running.currentLease),
        ownerAuthProvenance: 'strict',
      }),
      { outcome: 'refused', reason: 'execution_present' },
    );
    assert.equal(pending.commits.length + running.commits.length, 0);
  });

  test('refuses owner, approved-child, and source lifecycle drift', async () => {
    const wrongOwner = await fixture();
    wrongOwner.deps.tasks.get = async () => task({ ownerCatId: 'other-owner' });
    assert.deepEqual(
      await wrongOwner.service.recover({
        lease: wrongOwner.currentLease,
        admissionInput: admission(wrongOwner.currentLease),
        ownerAuthProvenance: 'strict',
      }),
      { outcome: 'refused', reason: 'task_mismatch' },
    );

    const wrongChild = await fixture();
    wrongChild.deps.delegates.getForTask = async () => [];
    assert.deepEqual(
      await wrongChild.service.recover({
        lease: wrongChild.currentLease,
        admissionInput: admission(wrongChild.currentLease),
        ownerAuthProvenance: 'strict',
      }),
      { outcome: 'refused', reason: 'delegate_mismatch' },
    );

    const handled = await fixture();
    const source = await handled.deps.messages.getByIdempotencyKey(
      'user-1',
      childThreadId,
      buildCallbackPostMessageIdempotencyKey(ownerCatId, clientMessageId),
    );
    source.lifecycle = { kind: 'input', orderKey: `60:${source.id}`, dispatchRefs: [] };
    handled.deps.messages.getByIdempotencyKey = async () => source;
    assert.deepEqual(
      await handled.service.recover({
        lease: handled.currentLease,
        admissionInput: admission(handled.currentLease),
        ownerAuthProvenance: 'strict',
      }),
      { outcome: 'refused', reason: 'source_unreadable' },
    );
  });
});
