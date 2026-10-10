import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { connectorDeliveryHarness } = await import('./helpers/connector-delivery-harness.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { ConflictRouter } = await import('../dist/infrastructure/email/ConflictRouter.js');

/**
 * #1398 — publish and suppress must be decided at one linearization point.
 *
 * Deferring an outcome gives two callers a claim on it: whoever flushes the delivery outbox, and
 * the auto-resolver that deferred it because it might repair the condition itself. Settling the
 * final state under compare-and-set is not enough — the send happens before that write, so a
 * publisher that had merely READ `pending` could still deliver after a suppressor had already won,
 * and one outcome would produce two successful side effects: the owner is woken about a conflict
 * that no longer exists, while the record claims it was suppressed.
 *
 * These cases pin the interleaving deterministically with a barrier, in both orders, rather than
 * hoping a scheduler happens to produce it.
 */
async function setup() {
  const taskStore = new TaskStore();
  const harness = connectorDeliveryHarness();
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#7',
    threadId: 'thread_1',
    title: 'PR wait',
    ownerCatId: 'codex-sol',
    why: 'test',
    createdBy: 'codex-sol',
    userId: 'user_1',
    automationState: {
      conflict: { mergeState: 'MERGEABLE' },
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'pr:owner/repo#7',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: { capturedAt: 100, headSha: 'aaa1111', conflict: { mergeState: 'MERGEABLE' } },
        continuation: {
          when: [{ kind: 'pr_became_conflicting' }],
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
          then: 'Rebase the exact HEAD.',
        },
        expiresAt: 10_000,
        createdAt: 100,
      },
    },
  });

  // The barrier sits on the delivery itself — the side effect. That is the one seam that exists in
  // both the broken and the fixed ordering, so the same case can be red before and green after
  // instead of quietly moving to a different injection point.
  let gate = null;
  const realDeliver = harness.delivery.deliver.bind(harness.delivery);
  let holdNextDeliveries = 0;
  harness.delivery.deliver = async (input) => {
    if (holdNextDeliveries > 0) {
      holdNextDeliveries -= 1;
      await gate;
    }
    return realDeliver(input);
  };
  const openGate = () => {
    let release;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    return () => release();
  };

  const waitLifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: harness.deliveryDeps,
    now: () => 500,
    log: { info() {}, warn() {}, error() {} },
  });
  const router = new ConflictRouter({
    taskStore,
    deliveryDeps: harness.deliveryDeps,
    waitLifecycle,
    log: { info() {}, warn() {}, error() {} },
  });

  const routed = await router.route({
    repoFullName: 'owner/repo',
    prNumber: 7,
    headSha: 'aaa1111',
    mergeState: 'CONFLICTING',
  });
  assert.equal(routed.kind, 'matched_pending', 'the outcome is terminalized and unannounced');
  assert.equal(harness.deliveries('thread_1').length, 0);

  let failOnce = false;
  const rawOutcome = async () => (await taskStore.get(task.id)).automationState.waitOutcome;
  const delivery = async () => (await rawOutcome()).delivery;
  const chained = harness.delivery.deliver;
  harness.delivery.deliver = async (input) => {
    if (failOnce) {
      failOnce = false;
      return { state: 'unavailable', reason: 'queue admission unavailable' };
    }
    return chained(input);
  };
  return {
    router,
    harness,
    routed,
    delivery,
    rawOutcome,
    openGate,
    holdDeliveries: (n) => (holdNextDeliveries = n),
    failNextDelivery: () => {
      failOnce = true;
    },
  };
}

describe('#1398 wait outbox publish/suppress linearization', () => {
  test('publish and suppress can never both succeed', async () => {
    const { router, harness, routed, delivery, openGate, holdDeliveries } = await setup();

    // The publisher is in flight with the outcome it read as `pending`, suspended at the send.
    const release = openGate();
    holdDeliveries(1);
    const publishing = router.publish(routed.taskId, routed.outcome);
    await Promise.resolve();

    // The repair finishes inside that window and asks for the wake to be called off.
    const suppressed = await router.settleWithoutWake(routed.taskId, routed.outcome, 'auto-resolved:rebase');

    release();
    const published = await publishing;
    const wakes = harness.deliveries('thread_1').length;

    // The defect this pins: before the claim existed, the suppressor's compare-and-set only guarded
    // the final state write, so it returned true while the publisher — already past its read — went
    // on to deliver. Both side effects succeeded: the owner was woken about a conflict that had been
    // repaired, and the record said it was suppressed.
    assert.ok(
      !(suppressed && wakes > 0),
      `suppress reported success while ${wakes} wake(s) were delivered — both sides won the race`,
    );

    // Whichever won, the record must describe what actually happened.
    const state = await delivery();
    if (suppressed) {
      assert.equal(wakes, 0, 'a successful suppress means nobody was woken');
      assert.notEqual(published.kind, 'notified');
      assert.equal(state, 'suppressed');
    } else {
      assert.equal(wakes, 1, 'a lost suppress means the owner was woken exactly once');
      assert.equal(published.kind, 'notified');
      assert.equal(state, 'delivered', 'and it is recorded as delivered, not as suppressed');
    }
  });

  test('a publisher that wins makes the suppressor report that the owner was told', async () => {
    const { router, harness, routed, delivery } = await setup();

    const published = await router.publish(routed.taskId, routed.outcome);
    assert.equal(published.kind, 'notified');
    assert.equal(harness.deliveries('thread_1').length, 1, 'exactly one wake');
    assert.equal(await delivery(), 'delivered');

    // The repair finished after the owner was already woken. It must say so rather than rewrite
    // history into `suppressed`, which would claim a wake that demonstrably happened never did.
    assert.equal(await router.settleWithoutWake(routed.taskId, routed.outcome, 'auto-resolved:rebase'), false);
    assert.equal(await delivery(), 'delivered');
    assert.equal(harness.deliveries('thread_1').length, 1, 'and no second wake appears');
  });

  /**
   * Rollback / mixed-version safety for what the claim persists.
   *
   * Every reader that predates this change asks exactly one question: `delivery === 'pending'`.
   * So the claim must not be expressible as a `delivery` value — an older binary reading an unknown
   * one would conclude the outcome is terminal and never deliver it, stranding the owner's wake
   * forever. That is not a theoretical schema worry: it is precisely the crash window (claimed, not
   * yet sent) that the claim was introduced to make recoverable.
   *
   * `oldReaderSeesDeliverable` is that older reader, spelled out literally.
   */
  const oldReaderSeesDeliverable = (outcome) => outcome?.delivery === 'pending';

  test('a claimed outcome still looks deliverable to a reader that only knows `pending`', async () => {
    const { router, harness, routed, rawOutcome, failNextDelivery } = await setup();

    // Claim, then die before the send — the exact state a rollback could land on.
    failNextDelivery();
    const attempt = await router.publish(routed.taskId, routed.outcome);
    assert.notEqual(attempt.kind, 'notified', 'the send did not happen');

    const persisted = await rawOutcome();
    assert.equal(typeof persisted.publishClaimedAt, 'number', 'the claim is persisted');
    assert.ok(
      oldReaderSeesDeliverable(persisted),
      'an older binary must still drain this outcome — encoding the claim in `delivery` would strand it',
    );
    assert.equal(harness.deliveries('thread_1').length, 0);

    // And the new reader recovers it too, converging on one wake rather than a second.
    const resumed = await router.publish(routed.taskId, routed.outcome);
    assert.equal(resumed.kind, 'notified');
    assert.equal(harness.deliveries('thread_1').length, 1, 'exactly one wake after recovery');
  });

  test('a suppressed outcome is never re-woken by a reader that only knows `pending`', async () => {
    const { router, routed, rawOutcome } = await setup();

    assert.equal(await router.settleWithoutWake(routed.taskId, routed.outcome, 'auto-resolved:rebase'), true);

    const persisted = await rawOutcome();
    assert.equal(persisted.delivery, 'suppressed');
    // An older binary reads an unknown value, decides it is not pending, and declines to deliver —
    // which is exactly what suppressed means. Nothing is owed, so nothing can be stranded.
    assert.equal(oldReaderSeesDeliverable(persisted), false, 'a downgrade must not resurrect a suppressed wake');
  });

  test('a claim whose process died is resumed, and still wakes exactly once', async () => {
    const { router, harness, routed, delivery } = await setup();

    const first = await router.publish(routed.taskId, routed.outcome);
    assert.equal(first.kind, 'notified');

    // Re-publishing the same identity converges on the same Queue row instead of a second wake,
    // which is what makes it safe for `pendingOutcome` to hand a stranded claim back to a drain.
    const resumed = await router.publish(routed.taskId, routed.outcome);
    assert.notEqual(resumed.kind, 'notified');
    assert.equal(harness.deliveries('thread_1').length, 1, 'still exactly one wake');
    assert.equal(await delivery(), 'delivered');
  });
});
