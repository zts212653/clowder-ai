/**
 * #1392 AC-6: "IssueCommentTaskSpec does not skip invokeTrigger after observe."
 *
 * With the wait lifecycle wired (production requires it), the issue path called observe() — which
 * writes the owner's message — and then returned before invokeTrigger, the call that actually
 * starts the owner. The message landed in the thread and the cat never ran: "message written" is
 * not "cat started". This drives the real gate → execute → lifecycle chain, stubbing only GitHub.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { createIssueCommentTaskSpec } = await import('../dist/infrastructure/email/IssueCommentTaskSpec.js');
const { createSetupNoiseFilter } = await import('../dist/infrastructure/email/setup-noise-filter.js');

const log = { info() {}, warn() {}, error() {} };

const ANY_UPDATE = { id: 101, author: 'someone', body: 'any update?', createdAt: '2026-09-15T00:00:00Z' };

async function trackedIssue(issueState = 'open', comments = [ANY_UPDATE]) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const task = await taskStore.create({
    kind: 'issue_tracking',
    subjectKey: 'issue:owner/repo#861',
    threadId: 'thread_issue',
    title: 'Issue tracking: owner/repo#861',
    ownerCatId: 'opus',
    why: 'test',
    createdBy: 'opus',
    userId: 'user_1',
    automationState: {
      issue: { lastCommentCursor: 100, lastDeliveredCursor: 100, issueState: 'open' },
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'issue:owner/repo#861',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: { capturedAt: 1, issue: { lastCommentCursor: 100, state: 'open', authorLogin: 'author' } },
        // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
        continuation: { when: [{ kind: 'issue_comment_added' }], then: 'Reply to the issue.' },
        createdAt: 1,
      },
    },
  });
  const waitLifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    now: () => 500,
    log,
  });
  const triggered = [];
  // Wired exactly as production does (index.ts): the real F140 setup-noise filter, not a stub that
  // fakes the verdict. Only GitHub I/O is in memory.
  const setupNoiseFilter = createSetupNoiseFilter(['chatgpt-codex-connector[bot]']);
  const spec = createIssueCommentTaskSpec({
    taskStore,
    isNoiseComment: (c) => setupNoiseFilter({ ...c, commentType: 'conversation' }),
    issueCommentRouter: { route: async () => ({ kind: 'skipped', reason: 'lifecycle owns delivery' }) },
    fetchComments: async () => comments,
    fetchIssueState: async () => issueState,
    fetchIssueMetadata: async () => ({ state: issueState, authorLogin: 'author' }),
    invokeTrigger: {
      trigger: async (threadId, catId, userId, content, messageId, _extra, policy) => {
        triggered.push({ threadId, catId, userId, messageId, policy });
        return 'dispatched';
      },
    },
    waitLifecycle,
    log,
  });
  return { spec, messageStore, taskStore, triggered, task };
}

describe('#1392 AC-6 — a tracked issue comment starts the owner, not just writes a message', () => {
  it('invokes the owner after the lifecycle delivers the comment', async () => {
    const { spec, messageStore, triggered } = await trackedIssue();

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true, 'the new comment must be admitted');
    for (const item of gate.workItems) await spec.run.execute(item.signal, item.subjectKey, {});

    const delivered = messageStore.getByThread('thread_issue');
    assert.equal(delivered.length, 1, 'the lifecycle writes the message');
    assert.equal(triggered.length, 1, 'and the owner is actually started — this was skipped');
    assert.equal(triggered[0].messageId, delivered[0].id, 'the wake points at the message it delivered');
    assert.equal(triggered[0].catId, 'opus');
    assert.equal(triggered[0].threadId, 'thread_issue');
  });

  /*
   * The collector already delivers the final batch before closing (AC-D4). The lifecycle then ended
   * the wait on the close and never matched that batch, so the owner heard "closed" and lost the
   * last comment — and the task was done, so nothing would ever report it.
   */
  it('a comment that lands in the same poll the issue closes is delivered with the close', async () => {
    const { spec, messageStore, taskStore, task } = await trackedIssue('closed');

    const gate = await spec.admission.gate();
    for (const item of gate.workItems) await spec.run.execute(item.signal, item.subjectKey, {});

    const delivered = messageStore.getByThread('thread_issue');
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].content, /issue comment #101 added by someone/, 'the final comment is not dropped');
    assert.match(delivered[0].content, /closed/);
    assert.equal((await taskStore.get(task.id)).status, 'done', 'and tracking still ends');
  });
});

/**
 * #1392 R3: the community projection filter decided whether the typed wait could see a comment.
 *
 * The collector classified this comment as `exact_setup_noise` — a judgement that belongs to the
 * community email policy — and then dropped it before the wait matcher existed in the call, while
 * still advancing the cursor past it. The accepted issue default is "every comment that is not your
 * own", so the owner was promised this comment and could never receive it: the next poll starts
 * above it. The two policies are separate questions and this drives the real gate to prove it.
 */
const SETUP_NOISE = {
  id: 101,
  author: 'chatgpt-codex-connector[bot]',
  body: 'To use Codex here, create an environment for this repo.',
  createdAt: '2026-09-15T00:00:00Z',
  actorType: 'Bot',
};

describe('#1392 R3 — the community delivery policy does not decide what the wait observes', () => {
  it('admits a comment the community policy would silence, and wakes the owner for it', async () => {
    const { spec, messageStore, triggered } = await trackedIssue('open', [SETUP_NOISE]);

    const gate = await spec.admission.gate();

    assert.equal(gate.run, true, 'the gate dropped it before the matcher could judge the audience');
    for (const item of gate.workItems) await spec.run.execute(item.signal, item.subjectKey, {});

    assert.equal(
      messageStore.getByThread('thread_issue').length,
      1,
      'the accepted issue default is every non-self comment',
    );
    assert.equal(triggered.length, 1, 'and the owner is started, not just written to');
  });

  it('never advances the wait frontier past a comment the matcher never saw', async () => {
    const { spec, taskStore, task } = await trackedIssue('open', [SETUP_NOISE]);

    const gate = await spec.admission.gate();
    for (const item of gate.workItems ?? []) await spec.run.execute(item.signal, item.subjectKey, {});

    const after = await taskStore.get(task.id);
    const frontier = after.automationState?.await?.baseline?.issue?.lastCommentCursor ?? 100;
    assert.ok(frontier >= SETUP_NOISE.id, `the wait frontier must cover the observed comment, got ${frontier}`);
  });
});
