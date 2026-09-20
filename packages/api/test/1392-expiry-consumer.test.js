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
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
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
  const messageStore = new MessageStore();
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
    deliveryDeps: { messageStore },
    log,
    now: () => now,
  });
  const resolves = [];
  const wakes = [];
  const spec = createConflictCheckTaskSpec({
    taskStore,
    checkMergeable: async () => ({ mergeState, headSha: HEAD }),
    conflictRouter: new ConflictRouter({ taskStore, deliveryDeps: { messageStore }, waitLifecycle: lifecycle, log }),
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
    invokeTrigger: { trigger: async (...args) => wakes.push({ reason: args[6].reason, content: args[3] }) },
    log,
  });
  const poll = async () => {
    const gate = await spec.admission.gate();
    for (const item of gate.run ? gate.workItems : []) {
      await spec.run.execute(item.signal, item.subjectKey, {});
    }
  };
  const contents = () => messageStore.getByThread('thread_1').map((message) => message.content);
  return { taskStore, task, poll, resolves, wakes, contents };
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
    const { poll, resolves, wakes, contents } = await tracked({
      when: [{ kind: 'pr_became_conflicting' }],
      expiresAt: DEADLINE,
      now: DEADLINE + 1,
      autoResolve: { kind: 'resolved', branch: 'feature', method: 'rebase' },
    });

    await poll();

    assert.deepEqual(resolves, [], 'an ended wait does not authorise a rebase, whatever its last poll saw');
    assert.deepEqual(
      wakes.map((wake) => wake.reason),
      ['github_wait_satisfied'],
      'the owner hears the expiry, and it is not filed as a conflict wake',
    );
    const message = contents().join('\n');
    assert.match(message, /conflicting/i, 'the fact the wait ended on is still delivered, not deleted');
    assert.match(message, /deadline passed/i, 'and it is delivered as an expiry');
  });

  it('a conflict the caller armed still wakes its owner when auto-resolution escalates', async () => {
    const { poll, resolves, wakes } = await tracked({
      when: [{ kind: 'pr_became_conflicting' }],
      now: 1_000,
      autoResolve: { kind: 'escalated', branch: 'feature', files: ['a.ts'] },
    });

    await poll();

    assert.deepEqual(resolves, ['owner/repo#7']);
    assert.deepEqual(
      wakes.map((wake) => wake.reason),
      ['github_pr_conflict'],
      'an escalated conflict is still a conflict wake',
    );
  });
});
