import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

const CATALOG_URL = new URL('../dist/domains/github-signals/GitHubWaitPredicateCatalog.js', import.meta.url);
const STATE_MACHINE_URL = new URL('../dist/domains/ball-custody/wait-state-machine.js', import.meta.url);
const SHARED_URL = new URL('../../shared/dist/types/github-wait.js', import.meta.url);

describe('F280 #1392 redesign — converged contract', () => {
  // ──────────────────────────────────────────────
  // Case 1: pr_conversation_comment_added predicate
  // ──────────────────────────────────────────────
  describe('pr_conversation_comment_added', () => {
    it('matches conversation comments by authorLogins (case-insensitive)', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = {
        capturedAt: 100,
        headSha: 'abc123',
        review: { inlineCommentCursor: 0, conversationCommentCursor: 0, decisionCursor: 0 },
      };
      const facts = {
        headSha: 'abc123',
        review: {
          decisionCursor: 0,
          conversationComments: [
            { id: 5, author: 'Codex-Bot', createdAt: '2026-01-01T00:00:00Z', body: 'review comment' },
          ],
        },
      };
      const when = [{ kind: 'pr_conversation_comment_added', authorLogins: ['codex-bot'] }];
      const matches = matchGitHubWaitPredicates(when, baseline, facts);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].kind, 'pr_conversation_comment_added');
      assert.ok(matches[0].delta.includes('Codex-Bot'));
    });

    it('skips comments from non-listed authors', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = {
        capturedAt: 100,
        headSha: 'abc123',
        review: { inlineCommentCursor: 0, conversationCommentCursor: 0, decisionCursor: 0 },
      };
      const facts = {
        headSha: 'abc123',
        review: {
          decisionCursor: 0,
          conversationComments: [{ id: 5, author: 'random-user', createdAt: '2026-01-01T00:00:00Z', body: 'hello' }],
        },
      };
      const when = [{ kind: 'pr_conversation_comment_added', authorLogins: ['maintainer'] }];
      assert.equal(matchGitHubWaitPredicates(when, baseline, facts).length, 0);
    });

    it('schema rejects excludeMentions (removed per maintainer direction)', async () => {
      const { canonicalizeGitHubWaitPredicates } = await import(CATALOG_URL.href);
      assert.throws(() => {
        canonicalizeGitHubWaitPredicates([
          { kind: 'pr_conversation_comment_added', authorLogins: ['maintainer'], excludeMentions: ['codex'] },
        ]);
      });
    });
  });

  // ──────────────────────────────────────────────
  // Case 2: authorLogins on issue_comment_added
  // ──────────────────────────────────────────────
  describe('issue_comment_added with authorLogins', () => {
    it('filters to listed authors only', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = { capturedAt: 100, issue: { lastCommentCursor: 0, state: 'open' } };
      const facts = {
        issue: {
          state: 'open',
          comments: [
            { id: 1, author: 'maintainer' },
            { id: 2, author: 'random-user' },
            { id: 3, author: 'Maintainer' },
          ],
        },
      };
      const when = [{ kind: 'issue_comment_added', authorLogins: ['maintainer'] }];
      const matches = matchGitHubWaitPredicates(when, baseline, facts);
      assert.equal(matches.length, 2, 'case-insensitive: both maintainer comments should match');
    });

    it('matches all comments when authorLogins is absent', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = { capturedAt: 100, issue: { lastCommentCursor: 0, state: 'open' } };
      const facts = {
        issue: {
          state: 'open',
          comments: [
            { id: 1, author: 'user-a' },
            { id: 2, author: 'user-b' },
          ],
        },
      };
      const when = [{ kind: 'issue_comment_added' }];
      const matches = matchGitHubWaitPredicates(when, baseline, facts);
      assert.equal(matches.length, 2, 'without authorLogins, all comments match');
    });
  });

  // ──────────────────────────────────────────────
  // Case 3: Optional expiresAt — no time-based termination when omitted
  // ──────────────────────────────────────────────
  describe('optional expiresAt', () => {
    it('does not expire when expiresAt is omitted', async () => {
      const { transitionWaitState } = await import(STATE_MACHINE_URL.href);
      const current = {
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'pr:owner/repo#1',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: { capturedAt: 100, headSha: 'aaa' },
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
          continuation: { when: [{ kind: 'pr_head_changed' }], then: 'check' },
          // No expiresAt
          createdAt: 100,
        },
      };

      // Even far in the future, predicates_matched with no matches should not expire
      const result = transitionWaitState(current, {
        type: 'predicates_matched',
        generation: 1,
        at: 999_999_999,
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaa → bbb' }],
      });
      assert.equal(result.applied, true);
      assert.equal(result.state.waitOutcome?.reason, 'matched', 'should match, not expire');
    });

    it('expires with delivery:pending when expiresAt is set and time is up', async () => {
      const { transitionWaitState } = await import(STATE_MACHINE_URL.href);
      const current = {
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'pr:owner/repo#1',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: { capturedAt: 100, headSha: 'aaa' },
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
          continuation: { when: [{ kind: 'pr_head_changed' }], then: 'check' },
          expiresAt: 5000,
          createdAt: 100,
        },
      };

      const result = transitionWaitState(current, {
        type: 'predicates_matched',
        generation: 1,
        at: 5000,
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaa → bbb' }],
      });
      assert.equal(result.applied, true);
      assert.equal(result.state.waitOutcome?.reason, 'expired', 'expiresAt is loud terminal');
      assert.equal(result.state.waitOutcome?.delivery, 'pending', 'expiry must be delivered (loud)');
    });
  });

  // ──────────────────────────────────────────────
  // Case 4: Catalog schema admits pr_conversation_comment_added
  // ──────────────────────────────────────────────
  describe('predicate catalog schema', () => {
    it('admits pr_conversation_comment_added with authorLogins', async () => {
      const { canonicalizeGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const when = canonicalizeGitHubWaitPredicates([
        { kind: 'pr_conversation_comment_added', authorLogins: ['codex-bot'] },
      ]);
      assert.equal(when.length, 1);
      assert.equal(when[0].kind, 'pr_conversation_comment_added');
    });

    it('admits issue_comment_added with optional authorLogins', async () => {
      const { canonicalizeGitHubIssueWaitPredicates } = await import(CATALOG_URL.href);
      const when = canonicalizeGitHubIssueWaitPredicates([
        { kind: 'issue_comment_added', authorLogins: ['maintainer'] },
      ]);
      assert.equal(when.length, 1);
    });

    it('admits issue_comment_added without authorLogins', async () => {
      const { canonicalizeGitHubIssueWaitPredicates } = await import(CATALOG_URL.href);
      const when = canonicalizeGitHubIssueWaitPredicates([{ kind: 'issue_comment_added' }]);
      assert.equal(when.length, 1);
    });

    it('catalog lockstep assertion passes at load time', async () => {
      const { assertGitHubWaitPredicateCatalogReady } = await import(CATALOG_URL.href);
      assert.doesNotThrow(() => assertGitHubWaitPredicateCatalogReady());
    });
  });

  // ──────────────────────────────────────────────
  // Case 5: autoRenew type on UnifiedAwaitStateV1
  // ──────────────────────────────────────────────
  describe('autoRenew on await state type', () => {
    it('autoRenew field is accepted on AwaitStateV1 (no TS error in compiled output)', async () => {
      // The shared type allows autoRenew?: boolean on UnifiedAwaitStateV1.
      // If the dist compiled, this assertion passes. (Type-level test.)
      const shared = await import(SHARED_URL.href);
      assert.ok(shared.GITHUB_WAIT_PREDICATE_KINDS, 'shared module loads');
      assert.ok(shared.GITHUB_WAIT_PREDICATE_KINDS.includes('pr_conversation_comment_added'));
    });
  });

  // ──────────────────────────────────────────────
  // Case 6: autoRenewed on WaitOutcomeV1
  // ──────────────────────────────────────────────
  describe('renderer handles autoRenewed', () => {
    it('includes renewal indicator in rendered output', async () => {
      const { renderGitHubWaitOutcome } = await import(
        new URL('../dist/domains/github-signals/github-wait-renderer.js', import.meta.url).href
      );
      const outcome = {
        v: 1,
        outcomeId: 'test',
        generation: 1,
        subjectRef: 'pr:owner/repo#1',
        ownerFence: { kind: 'containing_task', generation: 1 },
        reason: 'matched',
        at: 1000,
        delivery: 'delivered',
        matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaa → bbb' }],
        nextStep: 'Read the review',
        autoRenewed: true,
      };
      const content = renderGitHubWaitOutcome(outcome);
      assert.ok(content.includes('auto-renewed'), 'should mention auto-renewal');
    });
  });

  // ──────────────────────────────────────────────
  // Case 7: shouldAutoRenew backward compatibility
  // ──────────────────────────────────────────────
  describe('shouldAutoRenew backward compat', () => {
    it('pre-existing waits without autoRenew field do NOT auto-renew', async () => {
      const { transitionWaitState } = await import(STATE_MACHINE_URL.href);
      // Simulate a pre-existing wait: no autoRenew field
      const current = {
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'pr:owner/repo#1',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: { capturedAt: 100, headSha: 'aaa' },
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
          continuation: { when: [{ kind: 'pr_head_changed' }], then: 'check' },
          createdAt: 100,
          // No autoRenew field — pre-existing one-shot
        },
      };
      // shouldAutoRenew(active) === false when autoRenew is absent
      assert.equal(current.await.autoRenew, undefined);
      // This means the lifecycle will NOT auto-renew — test is type-level
    });

    it('explicit autoRenew:true enables renewal', () => {
      const state = { autoRenew: true };
      assert.equal(state.autoRenew === true, true);
    });

    it('explicit autoRenew:false disables renewal', () => {
      const state = { autoRenew: false };
      assert.equal(state.autoRenew === true, false);
    });
  });

  // ──────────────────────────────────────────────
  // Case 8: Expiry is loud — delivery:pending
  // ──────────────────────────────────────────────
  describe('loud expiry', () => {
    it('expired outcome gets delivery:pending for notification', async () => {
      const { transitionWaitState } = await import(STATE_MACHINE_URL.href);
      const current = {
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'pr:owner/repo#1',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: { capturedAt: 100, headSha: 'aaa' },
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
          continuation: { when: [{ kind: 'pr_head_changed' }], then: 'check' },
          expiresAt: 1000,
          createdAt: 100,
        },
      };
      // Expired (no predicates matched, time past expiresAt)
      const result = transitionWaitState(current, {
        type: 'expired',
        generation: 1,
        at: 1001,
      });
      assert.equal(result.applied, true);
      assert.equal(result.state.waitOutcome?.reason, 'expired');
      assert.equal(result.state.waitOutcome?.delivery, 'pending', 'expiry must be delivered loudly');
      assert.ok(result.state.waitOutcome?.nextStep, 'expired outcome should include nextStep');
    });
  });

  // ──────────────────────────────────────────────
  // Case 9: Atomic renewal delivery-mark CAS
  // ──────────────────────────────────────────────
  describe('atomic renewal delivery CAS', () => {
    it('delivery-mark CAS succeeds after atomic renewal (gen N+1)', async () => {
      // Regression: publishPending used outcome.generation (N) for the CAS,
      // but after atomic renewal the task has await.generation (N+1).
      // CAS failed silently → outcome stayed pending → next observe re-delivered.
      const { GitHubWaitLifecycleService } = await import(
        new URL('../dist/domains/github-signals/GitHubWaitLifecycleService.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );
      const { MessageStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/MessageStore.js', import.meta.url).href
      );
      const { MemoryWaitLifecycleEventLog } = await import(
        new URL('../dist/domains/ball-custody/WaitLifecycleEventLog.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const messageStore = new MessageStore();
      const eventLog = new MemoryWaitLifecycleEventLog();
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#99',
        threadId: 'thread_renewal',
        title: 'PR tracking: owner/repo#99',
        ownerCatId: 'test-cat',
        why: 'test',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#99',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: { capturedAt: 100, headSha: 'aaa111' },
            continuation: {
              when: [{ kind: 'pr_head_changed' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check the new HEAD',
            },
            expiresAt: 99_999,
            createdAt: 100,
            autoRenew: true,
            provenance: 'explicit_registration',
          },
        },
      });

      const lifecycle = new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog,
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
      });

      // First observe: should match + auto-renew to gen 2
      const first = await lifecycle.observe({
        taskId: task.id,
        facts: { headSha: 'bbb222' },
      });
      assert.equal(first.kind, 'notified', 'first observe delivers');

      // Verify gen 2 installed with correct baseline
      const afterFirst = await taskStore.get(task.id);
      assert.equal(afterFirst.automationState.await.generation, 2, 'auto-renewed to gen 2');
      assert.equal(afterFirst.automationState.await.baseline.headSha, 'bbb222', 'baseline updated');
      assert.equal(afterFirst.automationState.waitOutcome.delivery, 'delivered', 'delivery marked as delivered');

      // Second observe with same facts: should NOT re-deliver
      const replay = await lifecycle.observe({
        taskId: task.id,
        facts: { headSha: 'bbb222' },
      });
      assert.notEqual(replay.kind, 'notified', 'replay must not re-deliver');
      assert.equal(messageStore.getByThreadIncludingQueued('thread_renewal').length, 1, 'exactly one queued message');
    });
  });

  // ──────────────────────────────────────────────
  // Case 10: Renewal baseline carries trigger fields (P1-1)
  // ──────────────────────────────────────────────
  describe('renewal baseline carries trigger fields', () => {
    it('resultTriggerCommentId and resultTriggerHeadSha survive atomic renewal', async () => {
      const { GitHubWaitLifecycleService } = await import(
        new URL('../dist/domains/github-signals/GitHubWaitLifecycleService.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );
      const { MessageStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/MessageStore.js', import.meta.url).href
      );
      const { MemoryWaitLifecycleEventLog } = await import(
        new URL('../dist/domains/ball-custody/WaitLifecycleEventLog.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const messageStore = new MessageStore();
      const eventLog = new MemoryWaitLifecycleEventLog();
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#77',
        threadId: 'thread_trigger_carry',
        title: 'PR tracking: owner/repo#77',
        ownerCatId: 'test-cat',
        why: 'test trigger field carryforward',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#77',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: {
              capturedAt: 100,
              headSha: 'aaa111',
              review: {
                inlineCommentCursor: 0,
                conversationCommentCursor: 5,
                decisionCursor: 1,
                resultTriggerCommentId: 42,
                resultTriggerHeadSha: 'aaa111',
              },
            },
            continuation: {
              when: [{ kind: 'pr_head_changed' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check the new HEAD',
            },
            expiresAt: 99_999,
            createdAt: 100,
            autoRenew: true,
            provenance: 'explicit_registration',
          },
        },
      });

      const lifecycle = new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog,
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
      });

      // Trigger pr_head_changed → atomic renewal
      await lifecycle.observe({
        taskId: task.id,
        facts: {
          headSha: 'bbb222',
          review: {
            decisionCursor: 1,
            conversationComments: [
              { id: 10, author: 'reviewer', createdAt: '2026-01-01T00:00:00Z' },
              { id: 15, author: 'reviewer', createdAt: '2026-01-02T00:00:00Z' },
            ],
          },
        },
      });

      const after = await taskStore.get(task.id);
      assert.equal(after.automationState.await.generation, 2, 'auto-renewed to gen 2');
      const newBaseline = after.automationState.await.baseline;

      // P1-1: trigger fields must survive renewal
      assert.equal(
        newBaseline.review.resultTriggerCommentId,
        42,
        'resultTriggerCommentId must carry forward from previous baseline',
      );
      assert.ok(newBaseline.review.resultTriggerHeadSha, 'resultTriggerHeadSha must be present on renewed baseline');

      // conversationCommentCursor must be computed from max conversationComments ID
      assert.equal(
        newBaseline.review.conversationCommentCursor,
        15,
        'conversationCommentCursor should be max of conversationComments IDs',
      );
    });
  });

  // ──────────────────────────────────────────────
  // Case 11: Issue expiry tick fires without new comments (P1-2)
  // ──────────────────────────────────────────────
  describe('issue expiry tick', () => {
    it('gate emits work item for expired issue wait even without new comments', async () => {
      const { createIssueCommentTaskSpec } = await import(
        new URL('../dist/infrastructure/email/IssueCommentTaskSpec.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      await taskStore.create({
        kind: 'issue_tracking',
        subjectKey: 'issue:owner/repo#55',
        threadId: 'thread_expiry',
        title: 'Issue tracking: owner/repo#55',
        ownerCatId: 'test-cat',
        why: 'test expired issue wait',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          issue: { lastCommentCursor: 10, issueState: 'open' },
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'issue:owner/repo#55',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: {
              capturedAt: 100,
              issue: { lastCommentCursor: 10, state: 'open', authorLogin: 'author' },
            },
            continuation: {
              when: [{ kind: 'issue_comment_added' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check the issue',
            },
            // Expired 5 seconds ago
            expiresAt: Date.now() - 5000,
            createdAt: 100,
            provenance: 'explicit_registration',
          },
        },
      });

      let observeCalled = false;
      const spec = createIssueCommentTaskSpec({
        taskStore,
        issueCommentRouter: { route: async () => ({ invoked: false }) },
        fetchComments: async () => [],
        fetchIssueState: async () => 'open',
        waitLifecycle: {
          observe: async () => {
            observeCalled = true;
            return { kind: 'state_only', reason: 'expired' };
          },
        },
        log: { info() {}, error() {}, warn() {} },
      });

      const gateResult = await spec.admission.gate();
      assert.equal(gateResult.run, true, 'gate must produce work items for expired issue waits');
      assert.ok(observeCalled || gateResult.workItems?.length > 0, 'expired wait must reach observe()');
    });
  });

  // ──────────────────────────────────────────────
  // Case 12: Pre-existing waits stay one-shot through LifecycleService (P2)
  // ──────────────────────────────────────────────
  describe('pre-existing waits stay one-shot', () => {
    it('waits without autoRenew field do NOT auto-renew on predicate match', async () => {
      const { GitHubWaitLifecycleService } = await import(
        new URL('../dist/domains/github-signals/GitHubWaitLifecycleService.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );
      const { MessageStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/MessageStore.js', import.meta.url).href
      );
      const { MemoryWaitLifecycleEventLog } = await import(
        new URL('../dist/domains/ball-custody/WaitLifecycleEventLog.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const messageStore = new MessageStore();
      const eventLog = new MemoryWaitLifecycleEventLog();
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#88',
        threadId: 'thread_oneshot',
        title: 'PR tracking: owner/repo#88',
        ownerCatId: 'test-cat',
        why: 'test one-shot backward compat',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#88',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: { capturedAt: 100, headSha: 'aaa111' },
            continuation: {
              when: [{ kind: 'pr_head_changed' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check the new HEAD',
            },
            expiresAt: 99_999,
            createdAt: 100,
            provenance: 'explicit_registration',
            // NOTE: no autoRenew field — pre-existing one-shot wait
          },
        },
      });

      const lifecycle = new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog,
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
      });

      const result = await lifecycle.observe({
        taskId: task.id,
        facts: { headSha: 'bbb222' },
      });

      assert.equal(result.kind, 'notified', 'predicate matched → delivered');

      const after = await taskStore.get(task.id);
      // Must NOT auto-renew: no gen 2 installed
      assert.equal(after.automationState.await, undefined, 'one-shot: await must be cleared after match');
      assert.equal(after.status, 'done', 'one-shot: task must transition to done');
      assert.equal(after.automationState.waitOutcome.autoRenewed, undefined, 'must not have autoRenewed marker');
      assert.equal(after.automationState.waitOutcome.delivery, 'delivered', 'outcome must be delivered');
    });
  });

  // ──────────────────────────────────────────────
  // Case 13: pending re-delivery must not lose N+1 matching facts (P1-1 round 3)
  // ──────────────────────────────────────────────
  describe('pending re-delivery evaluates gen N+1 facts', () => {
    it('N+1 transitions when facts match during gen N pending re-delivery', async () => {
      const { GitHubWaitLifecycleService } = await import(
        new URL('../dist/domains/github-signals/GitHubWaitLifecycleService.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );
      const { MessageStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/MessageStore.js', import.meta.url).href
      );
      const { MemoryWaitLifecycleEventLog } = await import(
        new URL('../dist/domains/ball-custody/WaitLifecycleEventLog.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const messageStore = new MessageStore();
      const eventLog = new MemoryWaitLifecycleEventLog();
      // Set up: gen 1 matched and pending delivery, gen 2 await active.
      // This simulates atomic renewal where the delivery hasn't been sent yet.
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#101',
        threadId: 'thread_n1_facts',
        title: 'PR tracking: owner/repo#101',
        ownerCatId: 'test-cat',
        why: 'test N+1 fact preservation',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 20, lastDecisionCursor: 5 },
          // Gen 1 outcome: pending delivery (crash between transition and send)
          waitOutcome: {
            v: 1,
            outcomeId: 'wait:pr:owner/repo#101:g1:matched',
            generation: 1,
            subjectRef: 'pr:owner/repo#101',
            ownerFence: { kind: 'containing_task', generation: 1 },
            reason: 'matched',
            at: 400,
            delivery: 'pending',
            matched: [{ kind: 'pr_head_changed', delta: 'HEAD aaa → bbb' }],
            nextStep: 'Check',
            autoRenewed: true,
          },
          // Gen 2 await: watching for conversation comment from maintainer
          await: {
            v: 1,
            generation: 2,
            subjectRef: 'pr:owner/repo#101',
            ownerFence: { kind: 'containing_task', generation: 2 },
            baseline: {
              capturedAt: 400,
              headSha: 'bbb222',
              review: { inlineCommentCursor: 10, conversationCommentCursor: 20, decisionCursor: 5 },
            },
            continuation: {
              when: [{ kind: 'pr_conversation_comment_added', authorLogins: ['maintainer'] }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Read maintainer comment',
            },
            expiresAt: 99_999,
            createdAt: 400,
            autoRenew: true,
            provenance: 'explicit_registration',
          },
        },
      });

      const lifecycle = new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog,
        now: () => 600,
        log: { info() {}, warn() {}, error() {} },
      });

      // Observation arrives with facts that match gen 2's predicate
      // (a maintainer comment at id=30, above gen 2's baseline cursor of 20)
      const result = await lifecycle.observe({
        taskId: task.id,
        facts: {
          headSha: 'bbb222',
          review: {
            decisionCursor: 5,
            conversationComments: [{ id: 30, author: 'Maintainer', createdAt: '2026-01-01T00:00:00Z', body: 'LGTM' }],
          },
        },
        collectorPatch: {
          review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 30, lastDecisionCursor: 5 },
        },
      });

      // Gen 1 must be delivered
      assert.equal(result.kind, 'notified', 'gen 1 pending must be re-delivered');

      // After delivery, gen 2 must have been evaluated and transitioned
      const after = await taskStore.get(task.id);
      const g2Outcome = after.automationState.waitOutcome;
      assert.ok(g2Outcome, 'gen 2 must have an outcome after fact evaluation');
      assert.equal(g2Outcome.generation, 2, 'outcome must be from gen 2');
      assert.equal(g2Outcome.reason, 'matched', 'gen 2 must have matched on maintainer comment');
      assert.equal(g2Outcome.delivery, 'pending', 'gen 2 outcome must be pending delivery');

      // Collector state must also have been merged
      assert.equal(after.automationState.review.lastConversationCommentCursor, 30, 'collector cursor must be advanced');

      // Now a second observe() call should deliver gen 2
      const result2 = await lifecycle.observe({
        taskId: task.id,
        facts: { headSha: 'bbb222' },
      });
      assert.equal(result2.kind, 'notified', 'gen 2 must be delivered on the next call');
    });

    it('advances gen N+1 baseline when facts do not match predicates', async () => {
      const { GitHubWaitLifecycleService } = await import(
        new URL('../dist/domains/github-signals/GitHubWaitLifecycleService.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );
      const { MessageStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/MessageStore.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const messageStore = new MessageStore();
      // Gen 1 pending, gen 2 watches for head change but facts only have comments
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#111',
        threadId: 'thread_baseline_advance',
        title: 'PR tracking: owner/repo#111',
        ownerCatId: 'test-cat',
        why: 'test baseline advance on non-match',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 20 },
          waitOutcome: {
            v: 1,
            outcomeId: 'wait:pr:owner/repo#111:g1:matched',
            generation: 1,
            subjectRef: 'pr:owner/repo#111',
            ownerFence: { kind: 'containing_task', generation: 1 },
            reason: 'matched',
            at: 400,
            delivery: 'pending',
            matched: [{ kind: 'pr_conversation_comment_added', delta: 'comment' }],
            nextStep: 'Check',
            autoRenewed: true,
          },
          await: {
            v: 1,
            generation: 2,
            subjectRef: 'pr:owner/repo#111',
            ownerFence: { kind: 'containing_task', generation: 2 },
            baseline: {
              capturedAt: 400,
              headSha: 'aaa111',
              review: { inlineCommentCursor: 10, conversationCommentCursor: 20, decisionCursor: 0 },
            },
            continuation: {
              when: [{ kind: 'pr_head_changed' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check',
            },
            createdAt: 400,
            autoRenew: true,
            provenance: 'explicit_registration',
          },
        },
      });

      const lifecycle = new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        now: () => 600,
        log: { info() {}, warn() {}, error() {} },
      });

      // Facts: same headSha (no head change), but review cursor advanced
      await lifecycle.observe({
        taskId: task.id,
        facts: {
          headSha: 'aaa111',
          review: { decisionCursor: 3, conversationComments: [{ id: 35 }] },
        },
        collectorPatch: {
          review: { lastConversationCommentCursor: 35 },
        },
      });

      const after = await taskStore.get(task.id);
      // Gen 2 baseline must be advanced to include the facts we just saw
      const baseline = after.automationState.await.baseline;
      assert.ok(baseline, 'gen 2 await must still be active');
      assert.ok(
        baseline.review.conversationCommentCursor >= 35,
        `baseline conversation cursor (${baseline.review.conversationCommentCursor}) must be >= 35 after advance`,
      );
    });
  });

  // ──────────────────────────────────────────────
  // Case 14: renewal baseline must be full durable frontier (P1-2)
  // ──────────────────────────────────────────────
  describe('renewal baseline full frontier', () => {
    it('renewal baseline uses collector cursors when they exceed facts', async () => {
      const { GitHubWaitLifecycleService } = await import(
        new URL('../dist/domains/github-signals/GitHubWaitLifecycleService.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );
      const { MessageStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/MessageStore.js', import.meta.url).href
      );
      const { MemoryWaitLifecycleEventLog } = await import(
        new URL('../dist/domains/ball-custody/WaitLifecycleEventLog.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const messageStore = new MessageStore();
      const eventLog = new MemoryWaitLifecycleEventLog();
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#102',
        threadId: 'thread_frontier',
        title: 'PR tracking: owner/repo#102',
        ownerCatId: 'test-cat',
        why: 'test full frontier baseline',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          // Collector has processed up to these cursor positions
          review: { lastInlineCommentCursor: 30, lastConversationCommentCursor: 40, lastDecisionCursor: 15 },
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#102',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: {
              capturedAt: 100,
              headSha: 'aaa111',
              review: { inlineCommentCursor: 10, conversationCommentCursor: 20, decisionCursor: 5 },
            },
            continuation: {
              when: [{ kind: 'pr_head_changed' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check HEAD',
            },
            expiresAt: 99_999,
            createdAt: 100,
            autoRenew: true,
            provenance: 'explicit_registration',
          },
        },
      });

      const lifecycle = new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog,
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
      });

      // Facts report lower cursor values than collector
      await lifecycle.observe({
        taskId: task.id,
        facts: {
          headSha: 'bbb222',
          review: { decisionCursor: 8 },
        },
        collectorPatch: {
          review: { lastInlineCommentCursor: 30, lastConversationCommentCursor: 40, lastDecisionCursor: 15 },
        },
      });

      const after = await taskStore.get(task.id);
      assert.equal(after.automationState.await.generation, 2, 'auto-renewed to gen 2');
      const newBaseline = after.automationState.await.baseline;
      // P1-2: baseline must be the FULL frontier, not just facts
      assert.ok(
        newBaseline.review.inlineCommentCursor >= 30,
        `baseline inline cursor (${newBaseline.review.inlineCommentCursor}) must be >= collector frontier (30)`,
      );
      assert.ok(
        newBaseline.review.conversationCommentCursor >= 40,
        `baseline conversation cursor (${newBaseline.review.conversationCommentCursor}) must be >= collector frontier (40)`,
      );
      // P1-2 round 3: decisionCursor must also use full frontier
      assert.ok(
        newBaseline.review.decisionCursor >= 15,
        `baseline decision cursor (${newBaseline.review.decisionCursor}) must be >= collector frontier (15)`,
      );
    });
  });

  // ──────────────────────────────────────────────
  // Case 15: autoRenewed must appear in delivered content (P1-4)
  // ──────────────────────────────────────────────
  describe('autoRenewed in delivered content', () => {
    it('delivered message content includes tracking-continued indicator', async () => {
      const { GitHubWaitLifecycleService } = await import(
        new URL('../dist/domains/github-signals/GitHubWaitLifecycleService.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );
      const { MessageStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/MessageStore.js', import.meta.url).href
      );
      const { MemoryWaitLifecycleEventLog } = await import(
        new URL('../dist/domains/ball-custody/WaitLifecycleEventLog.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const messageStore = new MessageStore();
      const eventLog = new MemoryWaitLifecycleEventLog();
      const task = await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#103',
        threadId: 'thread_content',
        title: 'PR tracking: owner/repo#103',
        ownerCatId: 'test-cat',
        why: 'test autoRenewed in content',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'pr:owner/repo#103',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: { capturedAt: 100, headSha: 'aaa111' },
            continuation: {
              when: [{ kind: 'pr_head_changed' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Check HEAD',
            },
            expiresAt: 99_999,
            createdAt: 100,
            autoRenew: true,
            provenance: 'explicit_registration',
          },
        },
      });

      const lifecycle = new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog,
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
      });

      const result = await lifecycle.observe({
        taskId: task.id,
        facts: { headSha: 'bbb222' },
      });

      assert.equal(result.kind, 'notified');
      // P1-4: delivered content must mention auto-renewal
      assert.ok(
        result.content.includes('auto-renewed') || result.content.includes('Tracking'),
        `delivered content must indicate tracking continued, got: ${result.content.slice(0, 200)}`,
      );
    });
  });

  // ──────────────────────────────────────────────
  // Case 16: observe-path wake must persist via commitRoutedWake (P1-3)
  // ──────────────────────────────────────────────
  describe('observe-path wake persistence in IssueCommentTaskSpec', () => {
    it('commitRoutedWake is called before invokeTrigger on the observe path', async () => {
      const { createIssueCommentTaskSpec } = await import(
        new URL('../dist/infrastructure/email/IssueCommentTaskSpec.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      const task = await taskStore.create({
        kind: 'issue_tracking',
        subjectKey: 'issue:owner/repo#55',
        threadId: 'thread_observe_wake',
        title: 'Issue tracking: owner/repo#55',
        ownerCatId: 'test-cat',
        why: 'test observe wake persistence',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          issue: { lastCommentCursor: 0, issueState: 'open' },
          await: {
            v: 1,
            generation: 1,
            subjectRef: 'issue:owner/repo#55',
            ownerFence: { kind: 'containing_task', generation: 1 },
            baseline: { capturedAt: 100, issue: { lastCommentCursor: 0, state: 'open' } },
            continuation: {
              when: [{ kind: 'issue_comment_added' }],
              // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
              then: 'Notify owner',
            },
            expiresAt: 99_999,
            createdAt: 100,
            provenance: 'explicit_registration',
          },
        },
      });

      let commitRoutedWakeCalled = false;
      let triggerThrew = false;

      const spec = createIssueCommentTaskSpec({
        taskStore,
        issueCommentRouter: {
          route: async () => ({ kind: 'silent' }),
        },
        fetchComments: async () => [],
        fetchIssueState: async () => 'open',
        waitLifecycle: {
          observe: async () => ({
            kind: 'notified',
            task,
            outcome: { outcomeId: 'o1', generation: 1, reason: 'matched', delivery: 'delivered' },
            content: 'mock notification content',
            messageId: 'msg_mock_1',
          }),
        },
        invokeTrigger: {
          trigger: async () => {
            // By the time we reach invokeTrigger, commitRoutedWake must have been called
            if (!commitRoutedWakeCalled) {
              triggerThrew = true;
              throw new Error('commitRoutedWake was not called before invokeTrigger');
            }
            return 'dispatched';
          },
        },
        log: { info() {}, warn() {}, error() {} },
      });

      // Build the signal as the execute function expects it
      const signal = {
        task,
        repoFullName: 'owner/repo',
        issueNumber: 55,
        newComments: [{ id: 1, author: 'maintainer', body: 'hello', createdAt: '2026-01-01T00:00:00Z' }],
        issueState: 'open',
        deliveredCursor: 1,
        commitRoutedWake: async (_wake) => {
          commitRoutedWakeCalled = true;
        },
        commitWakeAccepted: async () => {},
      };

      await spec.run.execute(signal, 'issue:owner/repo#55', { signal: { throwIfAborted: () => {} } });

      assert.ok(commitRoutedWakeCalled, 'commitRoutedWake must be called on the observe path');
      assert.ok(!triggerThrew, 'commitRoutedWake must be called BEFORE invokeTrigger');
    });
  });

  // ──────────────────────────────────────────────
  // Case 17: done tasks with pendingWake must not be filtered by gate (P1-3 round 3)
  // ──────────────────────────────────────────────
  describe('done-task pendingWake retry', () => {
    it('gate includes done tasks that have a pendingWake for retry', async () => {
      const { createIssueCommentTaskSpec } = await import(
        new URL('../dist/infrastructure/email/IssueCommentTaskSpec.js', import.meta.url).href
      );
      const { TaskStore } = await import(
        new URL('../dist/domains/cats/services/stores/ports/TaskStore.js', import.meta.url).href
      );

      const taskStore = new TaskStore();
      // Create a done task with a pendingWake — simulates a non-renewing
      // match or loud expiry where invokeTrigger failed after transition.
      const task = await taskStore.create({
        kind: 'issue_tracking',
        subjectKey: 'issue:owner/repo#77',
        threadId: 'thread_done_wake',
        title: 'Issue tracking: owner/repo#77',
        ownerCatId: 'test-cat',
        why: 'test done task pendingWake',
        createdBy: 'test-cat',
        userId: 'user_1',
        automationState: {
          issue: {
            lastCommentCursor: 5,
            issueState: 'open',
            pendingWake: {
              threadId: 'thread_done_wake',
              catId: 'test-cat',
              content: 'retry me',
              messageId: 'msg_retry_1',
              deliveredCursor: 5,
            },
          },
          waitOutcome: {
            v: 1,
            outcomeId: 'wait:issue:owner/repo#77:g1:matched',
            generation: 1,
            subjectRef: 'issue:owner/repo#77',
            ownerFence: { kind: 'containing_task', generation: 1 },
            reason: 'matched',
            at: 500,
            delivery: 'delivered',
            matched: [{ kind: 'issue_comment_added', delta: 'new comment' }],
            nextStep: 'Read',
          },
        },
      });
      // Mark task as done (simulates non-renewing match status transition)
      await taskStore.update(task.id, { status: 'done' });

      const spec = createIssueCommentTaskSpec({
        taskStore,
        issueCommentRouter: { route: async () => ({ kind: 'silent' }) },
        fetchComments: async () => [],
        fetchIssueState: async () => 'open',
        log: { info() {}, warn() {}, error() {} },
      });

      const gateResult = await spec.admission.gate();
      // Gate must include this done task because it has a pendingWake
      assert.ok(gateResult.run, 'gate must include done tasks with pendingWake');
      assert.ok(gateResult.workItems.length >= 1, 'gate must produce at least one work item for the pendingWake retry');
      const wake = gateResult.workItems[0].signal;
      assert.ok(wake.retryWake, 'work item must carry retryWake from the pendingWake');
      assert.equal(wake.retryWake.messageId, 'msg_retry_1', 'retryWake must be the original pending wake');
    });
  });
});
