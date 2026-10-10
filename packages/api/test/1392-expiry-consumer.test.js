import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * #1392 R5: the expiry outcome AC-2 made deliverable has a consumer that acts on repositories.
 *
 * `ConflictCheckTaskSpec` asks `ConflictRouter` to deliver, and the router used to collapse every
 * delivery into "notified". The consumer then read "there is a notification" as "a conflict matched"
 * and ran the auto-resolver — a rebase and a force-with-lease push in production — for a wait whose
 * owner only ever asked about HEAD. On success it returned early, so the expiry itself never woke
 * anyone: the wait ended silently while the repo was written to.
 *
 * These cases drive the real router, the real wait lifecycle and the real task spec; only the GitHub
 * observation and the auto-executor are in-memory doubles, so the typed outcome under test is the one
 * production builds.
 */
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { connectorDeliveryHarness } = await import('./helpers/connector-delivery-harness.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { ConflictRouter } = await import('../dist/infrastructure/email/ConflictRouter.js');
const { createConflictCheckTaskSpec } = await import('../dist/infrastructure/email/ConflictCheckTaskSpec.js');

const HEAD = 'aaaa1111';
const SUBJECT = 'pr:owner/repo#7';
const DEADLINE = 5_000;
const log = { info() {}, warn() {}, error() {} };

function prAwait(when, expiresAt) {
  return {
    v: 1,
    generation: 1,
    subjectRef: SUBJECT,
    ownerFence: { kind: 'containing_task', generation: 1 },
    baseline: {
      capturedAt: 200,
      headSha: HEAD,
      review: { inlineCommentCursor: 10, conversationCommentCursor: 30, decisionCursor: 40 },
      ci: { bucket: 'pending', fingerprint: `${HEAD}:pending` },
      conflict: { mergeState: 'MERGEABLE' },
    },
    // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
    continuation: { when, then: 'Re-lock the exact HEAD.' },
    createdAt: 200,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** A live PR wait, plus the poller that watches it, wired the way bootstrap wires them. */
async function tracked({ when, expiresAt, now, mergeState = 'CONFLICTING', autoResolve }) {
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
      await: prAwait(when, expiresAt),
    },
  });
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: harness.deliveryDeps,
    log,
    now: () => now,
  });
  const resolves = [];
  const spec = createConflictCheckTaskSpec({
    taskStore,
    checkMergeable: async () => ({ mergeState, headSha: HEAD }),
    conflictRouter: new ConflictRouter({
      taskStore,
      deliveryDeps: harness.deliveryDeps,
      waitLifecycle: lifecycle,
      log,
    }),
    ...(autoResolve
      ? {
          autoExecutor: {
            resolve: async (repoFullName, prNumber) => {
              resolves.push(`${repoFullName}#${prNumber}`);
              return autoResolve;
            },
          },
        }
      : {}),
    log,
  });
  const poll = async () => {
    const gate = await spec.admission.gate();
    for (const item of gate.run ? gate.workItems : []) {
      await spec.run.execute(item.signal, item.subjectKey, {});
    }
  };
  const contents = () => harness.contents('thread_1');
  /*
   * The wake is observed where production produces it: an envelope admitted to the Queue and reaching
   * drain IS the owner's wake. This file used to watch a `ConnectorInvokeTrigger` handed in by the
   * test itself — a seam `github-schedule-factories` never wires, so the assertions described a
   * configuration production has never run, while the admission that really wakes the owner went
   * unobserved.
   */
  const wakes = harness.wakes;
  /** How each admitted wake is filed for the owner reading it. */
  const filed = () =>
    harness.admitted('thread_1').map((entry) => ({
      priority: entry.priority,
      sourceCategory: entry.sourceCategory,
    }));
  return { taskStore, task, poll, resolves, wakes, contents, filed };
}

describe('#1392 R5 — a delivery is not a verdict', () => {
  it('an expired HEAD-only wait is delivered to its owner and never drives a repo write', async () => {
    const { poll, resolves, wakes, contents } = await tracked({
      when: [{ kind: 'pr_head_changed' }],
      expiresAt: DEADLINE,
      now: DEADLINE + 1,
      autoResolve: { kind: 'resolved', branch: 'feature', method: 'rebase' },
    });

    await poll();

    assert.deepEqual(resolves, [], 'the owner asked about HEAD, so no conflict was matched to act on');
    assert.equal(wakes.length, 1, 'the expiry still owes its owner a wake');
    assert.match(contents().join('\n'), /expired|deadline/i, 'and the message says the wait ended');
  });

  it('the same wait before its deadline writes nothing and wakes nobody', async () => {
    const { poll, resolves, wakes } = await tracked({
      when: [{ kind: 'pr_head_changed' }],
      expiresAt: DEADLINE,
      now: DEADLINE - 1,
      autoResolve: { kind: 'resolved', branch: 'feature', method: 'rebase' },
    });

    await poll();

    assert.deepEqual(resolves, [], 'an unmatched HEAD wait is not a conflict either');
    assert.deepEqual(wakes, [], 'and there is nothing to report yet');
  });

  it('a wait that armed the conflict condition still auto-resolves, so F140 is untouched', async () => {
    const { poll, resolves } = await tracked({
      when: [{ kind: 'pr_became_conflicting' }],
      now: 1_000,
      autoResolve: { kind: 'resolved', branch: 'feature', method: 'rebase' },
    });

    await poll();

    assert.deepEqual(resolves, ['owner/repo#7'], 'the condition the caller armed is the one that may act');
  });

  /*
   * The deadline branch deliberately keeps the last poll's deltas so the owner still sees the facts
   * the wait ended on. That record is a report, not a renewed mandate: the wait's authority ended
   * with it, so a conflict observed only after the deadline may be told, never acted on.
   */
  it('an expired wait that saw the conflict reports the fact and still does not act on it', async () => {
    const { poll, resolves, wakes, contents, filed } = await tracked({
      when: [{ kind: 'pr_became_conflicting' }],
      expiresAt: DEADLINE,
      now: DEADLINE + 1,
      autoResolve: { kind: 'resolved', branch: 'feature', method: 'rebase' },
    });

    await poll();

    assert.deepEqual(resolves, [], 'an ended wait does not authorise a rebase, whatever its last poll saw');
    assert.equal(wakes.length, 1, 'the owner still hears the expiry');
    assert.deepEqual(
      filed(),
      [{ priority: 'normal', sourceCategory: undefined }],
      'an expiry is an ordinary wait delivery — normal, and filing it as a conflict would misfile it',
    );
    const message = contents().join('\n');
    assert.match(message, /conflicting/i, 'the fact the wait ended on is still delivered, not deleted');
    assert.match(message, /deadline passed/i, 'and it is delivered as an expiry');
  });

  it('a conflict the caller armed still wakes its owner when auto-resolution escalates', async () => {
    const { poll, resolves, wakes, filed } = await tracked({
      when: [{ kind: 'pr_became_conflicting' }],
      now: 1_000,
      autoResolve: { kind: 'escalated', branch: 'feature', files: ['a.ts'] },
    });

    await poll();

    assert.deepEqual(resolves, ['owner/repo#7']);
    assert.equal(wakes.length, 1, 'an escalated conflict still wakes its owner');
    assert.deepEqual(
      filed(),
      [{ priority: 'urgent', sourceCategory: 'conflict' }],
      'and it is filed as the conflict it is — derived from the matched outcome, not from a policy ' +
        'object on a trigger that production never wires',
    );
  });
});
