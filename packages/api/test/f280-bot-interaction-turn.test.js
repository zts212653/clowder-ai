/**
 * F280 section 4b — bot interaction turns (A23–A29).
 *
 * Chain-level per F280 section 5.4: real GitHub REST payload shapes enter through the
 * production adapter, travel the real TaskSpec / Router / Lifecycle, and the assertion is
 * that a message did (or did not) appear in the MessageStore. The retired
 * pr_review_result_available channel could be green at the predicate level while the owner
 * heard nothing, which is exactly why the check has to end at delivery.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { normalizePrFeedbackComments, normalizePrReviewDecisions } = await import(
  '../dist/infrastructure/github/github-feedback-payload.js'
);
const { ReviewFeedbackRouter } = await import('../dist/infrastructure/email/ReviewFeedbackRouter.js');
const { createReviewFeedbackTaskSpec } = await import('../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
const { buildPrTrackingPredicates } = await import('../dist/domains/github-signals/PrTrackingDefaultSet.js');
const { deriveCloudReviewObservation } = await import('../dist/domains/github-signals/CloudReviewObservation.js');
const { ExternalReviewCoordinator } = await import(
  '../dist/domains/community/external-review/ExternalReviewCoordinator.js'
);
const { CommunityProjector } = await import('../dist/domains/community/community-projector.js');
const { advanceGitHubTrackingBaseline, normalizePrCommentEvent, normalizePrFeedbackBatch } = await import(
  '../dist/domains/github-signals/GitHubTrackingEvent.js'
);
const { readGitHubWaitBaseline } = await import('../dist/domains/github-signals/GitHubWaitBaselineReader.js');
const { resolveEventBackedRoutingExit } = await import(
  '../dist/domains/cats/services/agents/routing/guards/event-backed-routing-exit.js'
);
const { BOT_TURN_TIMEOUT_MS } = await import('../dist/domains/github-signals/GitHubBotTurn.js');

const logger = { info() {}, warn() {}, error() {} };
const SELF = 'Cat-Self';
const BOT = 'chatgpt-codex-connector[bot]';
// The REAL trigger form used on our PRs (cat-cafe-skills/refs/pr-template.md): you summon
// `@codex`, and `chatgpt-codex-connector[bot]` answers. Writing the answering login here — as an
// earlier version of this file did — makes every round-opening test agree with the code and
// disagree with production.
const TRIGGER_BODY = '@codex review';
// Real GitHub commit ids, because the connector's clean verdict quotes one and the HEAD
// comparison is what makes a verdict belong to a diff.
const HEAD = '6908af814bbbfa52803f43db7c6968fa7c25cc00';
const OLD_HEAD = '1f0b9c2d3e4a5b6c7d8e9f00112233445566778a';
const TRIGGER_AT = '2026-09-02T09:30:00Z';
const TRIGGER_MS = Date.parse(TRIGGER_AT);

const AUTHOR_SUBSCRIPTION = buildPrTrackingPredicates({ registrantIsPrAuthor: true });
const MAINTAINER_SUBSCRIPTION = buildPrTrackingPredicates({ registrantIsPrAuthor: false });

function triggerComment(overrides = {}) {
  return {
    id: 21,
    body: TRIGGER_BODY,
    created_at: TRIGGER_AT,
    user: { login: SELF, type: 'User' },
    ...overrides,
  };
}

// The connector's real clean verdict names the commit it reviewed; that line is what makes the
// verdict about THIS diff rather than about whatever the PR used to be.
function botConversationAnswer(overrides = {}) {
  return {
    id: 22,
    body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${HEAD}\`\n`,
    created_at: '2026-09-02T09:40:00Z',
    user: { login: BOT, type: 'Bot' },
    ...overrides,
  };
}

async function createHarness({ when, now = () => TRIGGER_MS + 1_000, externalReviewCoordinator } = {}) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#1394',
    threadId: 'thread-registration',
    title: 'Track PR #1394',
    ownerCatId: 'cat-self',
    why: 'Notify the registration thread about external GitHub responses.',
    createdBy: 'cat-self',
    userId: 'user-1',
    automationState: {
      review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 20, lastDecisionCursor: 30 },
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'pr:owner/repo#1394',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: {
          capturedAt: 100,
          headSha: HEAD,
          review: { inlineCommentCursor: 10, conversationCommentCursor: 20, decisionCursor: 30 },
        },
        continuation: {
          when,
          // biome-ignore lint/suspicious/noThenProperty: frozen internal continuation field.
          then: 'Handle the external response.',
        },
        autoRenew: true,
        createdAt: TRIGGER_MS - 1_000,
      },
    },
  });
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    now,
    log: logger,
  });
  const router = new ReviewFeedbackRouter({
    deliveryDeps: { messageStore },
    waitLifecycle: lifecycle,
    log: logger,
  });
  const upstream = { inline: [], conversation: [], reviews: [] };
  const spec = createReviewFeedbackTaskSpec({
    id: 'github-review-feedback-bot-turn',
    taskStore,
    reviewFeedbackRouter: router,
    fetchPrMetadata: async () => ({ headSha: HEAD, prState: 'open', authorLogin: SELF }),
    fetchComments: async () => normalizePrFeedbackComments(upstream.inline, upstream.conversation),
    fetchReviews: async () => normalizePrReviewDecisions(upstream.reviews),
    isEchoComment: (comment) => comment.author.toLowerCase() === SELF.toLowerCase(),
    isEchoReview: (review) => review.author.toLowerCase() === SELF.toLowerCase(),
    ...(externalReviewCoordinator ? { externalReviewCoordinator } : {}),
    now,
    log: logger,
  });
  const poll = async (next = {}) => {
    Object.assign(upstream, { inline: [], conversation: [], reviews: [] }, next);
    const gate = await spec.admission.gate();
    if (gate.run !== true) return;
    for (const item of gate.workItems) {
      await spec.run.execute(item.signal, item.subjectKey, {
        assignedCatId: null,
        signal: new AbortController().signal,
      });
    }
  };
  const delivered = () => messageStore.getByThread('thread-registration').map((message) => message.content);
  return { taskStore, task, poll, delivered };
}

describe('F280 4b — bot interaction turns', () => {
  test('role picks the default without the caller naming it (2.4b)', () => {
    assert.ok(AUTHOR_SUBSCRIPTION.some((p) => p.kind === 'pr_bot_interaction'));
    assert.ok(!MAINTAINER_SUBSCRIPTION.some((p) => p.kind === 'pr_bot_interaction'));
    // A27: a maintainer who WANTS the round asks for it by name, in the one vocabulary.
    const optedIn = buildPrTrackingPredicates({ registrantIsPrAuthor: false, include: ['bot_interaction'] });
    assert.ok(optedIn.some((p) => p.kind === 'pr_bot_interaction'));
    // Unresolvable role arms it: A26 says a muted real signal is the worse failure.
    assert.ok(buildPrTrackingPredicates().some((p) => p.kind === 'pr_bot_interaction'));
  });

  test('A23: the author is woken by the bot review and its inline findings', async () => {
    const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION });
    await harness.poll({
      inline: [
        {
          id: 11,
          body: 'This retry loses the notification.',
          created_at: '2026-09-02T09:41:00Z',
          user: { login: BOT, type: 'Bot' },
          path: 'src/a.ts',
          line: 12,
          pull_request_review_id: 31,
        },
      ],
      reviews: [
        {
          id: 31,
          state: 'CHANGES_REQUESTED',
          body: 'One blocking finding.',
          submitted_at: '2026-09-02T09:41:00Z',
          user: { login: BOT, type: 'Bot' },
        },
      ],
    });
    const content = harness.delivered();
    assert.equal(content.length, 1);
    assert.match(content[0], /This retry loses the notification\./);
    assert.match(content[0], /One blocking finding\./);
  });

  test('A24/A25: a maintainer hears neither the bot nor the author trigger that summoned it', async () => {
    const harness = await createHarness({ when: MAINTAINER_SUBSCRIPTION });
    await harness.poll({
      conversation: [triggerComment({ user: { login: 'PrAuthor', type: 'User' } }), botConversationAnswer()],
    });
    assert.deepEqual(harness.delivered(), []);
  });

  test('A26: the maintainer still hears the PR author reply that is not part of a bot round', async () => {
    const harness = await createHarness({ when: MAINTAINER_SUBSCRIPTION });
    await harness.poll({
      conversation: [
        {
          id: 23,
          body: 'Fixed the third point you raised.',
          created_at: '2026-09-02T09:45:00Z',
          user: { login: 'PrAuthor', type: 'User' },
        },
      ],
    });
    const content = harness.delivered();
    assert.equal(content.length, 1);
    assert.match(content[0], /Fixed the third point you raised\./);
  });

  test('A27: a maintainer who includes bot_interaction gets the round back', async () => {
    const harness = await createHarness({
      when: buildPrTrackingPredicates({ registrantIsPrAuthor: false, include: ['bot_interaction'] }),
    });
    await harness.poll({ conversation: [botConversationAnswer()] });
    assert.match(harness.delivered()[0] ?? '', /Didn't find any major issues/);
  });

  test('A29: the author triggers silently, and the bot answer closes the round exactly once', async () => {
    const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION });
    // The trigger is self-authored: it opens the turn but must never wake its own writer.
    await harness.poll({ conversation: [triggerComment()] });
    assert.deepEqual(harness.delivered(), []);
    const openTurns = (await harness.taskStore.get(harness.task.id)).automationState.await.baseline.botTurns;
    assert.deepEqual(openTurns, { [BOT]: { triggerId: 21, openedAt: TRIGGER_MS, headSha: HEAD } });

    await harness.poll({ conversation: [triggerComment(), botConversationAnswer()] });
    const content = harness.delivered();
    assert.equal(content.length, 1);
    assert.match(content[0], /Didn't find any major issues/);
    assert.equal((await harness.taskStore.get(harness.task.id)).automationState.await.baseline.botTurns, undefined);
  });

  // Regression (sol R19 P1): GitHub timestamps are second-granularity and the router emits every
  // comment before every review, so "old round answered at T, author opens a new round at T"
  // arrives as [open, close] in array order with identical timestamps. Sorting by time alone
  // applied open-then-close and DELETED the new round — the poller then never reports it and
  // never times it out. The fold now applies a close before an open at the same instant.
  test('A29 guard: an answer and a new trigger in the same second keep the NEW round', async () => {
    const sameSecond = '2026-09-02T09:40:00Z';
    let now = TRIGGER_MS + 1_000;
    const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, now: () => now });
    await harness.poll({ conversation: [triggerComment()] });

    now = Date.parse(sameSecond) + 1_000;
    await harness.poll({
      conversation: [
        triggerComment(),
        // The author asks for a second round in the very second the first one is answered.
        triggerComment({ id: 30, created_at: sameSecond }),
      ],
      reviews: [
        {
          id: 31,
          state: 'COMMENTED',
          body: 'Round one verdict.',
          submitted_at: sameSecond,
          user: { login: BOT, type: 'Bot' },
        },
      ],
    });

    const turns = (await harness.taskStore.get(harness.task.id)).automationState.await.baseline.botTurns;
    assert.deepEqual(
      turns,
      { [BOT]: { triggerId: 30, openedAt: Date.parse(sameSecond), headSha: HEAD } },
      'the newly opened round must survive the older round being answered in the same second',
    );
  });

  // A28 guard: the CI and conflict pollers observe the SAME wait with facts and no events.
  // They never evaluate turns, so they must not retire one either — otherwise an unanswered
  // round is deleted between two review polls and the "never came back" notice never fires.
  test('A28: an eventless CI/conflict observation cannot retire an open round', async () => {
    let now = TRIGGER_MS + 1_000;
    const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, now: () => now });
    await harness.poll({ conversation: [triggerComment()] });

    now = TRIGGER_MS + BOT_TURN_TIMEOUT_MS * 2;
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore: harness.taskStore,
      deliveryDeps: { messageStore: { create: async () => ({ id: 'unused' }) } },
      now: () => now,
      log: logger,
    });
    const ciObservation = await lifecycle.observe({
      taskId: harness.task.id,
      facts: { headSha: HEAD, ci: { bucket: 'pending', fingerprint: 'head-1:pending', blockerCount: 0 } },
    });
    assert.equal(ciObservation.kind, 'state_only');
    const stillOpen = (await harness.taskStore.get(harness.task.id)).automationState.await.baseline.botTurns;
    assert.deepEqual(stillOpen, { [BOT]: { triggerId: 21, openedAt: TRIGGER_MS, headSha: HEAD } });

    // The review poller — the one that actually evaluates turns — still reports it.
    await harness.poll();
    assert.match(harness.delivered()[0] ?? '', /never answered the request in comment #21/);
  });

  test('A28: a round that opens and never closes reports itself, once', async () => {
    let now = TRIGGER_MS + 1_000;
    const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, now: () => now });
    await harness.poll({ conversation: [triggerComment()] });
    assert.deepEqual(harness.delivered(), [], 'the trigger is self-authored and must stay silent');

    // Still inside the window: nothing to say yet.
    now = TRIGGER_MS + BOT_TURN_TIMEOUT_MS - 1;
    await harness.poll();
    assert.deepEqual(harness.delivered(), []);

    now = TRIGGER_MS + BOT_TURN_TIMEOUT_MS;
    await harness.poll();
    const content = harness.delivered();
    assert.equal(content.length, 1);
    assert.match(content[0], /never answered the request in comment #21/);

    // Reported means retired: an unanswered round must not re-report on every later poll.
    now = TRIGGER_MS + BOT_TURN_TIMEOUT_MS * 4;
    await harness.poll();
    assert.equal(harness.delivered().length, 1);
  });

  /*
   * F177 same-turn clean stop. A cat posts `@codex review` and ends its turn immediately; the
   * routing guard may only release the ball if a real event is guaranteed to come back. That
   * proof used to be a typed predicate the caller registered by hand. It is now an OPEN round,
   * which means registration has to discover the summon itself — waiting for the first poll
   * (60s later) would reject every correct event wait made in the turn that created it.
   */
  describe('registration opens the round the caller just summoned', () => {
    const upstreamComments = [
      { id: 21, body: TRIGGER_BODY, created_at: TRIGGER_AT, user: { login: SELF, type: 'User' } },
    ];
    const readerDeps = (verify) => ({
      fetchCi: async () => ({ headSha: HEAD, aggregateBucket: 'pending' }),
      fetchInlineComments: async () => [],
      fetchConversationComments: async () => upstreamComments,
      fetchReviews: async () => [],
      fetchMergeState: async () => ({ mergeState: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
      ...(verify ? { verifyBotTriggerCoverage: verify } : {}),
      now: () => TRIGGER_MS + 1_000,
    });

    const identity = {
      invocationId: 'inv-owner',
      isSelfLogin: (login) => login.toLowerCase() === SELF.toLowerCase(),
    };

    test('seeds the round when the bot accepted the job, bound to this invocation and HEAD', async () => {
      const seen = [];
      const snapshot = await readGitHubWaitBaseline(
        { repoFullName: 'owner/repo', prNumber: 1394, ...identity },
        readerDeps(async (input) => {
          seen.push(input.triggerCommentId);
          return { covered: true };
        }),
      );
      assert.deepEqual(seen, [21], 'the verifier must be asked about the exact summoning comment');
      assert.equal(snapshot.botTurnProbe, 'verified');
      assert.deepEqual(snapshot.baseline.botTurns, {
        [BOT]: { triggerId: 21, openedAt: TRIGGER_MS, headSha: HEAD, grantInvocationId: 'inv-owner' },
      });
    });

    test("someone else's summon is not our proof", async () => {
      const otherSummon = [
        { id: 22, body: TRIGGER_BODY, created_at: TRIGGER_AT, user: { login: 'Maintainer', type: 'User' } },
      ];
      const snapshot = await readGitHubWaitBaseline(
        { repoFullName: 'owner/repo', prNumber: 1394, ...identity },
        {
          ...readerDeps(async () => ({ covered: true })),
          fetchConversationComments: async () => otherSummon,
        },
      );
      assert.equal(snapshot.baseline.botTurns, undefined);
    });

    test('seeds nothing when the bot never accepted, so no timeout is invented', async () => {
      const snapshot = await readGitHubWaitBaseline(
        { repoFullName: 'owner/repo', prNumber: 1394, ...identity },
        readerDeps(async () => ({ covered: false })),
      );
      assert.equal(snapshot.baseline.botTurns, undefined);
      // "The bot never accepted" is an ANSWER, not an absence of one.
      assert.equal(snapshot.botTurnProbe, 'verified');
    });

    test('a verifier that cannot answer says so, instead of looking like "no round"', async () => {
      const snapshot = await readGitHubWaitBaseline(
        { repoFullName: 'owner/repo', prNumber: 1394, ...identity },
        readerDeps(async () => {
          throw new Error('GitHub unreachable');
        }),
      );
      assert.equal(snapshot.baseline.botTurns, undefined);
      assert.equal(snapshot.botTurnProbe, 'unavailable');
    });

    test('the seeded round releases only the invocation it was granted to', async () => {
      const snapshot = await readGitHubWaitBaseline(
        { repoFullName: 'owner/repo', prNumber: 1394, ...identity },
        readerDeps(async () => ({ covered: true })),
      );
      const task = {
        id: 'task-1394',
        kind: 'pr_tracking',
        status: 'doing',
        subjectKey: 'pr:owner/repo#1394',
        threadId: 'thread-registration',
        ownerCatId: 'cat-self',
        automationState: {
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#1394',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: snapshot.baseline,
            continuation: {
              when: AUTHOR_SUBSCRIPTION,
              // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
              then: 'Handle the bot answer.',
            },
            createdAt: TRIGGER_MS,
          },
        },
      };
      const exitFor = (invocationId) =>
        resolveEventBackedRoutingExit({
          taskStore: { listByThread: async () => [task] },
          threadId: 'thread-registration',
          catId: 'cat-self',
          invocationId,
        });

      const owner = await exitFor('inv-owner');
      assert.equal(owner.kind, 'bypass', 'a covered summon must release the ball in the same turn');
      assert.equal(owner.proof.predicate.triggerCommentId, 21);

      // F177 zero-false-release boundary (shared-rules 2b): "a tracker exists in this thread"
      // is not an exit. A different invocation never summoned anything and gets nothing.
      const foreign = await exitFor('inv-foreign');
      assert.equal(foreign.kind, 'reject', 'a foreign invocation must not inherit this proof');
    });

    /*
     * The exit answers OWNERSHIP ("will an event come back to me, in this turn"), and the grant
     * is the whole proof. It deliberately does NOT compare the round against `baseline.headSha`:
     * section 2.5b holds that frontier back on purpose, so comparing to it rejects a clean stop
     * that was just earned. "Is this verdict about the current diff" is answered where the live
     * HEAD is actually known — see the F168 cases below.
     *
     * A round opened by ordinary polling carries no grant, so it releases nobody.
     */
    test('a round nobody was granted never releases the ball', async () => {
      const snapshot = await readGitHubWaitBaseline(
        { repoFullName: 'owner/repo', prNumber: 1394, ...identity },
        readerDeps(async () => ({ covered: true })),
      );
      const ungranted = {
        ...snapshot.baseline,
        botTurns: { [BOT]: { triggerId: 21, openedAt: TRIGGER_MS, headSha: HEAD } },
      };
      const task = {
        id: 'task-1394',
        kind: 'pr_tracking',
        status: 'doing',
        subjectKey: 'pr:owner/repo#1394',
        threadId: 'thread-registration',
        ownerCatId: 'cat-self',
        automationState: {
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#1394',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: ungranted,
            continuation: {
              when: AUTHOR_SUBSCRIPTION,
              // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
              then: 'Handle the bot answer.',
            },
            createdAt: TRIGGER_MS,
          },
        },
      };
      const resolution = await resolveEventBackedRoutingExit({
        taskStore: { listByThread: async () => [task] },
        threadId: 'thread-registration',
        catId: 'cat-self',
        invocationId: 'inv-owner',
      });
      assert.equal(resolution.kind, 'reject', 'a round this invocation never opened is not its exit');
    });
  });

  /*
   * F168 readiness. The cloud-review aggregate used to be fed by a classifier that only ran when
   * the caller registered `pr_review_result_available` by hand; deleting that predicate left
   * `recordCloud` with zero production callers, so a repo on `cloudReviewPolicy=required` would
   * wait on a verdict that could never arrive. The status is now derived from bot identity and
   * round state — no public predicate, but also no hole.
   */
  describe('F168 cloud-review readiness is fed from the normalized round', () => {
    const collectObservations = () => {
      const seen = [];
      return {
        seen,
        coordinator: {
          recordCloud: async (observation) => {
            seen.push(observation);
            return { kind: 'state_only' };
          },
        },
      };
    };

    test('a blocking bot review is reported to the aggregate', async () => {
      const { seen, coordinator } = collectObservations();
      const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, externalReviewCoordinator: coordinator });
      await harness.poll({
        reviews: [
          {
            id: 31,
            state: 'CHANGES_REQUESTED',
            body: 'One blocking finding.',
            submitted_at: '2026-09-02T09:41:00Z',
            commit_id: HEAD,
            user: { login: BOT, type: 'Bot' },
          },
        ],
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].status, 'blocking');
      assert.equal(seen[0].reviewId, 31);
      assert.equal(seen[0].headSha, HEAD);
    });

    test('a clean bot answer is reported as clean', async () => {
      const { seen, coordinator } = collectObservations();
      const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, externalReviewCoordinator: coordinator });
      await harness.poll({ conversation: [botConversationAnswer()] });
      assert.equal(seen.at(-1)?.status, 'clean');
    });

    test('a review of an older commit is not a verdict on the current HEAD', async () => {
      const { seen, coordinator } = collectObservations();
      const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, externalReviewCoordinator: coordinator });
      await harness.poll({
        reviews: [
          {
            id: 31,
            state: 'APPROVED',
            body: 'Looks good.',
            submitted_at: '2026-09-02T09:41:00Z',
            commit_id: OLD_HEAD,
            user: { login: BOT, type: 'Bot' },
          },
        ],
      });
      assert.deepEqual(seen, [], 'the bot never saw this diff');
    });

    /*
     * sol R24: the ordinary FAST path. A bot can answer well inside one 60s poll, so summon and
     * failure arrive in the SAME batch. Reading only the round state left over from previous
     * polls made that case structurally invisible: the round opened and closed between two
     * readings and left nothing behind, so the aggregate never heard about it at all.
     */
    /*
     * sol R25: an answer can only close a round that was open BEFORE it. Collecting "every round
     * this batch touched" and attributing any answer to that set invented failures for rounds
     * nobody had failed — and F168's own downgrade guard then pinned the false failure in place.
     */
    test("chatter that precedes the summon does not become that summon's failure", async () => {
      const { seen, coordinator } = collectObservations();
      const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, externalReviewCoordinator: coordinator });
      // GitHub ids grow with creation time, and both must sit ABOVE the frozen cursor (20) or
      // the collector never sees them — an earlier draft used id 20 for the chatter, which the
      // cursor silently dropped, leaving a test that could not fail.
      await harness.poll({
        conversation: [
          {
            id: 21,
            body: 'Setting up your environment...',
            created_at: '2026-09-02T09:29:00Z',
            user: { login: BOT, type: 'Bot' },
          },
          triggerComment({ id: 22 }),
        ],
      });
      assert.equal(seen.at(-1)?.status, 'running', 'the round opened a minute after that chatter');
      assert.equal(seen.at(-1)?.triggerCommentId, 22);
    });

    test('an older round answered in the same second as a new summon fails the OLDER round', async () => {
      const { seen, coordinator } = collectObservations();
      let now = TRIGGER_MS;
      const harness = await createHarness({
        when: AUTHOR_SUBSCRIPTION,
        now: () => now,
        externalReviewCoordinator: coordinator,
      });
      // Round #21 is opened first and left unanswered.
      await harness.poll({ conversation: [triggerComment()] });

      const sameSecond = '2026-09-02T09:40:00Z';
      now = Date.parse(sameSecond) + 1_000;
      await harness.poll({
        conversation: [
          triggerComment(),
          botConversationAnswer({ id: 22, body: 'could not review', created_at: sameSecond }),
          triggerComment({ id: 30, created_at: sameSecond }),
        ],
      });
      // The replay attributes that answer to round #21 (see replayBotTurns), but the aggregate
      // holds ONE current status and the batch ENDS with #30 in flight — reporting the older
      // failure here is what the coordinator's downgrade guard would then pin in place.
      assert.equal(seen.at(-1)?.status, 'running');
      assert.equal(seen.at(-1)?.triggerCommentId, 30, 'the batch ends on the newly opened round');
      const turns = (await harness.taskStore.get(harness.task.id)).automationState.await.baseline.botTurns;
      assert.equal(turns[BOT].triggerId, 30, 'and the newly opened round survives');
    });

    test('a summon answered inside one poll still reports the failure', async () => {
      const { seen, coordinator } = collectObservations();
      const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, externalReviewCoordinator: coordinator });
      await harness.poll({
        conversation: [triggerComment(), botConversationAnswer({ body: 'Codex could not review this pull request.' })],
      });
      assert.equal(seen.at(-1)?.status, 'failed_or_timeout');
      assert.equal(seen.at(-1)?.triggerCommentId, 21, 'attributed to the round it answered');
    });

    test('the bot reporting its OWN failure is reported as a failure, not as clean and not as silence', async () => {
      const { seen, coordinator } = collectObservations();
      const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, externalReviewCoordinator: coordinator });
      // A round has to exist before its failure can be attributed to it — the summon comes first.
      await harness.poll({ conversation: [triggerComment()] });
      await harness.poll({
        conversation: [triggerComment(), botConversationAnswer({ body: 'Codex could not review this pull request.' })],
      });
      // `clean` would mark the PR ready on a review that never happened; silence would leave the
      // aggregate on its previous value forever, because the same batch retires the round.
      assert.equal(seen.at(-1)?.status, 'failed_or_timeout');
      assert.notEqual(seen.at(-1)?.status, 'clean');
    });

    // sol R21: the unit derivation is not enough — the observation is computed BEFORE the round
    // is retired, so only a real poll proves the timeout actually reaches the aggregate.
    test('an unanswered round reports failed_or_timeout through the real poll', async () => {
      const { seen, coordinator } = collectObservations();
      let now = TRIGGER_MS + 1_000;
      const harness = await createHarness({
        when: AUTHOR_SUBSCRIPTION,
        now: () => now,
        externalReviewCoordinator: coordinator,
      });
      // The aggregate now consumes the SAME batch the router delivers from, so the poll that
      // opens a round already reports it — no lag to reason about.
      await harness.poll({ conversation: [triggerComment()] });
      assert.equal(seen.at(-1)?.status, 'running', 'the round is open and the bot still has time');

      now = TRIGGER_MS + BOT_TURN_TIMEOUT_MS;
      await harness.poll();
      assert.equal(
        seen.at(-1)?.status,
        'failed_or_timeout',
        'a silent bot must release cloudReviewPolicy=required, not strand it on running',
      );
    });

    test('a poll with no bot activity and no open round says nothing', async () => {
      const { seen, coordinator } = collectObservations();
      const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, externalReviewCoordinator: coordinator });
      await harness.poll({
        conversation: [
          {
            id: 23,
            body: 'Fixed the third point.',
            created_at: '2026-09-02T09:45:00Z',
            user: { login: 'PrAuthor', type: 'User' },
          },
        ],
      });
      assert.deepEqual(seen, [], 'silence is not an observation');
    });
  });

  /*
   * sol R21. The registration path recorded a round's HEAD; the ORDINARY POLLING path did not,
   * and both consumers read a missing HEAD as "the current one". So the cross-commit
   * misreporting F280 forbids survived untouched on the main path, hidden behind a field that
   * only one of the two writers ever set.
   */
  describe('every round is bound to the commit it was opened against', () => {
    test('a round opened by ordinary polling records the HEAD it was asked about', async () => {
      const now = TRIGGER_MS + 1_000;
      const harness = await createHarness({ when: AUTHOR_SUBSCRIPTION, now: () => now });
      await harness.poll({ conversation: [triggerComment()] });
      const turns = (await harness.taskStore.get(harness.task.id)).automationState.await.baseline.botTurns;
      assert.equal(turns[BOT].headSha, HEAD, 'a poll-opened round without a HEAD is an unbound round');
    });

    test('F168 does not report an older round as still running on a new HEAD', () => {
      const openTurns = { [BOT]: { triggerId: 21, openedAt: TRIGGER_MS, headSha: OLD_HEAD } };
      const observed = deriveCloudReviewObservation({ headSha: HEAD, comments: [], decisions: [], openTurns });
      assert.equal(observed, null, 'the round was about a different diff');
    });

    test('F168 fails closed on a round with no recorded HEAD', () => {
      const openTurns = { [BOT]: { triggerId: 21, openedAt: TRIGGER_MS } };
      const observed = deriveCloudReviewObservation({ headSha: HEAD, comments: [], decisions: [], openTurns });
      assert.equal(observed, null, '"I do not know which diff" must not read as "the current one"');
    });

    test('an unanswered round reaches failed_or_timeout instead of running forever', () => {
      const openTurns = { [BOT]: { triggerId: 21, openedAt: TRIGGER_MS, headSha: HEAD } };
      const running = deriveCloudReviewObservation({
        headSha: HEAD,
        comments: [],
        decisions: [],
        openTurns,
        now: TRIGGER_MS + BOT_TURN_TIMEOUT_MS - 1,
      });
      assert.equal(running?.status, 'running');
      const timedOut = deriveCloudReviewObservation({
        headSha: HEAD,
        comments: [],
        decisions: [],
        openTurns,
        now: TRIGGER_MS + BOT_TURN_TIMEOUT_MS,
      });
      assert.equal(timedOut?.status, 'failed_or_timeout', 'a bot that went silent must not leave the gate open');
    });
  });

  /*
   * sol R22. Three "changed within the same batch / unknown pretending to be known" gaps that no
   * amount of steady-state testing reaches.
   */
  // Attribution now comes from the normalized transitions, not from the comment list alone —
  // so a unit case that wants an answer ATTRIBUTED must hand over the batch that carries it.
  const batchOf = (comments, knownBots) =>
    normalizePrFeedbackBatch({
      headSha: HEAD,
      comments,
      decisions: [],
      isSelfComment: (comment) => comment.author.toLowerCase() === SELF.toLowerCase(),
      ...(knownBots ? { knownBots } : {}),
    });

  /*
   * sol R26: F168 holds ONE current status, so a batch must reduce to the round decided LAST.
   * A fixed "review beats clean beats unreadable" priority reported an older round's clean
   * verdict while the batch ended in a new failure — and the aggregate's own downgrade guard
   * (running may not overwrite a terminal) then PINS whatever wrong terminal it was given.
   * These run against the real coordinator so that guard is actually in the loop.
   */
  describe('the aggregate ends on the round decided last', () => {
    const realCoordinator = () => {
      const events = [];
      const projections = new Map();
      const eventLog = {
        async append(event) {
          if (events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
            return { appended: false, sequence: -1 };
          }
          events.push(structuredClone(event));
          return { appended: true, sequence: events.length - 1 };
        },
        async read(subjectKey) {
          return events.filter((event) => event.subjectKey === subjectKey);
        },
        async listSubjects() {
          return [...new Set(events.map((event) => event.subjectKey))];
        },
      };
      const objectStore = {
        async get(subjectKey) {
          return projections.get(subjectKey) ?? null;
        },
        async save(projection) {
          projections.set(projection.subjectKey, structuredClone(projection));
        },
        async listSubjectKeys() {
          return [...projections.keys()];
        },
        async delete(subjectKey) {
          projections.delete(subjectKey);
        },
      };
      const coordinator = new ExternalReviewCoordinator({
        repoConfigStore: {
          async getByRepo() {
            return {
              repo: 'owner/repo',
              guardThreadId: 'thread-guard',
              guardCatId: 'opus',
              reviewMode: 'maintainer_review',
              cloudReviewPolicy: 'required',
              createdAt: 1,
              updatedAt: 1,
            };
          },
        },
        eventLog,
        projector: new CommunityProjector(eventLog, objectStore),
        objectStore,
        log: { info() {}, warn() {}, error() {} },
      });
      const cloud = () => projections.get('pr:owner/repo#1394')?.externalReview?.cloud;
      return { coordinator, cloud };
    };

    test('an older failure does not pin the aggregate while a new round is running', async () => {
      const { coordinator, cloud } = realCoordinator();
      let now = TRIGGER_MS;
      const harness = await createHarness({
        when: AUTHOR_SUBSCRIPTION,
        now: () => now,
        externalReviewCoordinator: coordinator,
      });
      await harness.poll({ conversation: [triggerComment()] });

      now = Date.parse('2026-09-02T09:42:00Z');
      await harness.poll({
        conversation: [
          triggerComment(),
          botConversationAnswer({ id: 22, body: 'could not review', created_at: '2026-09-02T09:40:00Z' }),
          triggerComment({ id: 30, created_at: '2026-09-02T09:41:00Z' }),
        ],
      });
      assert.equal(cloud()?.status, 'running', 'the batch ended with a new round in flight');
      assert.equal(cloud()?.triggerCommentId, 30);
    });

    /*
     * sol R27, and the most ordinary path there is: Codex answers with inline findings AND a
     * formal CHANGES_REQUESTED, in the same second. They are artifacts of ONE review, but the
     * inline comment closed the round first and was then read as "an answer I cannot parse" —
     * so a routine blocking review was reported to F168 as a failure. The earlier A23 test
     * missed it because it never opened a round, so it went down the fallback path instead.
     */
    test('inline findings plus a formal review are one verdict, not a failure', async () => {
      const { coordinator, cloud } = realCoordinator();
      let now = TRIGGER_MS;
      const harness = await createHarness({
        when: AUTHOR_SUBSCRIPTION,
        now: () => now,
        externalReviewCoordinator: coordinator,
      });
      await harness.poll({ conversation: [triggerComment()] });

      const answeredAt = '2026-09-02T09:41:00Z';
      now = Date.parse(answeredAt) + 1_000;
      await harness.poll({
        conversation: [triggerComment()],
        inline: [
          {
            id: 11,
            body: 'This retry loses the notification.',
            created_at: answeredAt,
            user: { login: BOT, type: 'Bot' },
            path: 'src/a.ts',
            line: 12,
            pull_request_review_id: 31,
            commit_id: HEAD,
          },
        ],
        reviews: [
          {
            id: 31,
            state: 'CHANGES_REQUESTED',
            body: 'One blocking finding.',
            submitted_at: answeredAt,
            commit_id: HEAD,
            user: { login: BOT, type: 'Bot' },
          },
        ],
      });
      assert.equal(cloud()?.status, 'blocking', 'a review with findings is blocking, not a non-result');
      assert.equal(cloud()?.reviewId, 31);
    });

    /*
     * sol R28: a bot artifact about an OLDER commit must not end a round that is waiting on the
     * current one. The close transition carried only bot and time, so a stale review arriving
     * after a new push deleted the live round — and by the time the classifier checked the
     * commit, there was no round left to protect. The decision has to happen AT the close.
     */
    for (const stale of ['formal review', 'inline finding']) {
      test(`a stale ${stale} neither closes the live round nor changes the verdict`, async () => {
        const { coordinator, cloud } = realCoordinator();
        let now = TRIGGER_MS;
        const harness = await createHarness({
          when: AUTHOR_SUBSCRIPTION,
          now: () => now,
          externalReviewCoordinator: coordinator,
        });
        await harness.poll({ conversation: [triggerComment()] });
        assert.equal(cloud()?.status, 'running');

        const staleAt = '2026-09-02T09:31:00Z';
        now = Date.parse(staleAt) + 1_000;
        await harness.poll({
          conversation: [triggerComment()],
          ...(stale === 'inline finding'
            ? {
                inline: [
                  {
                    id: 11,
                    body: 'Finding on code that has since been replaced.',
                    created_at: staleAt,
                    user: { login: BOT, type: 'Bot' },
                    path: 'src/a.ts',
                    line: 12,
                    pull_request_review_id: 31,
                    commit_id: OLD_HEAD,
                  },
                ],
              }
            : {
                reviews: [
                  {
                    id: 31,
                    state: 'CHANGES_REQUESTED',
                    body: 'Review of a commit that is no longer HEAD.',
                    submitted_at: staleAt,
                    commit_id: OLD_HEAD,
                    user: { login: BOT, type: 'Bot' },
                  },
                ],
              }),
        });

        assert.equal(cloud()?.status, 'running', "a verdict on an older diff is not this diff's verdict");
        const turns = (await harness.taskStore.get(harness.task.id)).automationState.await.baseline.botTurns;
        assert.equal(turns?.[BOT]?.triggerId, 21, 'and the round is still waiting for a real answer');
      });
    }

    /*
     * sol R29: an inline finding sometimes arrives without its own commit, and a stale review's
     * findings then ended a live round and reported `blocking` on the current HEAD.
     *
     * The rule is NOT to resolve the missing commit from the review — that was tried, changed no
     * outcome, and was removed (see normalizePrFeedbackBatch). It is that a review artifact whose
     * commit cannot be established does not close a round at all: "unknown" is not "the current
     * one". When the matching formal review IS present and current, that review closes the round
     * on its own evidence.
     */
    for (const [label, reviews] of [
      ['a stale review', [{ id: 31, commit_id: OLD_HEAD }]],
      ['no review at all', []],
    ]) {
      test(`an inline finding with no commit of its own and ${label} leaves the round alone`, async () => {
        const { coordinator, cloud } = realCoordinator();
        let now = TRIGGER_MS;
        const harness = await createHarness({
          when: AUTHOR_SUBSCRIPTION,
          now: () => now,
          externalReviewCoordinator: coordinator,
        });
        await harness.poll({ conversation: [triggerComment()] });
        assert.equal(cloud()?.status, 'running');

        const at = '2026-09-02T09:31:00Z';
        now = Date.parse(at) + 1_000;
        await harness.poll({
          conversation: [triggerComment()],
          inline: [
            {
              id: 11,
              body: 'Finding with no commit of its own.',
              created_at: at,
              user: { login: BOT, type: 'Bot' },
              path: 'src/a.ts',
              line: 12,
              pull_request_review_id: 31,
            },
          ],
          reviews: reviews.map((review) => ({
            id: review.id,
            state: 'CHANGES_REQUESTED',
            body: 'Review of a commit that is no longer HEAD.',
            submitted_at: at,
            commit_id: review.commit_id,
            user: { login: BOT, type: 'Bot' },
          })),
        });

        assert.equal(cloud()?.status, 'running', 'an unestablished commit must not become a verdict');
        const turns = (await harness.taskStore.get(harness.task.id)).automationState.await.baseline.botTurns;
        assert.equal(turns?.[BOT]?.triggerId, 21, 'and the round is still waiting');
      });
    }

    test('an inline finding with no commit of its own still lands when its review is current', async () => {
      const { coordinator, cloud } = realCoordinator();
      let now = TRIGGER_MS;
      const harness = await createHarness({
        when: AUTHOR_SUBSCRIPTION,
        now: () => now,
        externalReviewCoordinator: coordinator,
      });
      await harness.poll({ conversation: [triggerComment()] });

      const at = '2026-09-02T09:41:00Z';
      now = Date.parse(at) + 1_000;
      await harness.poll({
        conversation: [triggerComment()],
        inline: [
          {
            id: 11,
            body: 'Finding with no commit of its own.',
            created_at: at,
            user: { login: BOT, type: 'Bot' },
            path: 'src/a.ts',
            line: 12,
            pull_request_review_id: 31,
          },
        ],
        reviews: [
          {
            id: 31,
            state: 'CHANGES_REQUESTED',
            body: 'One blocking finding.',
            submitted_at: at,
            commit_id: HEAD,
            user: { login: BOT, type: 'Bot' },
          },
        ],
      });
      // Refusing to resolve the commit would be over-correction: the review IS about this diff,
      // so the round must close and the verdict must land.
      assert.equal(cloud()?.status, 'blocking');
      assert.equal(cloud()?.reviewId, 31);
      const turns = (await harness.taskStore.get(harness.task.id)).automationState.await.baseline.botTurns;
      assert.equal(turns, undefined, 'and the round is answered, not left hanging');
    });

    test('an older clean verdict does not survive a newer round failing', async () => {
      const { coordinator, cloud } = realCoordinator();
      let now = TRIGGER_MS;
      const harness = await createHarness({
        when: AUTHOR_SUBSCRIPTION,
        now: () => now,
        externalReviewCoordinator: coordinator,
      });
      await harness.poll({ conversation: [triggerComment()] });

      now = Date.parse('2026-09-02T09:43:00Z');
      await harness.poll({
        conversation: [
          triggerComment(),
          botConversationAnswer({ id: 22, created_at: '2026-09-02T09:40:00Z' }),
          triggerComment({ id: 30, created_at: '2026-09-02T09:41:00Z' }),
          botConversationAnswer({ id: 31, body: 'could not review', created_at: '2026-09-02T09:42:00Z' }),
        ],
      });
      // Reporting `clean` here would mark the PR ready on a verdict the batch itself superseded.
      assert.equal(cloud()?.status, 'failed_or_timeout');
      assert.equal(cloud()?.triggerCommentId, 30);
    });
  });

  describe('same-batch changes and unresolvable identity', () => {
    test('a summon on a freshly pushed HEAD binds to that HEAD, not to the frontier it replaced', () => {
      const baseline = {
        capturedAt: 1,
        headSha: OLD_HEAD,
        review: { inlineCommentCursor: 0, conversationCommentCursor: 0, decisionCursor: 0 },
      };
      // One poll can carry both the push and the review request made against it.
      const advanced = advanceGitHubTrackingBaseline(
        baseline,
        [
          { type: 'pr_head_changed', source: 'pr_head', id: HEAD, summary: 'head' },
          normalizePrCommentEvent({
            id: 21,
            author: SELF,
            body: TRIGGER_BODY,
            createdAt: TRIGGER_AT,
            commentType: 'conversation',
            self: true,
          }),
        ],
        { now: TRIGGER_MS + 1_000 },
      );
      assert.equal(advanced.headSha, HEAD);
      assert.equal(
        advanced.botTurns[BOT].headSha,
        HEAD,
        'binding to the replaced frontier makes F168 discard a round that was just opened',
      );
      assert.equal(
        deriveCloudReviewObservation({
          headSha: HEAD,
          comments: [],
          decisions: [],
          openTurns: advanced.botTurns,
          now: TRIGGER_MS + 1_000,
        })?.status,
        'running',
      );
    });

    test('an unresolvable own identity reports unavailable, never "verified: nothing of mine"', async () => {
      let verifierCalls = 0;
      const snapshot = await readGitHubWaitBaseline(
        {
          repoFullName: 'owner/repo',
          prNumber: 1394,
          invocationId: 'inv-owner',
          isSelfLogin: () => undefined,
        },
        {
          fetchCi: async () => ({ headSha: HEAD, aggregateBucket: 'pending' }),
          fetchInlineComments: async () => [],
          fetchReviews: async () => [],
          fetchConversationComments: async () => [
            { id: 21, body: TRIGGER_BODY, created_at: TRIGGER_AT, user: { login: SELF, type: 'User' } },
          ],
          fetchMergeState: async () => ({ mergeState: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
          verifyBotTriggerCoverage: async () => {
            verifierCalls += 1;
            return { covered: true };
          },
          now: () => TRIGGER_MS + 1_000,
        },
      );
      assert.equal(verifierCalls, 0, 'nothing was verified, so nothing may be claimed as verified');
      assert.equal(
        snapshot.botTurnProbe,
        'unavailable',
        'claiming "verified" here lets a later re-registration delete a live round',
      );
    });

    /*
     * sol R23: "cannot read as a result" is only a FAILURE of a round we can point at. Ordinary
     * bot chatter carries no commit evidence, and treating it as a verdict let unrelated noise
     * overwrite a pending F168 state with a failure nothing had established.
     */
    test('bot chatter with no matching open round establishes nothing', () => {
      const chatter = [
        {
          id: 22,
          author: BOT,
          body: 'Setting up your environment...',
          createdAt: '2026-09-02T09:40:00Z',
          commentType: 'conversation',
        },
      ];
      const noRound = deriveCloudReviewObservation({
        headSha: HEAD,
        comments: chatter,
        decisions: [],
        openTurns: {},
        now: TRIGGER_MS,
      });
      assert.equal(noRound, null, 'no round means no verdict to fail');

      const otherHead = deriveCloudReviewObservation({
        headSha: HEAD,
        comments: chatter,
        decisions: [],
        openTurns: { [BOT]: { triggerId: 21, openedAt: TRIGGER_MS, headSha: OLD_HEAD } },
        now: TRIGGER_MS,
      });
      assert.equal(otherHead, null, 'a round about another diff is not this diff failing');

      // And it must be the SAME bot. With one bot in the shipped table this is unreachable in
      // production today, so the identity table is injected to make the rule testable rather
      // than asserted-but-unprovable — a guard nothing can turn red is not a guard.
      const OTHER_BOT = 'some-other-reviewer[bot]';
      const twoBots = [
        { login: BOT, triggerHandles: ['codex'] },
        { login: OTHER_BOT, triggerHandles: ['other'] },
      ];
      const wrongBotComments = [{ ...chatter[0], author: OTHER_BOT }];
      const wrongBot = deriveCloudReviewObservation({
        headSha: HEAD,
        comments: wrongBotComments,
        decisions: [],
        events: batchOf(wrongBotComments, twoBots),
        openTurns: { [BOT]: { triggerId: 21, openedAt: TRIGGER_MS, headSha: HEAD } },
        knownBots: twoBots,
        now: TRIGGER_MS,
      });
      assert.equal(wrongBot?.status, 'running', "another bot's chatter does not fail our round");

      // With BOTH bots waiting, the failure must land on the round its author actually opened —
      // taking "the first round on this HEAD" reported the other bot's round as running and lost
      // the real failure entirely.
      const bothWaiting = deriveCloudReviewObservation({
        headSha: HEAD,
        comments: wrongBotComments,
        decisions: [],
        events: batchOf(wrongBotComments, twoBots),
        openTurns: {
          [BOT]: { triggerId: 10, openedAt: TRIGGER_MS, headSha: HEAD },
          [OTHER_BOT]: { triggerId: 20, openedAt: TRIGGER_MS + 1, headSha: HEAD },
        },
        knownBots: twoBots,
        now: TRIGGER_MS + 2,
      });
      assert.equal(bothWaiting?.status, 'failed_or_timeout');
      assert.equal(bothWaiting?.triggerCommentId, 20, 'the answering bot owns the verdict');
    });

    /*
     * sol R27: a full tie needs a RULE. GitHub timestamps are second-granularity, so two bots
     * answering in the same second is ordinary — and leaving that to the order the caller
     * happened to build the batch in makes the reported verdict depend on nothing real. The
     * property, not the arbitrary winner, is what is asserted: same facts, same answer.
     */
    test('two bots answering in the same second give the same verdict either way round', () => {
      const OTHER = 'some-other-reviewer[bot]';
      const twoBots = [
        { login: BOT, triggerHandles: ['codex'] },
        { login: OTHER, triggerHandles: ['other'] },
      ];
      const at = '2026-09-02T09:41:00Z';
      const fromOurBot = {
        id: 40,
        author: BOT,
        body: 'Codex could not review this pull request.',
        createdAt: at,
        commentType: 'conversation',
      };
      const fromOther = {
        id: 41,
        author: OTHER,
        body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${HEAD}\`\n`,
        createdAt: at,
        commentType: 'conversation',
      };
      const openTurns = {
        [BOT]: { triggerId: 10, openedAt: TRIGGER_MS, headSha: HEAD },
        [OTHER]: { triggerId: 20, openedAt: TRIGGER_MS, headSha: HEAD },
      };
      const observe = (comments) =>
        deriveCloudReviewObservation({
          headSha: HEAD,
          comments,
          decisions: [],
          events: normalizePrFeedbackBatch({ headSha: HEAD, comments, decisions: [], knownBots: twoBots }),
          openTurns,
          knownBots: twoBots,
          now: Date.parse(at) + 1_000,
        });
      assert.deepEqual(observe([fromOurBot, fromOther]), observe([fromOther, fromOurBot]));
    });

    test('the same unresolvable boundary appears twice, and both must say unavailable', async () => {
      const readerFor = (comment, isSelfLogin) =>
        readGitHubWaitBaseline(
          { repoFullName: 'owner/repo', prNumber: 1394, invocationId: 'inv-owner', isSelfLogin },
          {
            fetchCi: async () => ({ headSha: HEAD, aggregateBucket: 'pending' }),
            fetchInlineComments: async () => [],
            fetchReviews: async () => [],
            fetchConversationComments: async () => [comment],
            fetchMergeState: async () => ({ mergeState: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
            verifyBotTriggerCoverage: async () => ({ covered: true }),
            now: () => TRIGGER_MS + 1_000,
          },
        );

      // (a) GitHub gave us no author at all — a deleted or ghost account.
      const noAuthor = await readerFor({ id: 21, body: TRIGGER_BODY, created_at: TRIGGER_AT }, () => true);
      assert.equal(noAuthor.botTurnProbe, 'unavailable');

      // (b) Our own identity will not resolve.
      const noSelf = await readerFor(
        { id: 21, body: TRIGGER_BODY, created_at: TRIGGER_AT, user: { login: SELF, type: 'User' } },
        () => undefined,
      );
      assert.equal(noSelf.botTurnProbe, 'unavailable');
    });

    test('a bot answer we cannot read as a result closes the round AND reports it', () => {
      const openTurns = { [BOT]: { triggerId: 21, openedAt: TRIGGER_MS, headSha: HEAD } };
      const answer = [
        {
          id: 22,
          author: BOT,
          body: 'Codex could not review this pull request.',
          createdAt: '2026-09-02T09:40:00Z',
          commentType: 'conversation',
        },
      ];
      const observed = deriveCloudReviewObservation({
        headSha: HEAD,
        comments: answer,
        decisions: [],
        events: batchOf(answer),
        openTurns,
        now: TRIGGER_MS + 1_000,
      });
      // The same batch retires the round, so `running` here would be the LAST word forever.
      assert.equal(observed?.status, 'failed_or_timeout');
    });
  });
});
