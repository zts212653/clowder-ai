import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { connectorDeliveryHarness } = await import('./helpers/connector-delivery-harness.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { deliverConnectorMessage } = await import('../dist/infrastructure/email/deliver-connector-message.js');

/**
 * F117 Phase L (roadmap 2c). Upstream relied on an unstated invariant: a delivery that failed threw,
 * which aborted the whole observation. F117 turned a refused delivery into a result, so both of these
 * became reachable: an observation that evaluated past an outcome it could not deliver (and replaced
 * it), and a permanent Queue conflict retried on every poll forever.
 */
const HEAD = 'aaaa1111';
const SUBJECT = 'pr:owner/repo#7';

/** Generation 1's outcome: terminalized, never delivered. */
const stranded = {
  v: 1,
  outcomeId: `wait:${SUBJECT}:g1:matched`,
  generation: 1,
  subjectRef: SUBJECT,
  ownerFence: { kind: 'containing_task', generation: 1 },
  reason: 'matched',
  at: 200,
  delivery: 'pending',
  matched: [{ kind: 'pr_head_changed', delta: 'HEAD 9999999 → aaaa111' }],
  nextStep: 'Re-lock the exact HEAD.',
  renewal: 'rearmed',
};

async function tracked() {
  const taskStore = new TaskStore();
  const harness = connectorDeliveryHarness();
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: SUBJECT,
    threadId: 'thread_1',
    title: 'PR tracking: owner/repo#7',
    ownerCatId: 'opus',
    why: 'test',
    createdBy: 'opus',
    userId: 'user_1',
    automationState: {
      conflict: { mergeState: 'MERGEABLE', lastFingerprint: `${HEAD}:MERGEABLE` },
      waitOutcome: stranded,
      await: {
        v: 1,
        generation: 2,
        subjectRef: SUBJECT,
        ownerFence: { kind: 'containing_task', generation: 2 },
        baseline: { capturedAt: 200, headSha: HEAD, conflict: { mergeState: 'MERGEABLE' } },
        // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
        continuation: { when: [{ kind: 'pr_became_conflicting' }], then: 'Rebase the exact HEAD.' },
        createdAt: 200,
      },
    },
  });
  const errors = [];
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: harness.deliveryDeps,
    now: () => 500,
    log: { info() {}, warn() {}, error: (obj, msg) => errors.push({ obj, msg }) },
  });
  // Refuse deliveries on demand, per outcome, the way the persisted Queue answers. Which outcome is
  // offered is read from its carrier: the idempotency key's format belongs to the lifecycle (upstream
  // #1528 scopes it to the task), so the test does not depend on it.
  const refusals = new Map();
  const realDeliver = harness.delivery.deliver.bind(harness.delivery);
  const attempts = [];
  harness.delivery.deliver = async (input) => {
    const offered = input.source?.meta?.waitContinuationCarrier?.outcomeId ?? input.idempotencyKey;
    attempts.push(offered);
    const refusal = refusals.get(offered) ?? refusals.get('*');
    if (refusal) return { state: refusal, reason: `test ${refusal}` };
    return realDeliver(input);
  };
  const conflictObservation = {
    taskId: task.id,
    facts: { headSha: HEAD, conflict: { mergeState: 'CONFLICTING' } },
    collectorPatch: { conflict: { mergeState: 'CONFLICTING', lastFingerprint: `${HEAD}:CONFLICTING` } },
  };
  return {
    taskStore,
    task,
    lifecycle,
    errors,
    attempts,
    refusals,
    conflictObservation,
    contents: () => harness.contents('thread_1'),
    state: async () => (await taskStore.get(task.id)).automationState,
  };
}

describe('F117 L1: an observation never evaluates past an outcome it could not deliver', () => {
  it('keeps the undelivered outcome and the cursors, then delivers it first once the Queue admits', async () => {
    const t = await tracked();
    t.refusals.set('*', 'unavailable');

    const refused = await t.lifecycle.observe(t.conflictObservation);

    assert.deepEqual(refused, { kind: 'unrecorded', reason: 'queue_admission_unavailable' });
    const held = await t.state();
    assert.equal(held.waitOutcome.outcomeId, stranded.outcomeId, 'the undelivered outcome is not replaced');
    assert.equal(held.waitOutcome.delivery, 'pending');
    assert.equal(held.await.generation, 2, 'the live wait is not consumed by a match nobody can be told about');
    assert.equal(held.conflict.mergeState, 'MERGEABLE', 'the collector cursor stays, so the next poll re-observes');
    assert.equal(t.contents().length, 0);

    t.refusals.clear();
    const offeredBefore = t.attempts.length;
    await t.lifecycle.observe(t.conflictObservation);

    const delivered = t.contents();
    assert.equal(delivered.length, 2, 'the stranded outcome and the new match are both announced');
    assert.ok(delivered.some((content) => /HEAD 9999999 → aaaa111/.test(content)));
    // The Queue lists an urgent conflict first, so order is read from what was offered to it, not its listing.
    assert.equal(t.attempts[offeredBefore], stranded.outcomeId, 'the older outcome is offered first');
    const after = await t.state();
    assert.notEqual(after.waitOutcome.outcomeId, stranded.outcomeId);
    assert.equal(after.waitOutcome.delivery, 'delivered');
    assert.equal(after.conflict.mergeState, 'CONFLICTING');
  });
});

describe('F117 L2: a Queue conflict ends the outcome instead of being retried forever', () => {
  it('marks the outcome queue_conflict, alerts once, and lets the observation carry on', async () => {
    const t = await tracked();
    t.refusals.set(stranded.outcomeId, 'conflict');

    await t.lifecycle.observe(t.conflictObservation);

    assert.equal(t.errors.length, 1, 'a permanent refusal is an error, not a warn repeated every poll');
    assert.equal(t.errors[0].obj.outcomeId, stranded.outcomeId);
    const after = await t.state();
    assert.notEqual(after.waitOutcome.outcomeId, stranded.outcomeId, 'the observation went on to its own match');
    assert.equal(after.waitOutcome.delivery, 'delivered');
    assert.equal(t.contents().length, 1, 'only the new outcome reached the thread');

    const offersOfStranded = () => t.attempts.filter((offered) => offered === stranded.outcomeId).length;
    const retries = offersOfStranded();
    await t.lifecycle.observe({ taskId: t.task.id, facts: { headSha: HEAD, conflict: { mergeState: 'CONFLICTING' } } });
    assert.equal(offersOfStranded(), retries, 'a conflicted outcome is never offered to the Queue again');
  });

  it('keeps an unavailable Queue a retry, not a terminal', async () => {
    const t = await tracked();
    t.refusals.set(stranded.outcomeId, 'unavailable');

    await t.lifecycle.observe(t.conflictObservation);

    assert.equal(t.errors.length, 0);
    assert.equal((await t.state()).waitOutcome.delivery, 'pending');
  });
});

describe('F117 L2: deliverConnectorMessage names why the Queue refused', () => {
  const input = {
    threadId: 'thread_1',
    userId: 'user_1',
    catId: 'opus',
    content: 'hello',
    idempotencyKey: 'key-1',
    source: { connector: 'github-wait', label: 'GitHub Wait', icon: 'github' },
  };
  for (const state of ['conflict', 'unavailable']) {
    it(`reports rejection '${state}' and no admission`, async () => {
      const result = await deliverConnectorMessage(
        { delivery: { deliver: async () => ({ state, reason: 'test' }) } },
        input,
      );
      assert.equal(result.admitted, false);
      assert.equal(result.rejection, state);
    });
  }
});
