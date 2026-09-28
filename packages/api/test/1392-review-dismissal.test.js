import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * #1392: a dismissed verdict is a review decision change.
 *
 * GitHub dismisses a review in place. On zts212653/clowder-ai#1521, review 5306457507 was submitted
 * as CHANGES_REQUESTED at 15:21:35Z and dismissed at 15:39:04Z; the reviews endpoint still lists it
 * under the same id, submitted_at and commit, with state DISMISSED. The collector only fetched reviews
 * above its id cursor and the matcher only compared ids, so a revoked approval never reached the cat
 * that was waiting on the PR's review decision.
 *
 * Real registration, collector, router and lifecycle; only GitHub and the stores are fakes.
 */
const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { readGitHubWaitBaseline } = await import('../dist/domains/github-signals/GitHubWaitBaselineReader.js');
const { renewPrWaitBaseline } = await import('../dist/domains/github-signals/GitHubWaitRenewalBaseline.js');
const { ReviewFeedbackRouter } = await import('../dist/infrastructure/email/ReviewFeedbackRouter.js');
const { createReviewFeedbackTaskSpec } = await import('../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
const { expandGitHubPrTrackingGoal } = await import('../../shared/dist/types/github-wait.js');

const HEAD = 'aaaa1111aaaa1111';
const SUBJECT = 'pr:owner/repo#7';
const THREAD = 'thread_1';
const log = { info() {}, warn() {}, error() {} };

function review(id, state, author = 'maintainer') {
  return { id, state, author, body: '', submittedAt: '2026-09-24T15:21:35Z', commitId: HEAD };
}

function authorDefaultWhen() {
  const expansion = expandGitHubPrTrackingGoal({ role: 'subject_author', selfLogin: 'mindfn' });
  assert.equal(expansion.ok, true, expansion.error);
  return expansion.when;
}

/** GitHub as the production fetchers see it. `fetchPaginated` walks every page and keeps `id > sinceId`. */
function fakeGitHub(reviews) {
  return {
    reviews,
    fetchReviews: async (_repo, _pr, sinceId) => reviews.filter((r) => r.id > (sinceId ?? 0)).map((r) => ({ ...r })),
    rawReviews: async () =>
      reviews.map((r) => ({ id: r.id, state: r.state, user: { login: r.author }, commit_id: r.commitId })),
  };
}

/** Registered the way `register_pr_tracking` registers it, then watched by the production review chain. */
async function trackedPr(github, { when = authorDefaultWhen(), baseline: adjustBaseline = (b) => b } = {}) {
  const snapshot = await readGitHubWaitBaseline(
    { repoFullName: 'owner/repo', prNumber: 7, when },
    {
      fetchCi: async () => ({ headSha: HEAD, aggregateBucket: 'pass' }),
      fetchInlineComments: async () => [],
      fetchConversationComments: async () => [],
      fetchReviews: github.rawReviews,
      fetchMergeState: async () => 'MERGEABLE',
      fetchReviewThreads: async () => [],
      now: () => 100,
    },
  );
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: SUBJECT,
    threadId: THREAD,
    title: 'PR tracking: owner/repo#7',
    ownerCatId: 'opus',
    why: 'test',
    createdBy: 'opus',
    userId: 'user_1',
    automationState: {
      ...snapshot.collectorState,
      await: {
        v: 1,
        generation: 1,
        subjectRef: SUBJECT,
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: adjustBaseline(snapshot.baseline),
        // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
        continuation: { when, then: 'Re-check the review state.' },
        createdAt: 100,
      },
    },
  });
  const lifecycle = new GitHubWaitLifecycleService({ taskStore, deliveryDeps: { messageStore }, log });
  const spec = createReviewFeedbackTaskSpec({
    taskStore,
    fetchPrMetadata: async () => ({ headSha: HEAD, prState: 'open' }),
    fetchComments: async () => [],
    fetchReviews: github.fetchReviews,
    reviewFeedbackRouter: new ReviewFeedbackRouter({ deliveryDeps: { messageStore }, waitLifecycle: lifecycle, log }),
    log,
  });
  const reviewPoll = async () => {
    const gate = await spec.admission.gate();
    for (const item of gate.run ? gate.workItems : []) {
      await spec.run.execute(item.signal, item.subjectKey, {});
    }
  };
  const observeCi = (bucket) =>
    lifecycle.observe({
      taskId: task.id,
      facts: { headSha: HEAD, ci: { bucket, fingerprint: `${HEAD}:${bucket}`, blockerCount: 0 } },
      collectorPatch: { ci: { headSha: HEAD, lastFingerprint: `${HEAD}:${bucket}`, lastBucket: bucket } },
    });
  const contents = () => messageStore.getByThread(THREAD).map((message) => message.content);
  return { reviewPoll, observeCi, contents, taskStore, task };
}

describe('#1392 — a verdict dismissed in place reaches the cat waiting on the review decision', () => {
  it('an approval dismissed after registration is delivered once, naming the reviewer and the review', async () => {
    const github = fakeGitHub([review(101, 'APPROVED')]);
    const { reviewPoll, contents } = await trackedPr(github);

    await reviewPoll();
    assert.deepEqual(contents(), [], 'the approval was already known at registration');

    github.reviews[0].state = 'DISMISSED';
    await reviewPoll();

    assert.equal(contents().length, 1, `the dismissal must be delivered, got ${JSON.stringify(contents())}`);
    assert.match(contents()[0], /review APPROVED → DISMISSED \(maintainer\)/);
    assert.match(contents()[0], /github:pr-review:101/, 'the woken cat can open the dismissed review');

    await reviewPoll();
    assert.equal(contents().length, 1, 'one delivery for one dismissal');
  });

  it('a changes request dismissed in place is delivered too', async () => {
    const github = fakeGitHub([review(101, 'CHANGES_REQUESTED')]);
    const { reviewPoll, contents } = await trackedPr(github);

    github.reviews[0].state = 'DISMISSED';
    await reviewPoll();

    assert.equal(contents().length, 1, `got ${JSON.stringify(contents())}`);
    assert.match(contents()[0], /review CHANGES_REQUESTED → DISMISSED \(maintainer\)/);
  });

  it('a dismissal that happened before registration is not reported', async () => {
    const github = fakeGitHub([review(100, 'DISMISSED', 'someone'), review(101, 'APPROVED')]);
    const { reviewPoll, contents } = await trackedPr(github);

    await reviewPoll();
    await reviewPoll();

    assert.deepEqual(contents(), []);
  });

  /*
   * A wait registered before verdicts were recorded cannot tell an old dismissal from a new one. It
   * adopts what its first review observation sees as already known, so nothing earlier is replayed
   * and every later dismissal is reported.
   */
  it('a wait registered before this change adopts current verdicts, then reports later dismissals', async () => {
    const github = fakeGitHub([review(100, 'DISMISSED', 'someone'), review(101, 'APPROVED')]);
    const withoutVerdicts = (baseline) => {
      const { verdicts, ...review } = baseline.review;
      return { ...baseline, review };
    };
    const { reviewPoll, contents } = await trackedPr(github, { baseline: withoutVerdicts });

    await reviewPoll();
    assert.deepEqual(contents(), [], 'the old dismissal of 100 is not replayed');

    github.reviews[1].state = 'DISMISSED';
    await reviewPoll();

    assert.equal(contents().length, 1, `got ${JSON.stringify(contents())}`);
    assert.match(contents()[0], /review APPROVED → DISMISSED \(maintainer\)/);
  });

  it('a wait that renewed on another event still knows the approval it had seen', async () => {
    const github = fakeGitHub([review(101, 'APPROVED')]);
    const when = [{ kind: 'pr_review_decision_changed' }, { kind: 'pr_ci_terminal' }];
    const { reviewPoll, observeCi, contents } = await trackedPr(github, { when });

    const ci = await observeCi('fail');
    assert.equal(ci.kind, 'notified', 'CI renews the wait');

    github.reviews[0].state = 'DISMISSED';
    await reviewPoll();

    assert.equal(contents().length, 2, `got ${JSON.stringify(contents())}`);
    assert.match(contents()[1], /review APPROVED → DISMISSED/);
  });
});

describe('#1392 — renewal never revives a dismissed verdict', () => {
  const previous = {
    capturedAt: 100,
    headSha: HEAD,
    review: {
      inlineCommentCursor: 0,
      conversationCommentCursor: 0,
      decisionCursor: 101,
      verdicts: { 101: { state: 'DISMISSED', author: 'maintainer' } },
    },
  };

  it('a late observation that still shows the verdict live keeps it dismissed, and adds what is new', () => {
    const renewed = renewPrWaitBaseline(
      previous,
      {},
      {
        headSha: HEAD,
        review: {
          decisionCursor: 102,
          verdicts: {
            101: { state: 'APPROVED', author: 'maintainer' },
            102: { state: 'APPROVED', author: 'other' },
          },
        },
      },
      200,
    );

    assert.deepEqual(renewed.review.verdicts, {
      101: { state: 'DISMISSED', author: 'maintainer' },
      102: { state: 'APPROVED', author: 'other' },
    });
  });

  it('an observation without review facts keeps what the wait had seen', () => {
    const renewed = renewPrWaitBaseline(previous, {}, { headSha: HEAD }, 200);

    assert.deepEqual(renewed.review.verdicts, previous.review.verdicts);
  });
});
