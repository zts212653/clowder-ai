import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * #1392 (review 5310717691, P1): not being woken by your own push must not cost you what the push
 * leads to.
 *
 * A wait's baseline only advances when a predicate matches, and CI and conflict are judged against
 * the HEAD the baseline was installed on. `pr_head_changed` used to be the match that moved the
 * baseline onto a new HEAD. Once the author's default stopped arming it, a push matched nothing, the
 * baseline stayed on the old HEAD, and the new HEAD's CI result and conflict could never match:
 * the author was never told their CI finished.
 *
 * These drive the real lifecycle from the author's default registration: A → B pending → B pass,
 * and the conflict path. Only the stores are in memory.
 */
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { expandGitHubPrTrackingGoal } = await import('../../shared/dist/types/github-wait.js');

const A = 'aaaa1111aaaa1111';
const B = 'bbbb2222bbbb2222';
const SUBJECT = 'pr:owner/repo#7';
const log = { info() {}, warn() {}, error() {} };
const AUTHOR = { role: 'subject_author', selfLogin: 'mindfn' };

function authorDefaultWhen() {
  const expansion = expandGitHubPrTrackingGoal(AUTHOR);
  assert.equal(expansion.ok, true, expansion.error);
  return expansion.when;
}

async function tracked(when = authorDefaultWhen()) {
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
      ci: { headSha: A, lastFingerprint: `${A}:pending`, lastBucket: 'pending' },
      conflict: { mergeState: 'MERGEABLE', lastFingerprint: `${A}:MERGEABLE` },
      await: {
        v: 1,
        generation: 1,
        subjectRef: SUBJECT,
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: {
          capturedAt: 100,
          headSha: A,
          review: { inlineCommentCursor: 10, conversationCommentCursor: 30, decisionCursor: 40 },
          ci: { bucket: 'pending', fingerprint: `${A}:pending` },
          conflict: { mergeState: 'MERGEABLE' },
        },
        // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
        continuation: { when, then: 'Continue.' },
        createdAt: 100,
      },
    },
  });
  let clock = 1_000;
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    log,
    now: () => {
      clock += 1_000;
      return clock;
    },
  });
  const observeCi = (headSha, bucket) =>
    lifecycle.observe({
      taskId: task.id,
      facts: { headSha, ci: { bucket, fingerprint: `${headSha}:${bucket}`, blockerCount: 0 } },
      collectorPatch: { ci: { headSha, lastFingerprint: `${headSha}:${bucket}`, lastBucket: bucket } },
    });
  const observeConflict = (headSha, mergeState) =>
    lifecycle.observe({
      taskId: task.id,
      facts: { headSha, conflict: { mergeState } },
      collectorPatch: { conflict: { mergeState, lastFingerprint: `${headSha}:${mergeState}` } },
    });
  const contents = () => messageStore.getByThread('thread_1').map((message) => message.content);
  return { taskStore, task, observeCi, observeConflict, contents };
}

describe('#1392 P1 — the author still hears what their push leads to', () => {
  it('A → B pending → B pass: the pushed HEAD’s CI result reaches the author', async () => {
    const { observeCi, contents } = await tracked();

    await observeCi(B, 'pending');
    assert.deepEqual(contents(), [], 'the push itself is not a wake');

    const result = await observeCi(B, 'pass');
    assert.equal(
      result.kind,
      'notified',
      `CI on the pushed HEAD must be delivered, got ${result.kind}/${result.reason}`,
    );
    assert.equal(contents().length, 1);
    assert.match(contents()[0], /pass/);
  });

  it('the pushed HEAD becoming conflicting reaches the author', async () => {
    const { observeConflict, contents } = await tracked();

    await observeConflict(B, 'MERGEABLE');
    assert.deepEqual(contents(), [], 'the push itself is not a wake');

    const result = await observeConflict(B, 'CONFLICTING');
    assert.equal(
      result.kind,
      'notified',
      `a conflict on the pushed HEAD must be delivered, got ${result.kind}/${result.reason}`,
    );
    assert.match(contents().join('\n'), /conflicting/);
  });

  it('CI already finished when the push is first seen is still reported, exactly once', async () => {
    const { observeCi, contents } = await tracked();

    await observeCi(B, 'pass');
    await observeCi(B, 'pass');
    await observeCi(B, 'pass');

    assert.equal(contents().length, 1, `one delivery for one result, got ${JSON.stringify(contents())}`);
    assert.match(contents()[0], /pass/);
  });

  /*
   * The same stranding existed before for any explicit `when[]` that watches CI without watching
   * HEAD: a push left it judging the old HEAD forever. Following the HEAD fixes both.
   */
  it('an explicit CI-only wait is not stranded by a push either', async () => {
    const { observeCi, contents } = await tracked([{ kind: 'pr_ci_terminal' }]);

    await observeCi(B, 'pending');
    const result = await observeCi(B, 'fail');

    assert.equal(result.kind, 'notified', `got ${result.kind}/${result.reason}`);
    assert.match(contents()[0], /fail/);
  });
});
