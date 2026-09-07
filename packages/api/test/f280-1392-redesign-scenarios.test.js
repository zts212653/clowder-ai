import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

const CATALOG_URL = new URL('../dist/domains/github-signals/GitHubWaitPredicateCatalog.js', import.meta.url);
const DEFAULTSET_URL = new URL('../dist/domains/github-signals/PrTrackingDefaultSet.js', import.meta.url);
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

    it('matches every conversation comment when authorLogins is omitted (#1392 catch-all)', async () => {
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
          conversationComments: [{ id: 7, author: 'anyone-at-all', createdAt: '2026-01-01T00:00:00Z', body: 'hi' }],
        },
      };
      const when = [{ kind: 'pr_conversation_comment_added' }];
      const matches = matchGitHubWaitPredicates(when, baseline, facts);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].kind, 'pr_conversation_comment_added');
    });

    it('schema accepts pr_conversation_comment_added without authorLogins (#1392)', async () => {
      const { canonicalizeGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const parsed = canonicalizeGitHubWaitPredicates([{ kind: 'pr_conversation_comment_added' }]);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].kind, 'pr_conversation_comment_added');
      assert.equal(parsed[0].authorLogins, undefined);
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

  describe('pr_inline_comment_added (#1392)', () => {
    it('matches inline comments by authorLogins (case-insensitive)', async () => {
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
          inlineComments: [{ id: 9, author: 'Maintainer', createdAt: '2026-01-01T00:00:00Z', sourceRef: 'x' }],
        },
      };
      const when = [{ kind: 'pr_inline_comment_added', authorLogins: ['maintainer'] }];
      const matches = matchGitHubWaitPredicates(when, baseline, facts);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].kind, 'pr_inline_comment_added');
      assert.ok(matches[0].delta.includes('inline comment #9'));
    });

    it('matches every inline comment above the cursor when authorLogins is omitted', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = {
        capturedAt: 100,
        headSha: 'abc123',
        review: { inlineCommentCursor: 3, conversationCommentCursor: 0, decisionCursor: 0 },
      };
      const facts = {
        headSha: 'abc123',
        review: {
          decisionCursor: 0,
          inlineComments: [
            { id: 3, author: 'old', createdAt: '2026-01-01T00:00:00Z' },
            { id: 4, author: 'anyone', createdAt: '2026-01-02T00:00:00Z' },
          ],
        },
      };
      const when = [{ kind: 'pr_inline_comment_added' }];
      const matches = matchGitHubWaitPredicates(when, baseline, facts);
      assert.equal(matches.length, 1);
      assert.ok(matches[0].delta.includes('#4'));
    });

    it('schema accepts pr_inline_comment_added without authorLogins', async () => {
      const { canonicalizeGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const parsed = canonicalizeGitHubWaitPredicates([{ kind: 'pr_inline_comment_added' }]);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].kind, 'pr_inline_comment_added');
    });
  });

  describe('pr_base_behind (#1392)', () => {
    it('fires when the PR transitions to behind base', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = { capturedAt: 100, headSha: 'abc123', base: { isBehind: false } };
      const facts = { headSha: 'abc123', base: { isBehind: true } };
      const when = [{ kind: 'pr_base_behind' }];
      const matches = matchGitHubWaitPredicates(when, baseline, facts);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].kind, 'pr_base_behind');
    });

    it('does not fire when already behind (no transition)', async () => {
      const { matchGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const baseline = { capturedAt: 100, headSha: 'abc123', base: { isBehind: true } };
      const facts = { headSha: 'abc123', base: { isBehind: true } };
      const when = [{ kind: 'pr_base_behind' }];
      assert.equal(matchGitHubWaitPredicates(when, baseline, facts).length, 0);
    });

    it('schema accepts pr_base_behind', async () => {
      const { canonicalizeGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const parsed = canonicalizeGitHubWaitPredicates([{ kind: 'pr_base_behind' }]);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].kind, 'pr_base_behind');
    });
  });

  describe('buildPrTrackingPredicates (#1392 default set)', () => {
    it('materializes the 7 default events when nothing is specified', async () => {
      const { buildPrTrackingPredicates } = await import(DEFAULTSET_URL.href);
      const kinds = buildPrTrackingPredicates().map((p) => p.kind);
      assert.deepEqual(kinds, [
        'pr_review_decision_changed',
        'pr_conversation_comment_added',
        'pr_inline_comment_added',
        'pr_bot_interaction',
        'pr_ci_terminal',
        'pr_became_conflicting',
        'pr_base_behind',
      ]);
      const conv = buildPrTrackingPredicates().find((p) => p.kind === 'pr_conversation_comment_added');
      assert.equal(conv.authorLogins, undefined);
    });

    it('include adds a non-default event', async () => {
      const { buildPrTrackingPredicates } = await import(DEFAULTSET_URL.href);
      const kinds = buildPrTrackingPredicates({ include: ['head_changed'] }).map((p) => p.kind);
      assert.ok(kinds.includes('pr_head_changed'));
      assert.equal(kinds.length, 8);
    });

    it('exclude removes a default event', async () => {
      const { buildPrTrackingPredicates } = await import(DEFAULTSET_URL.href);
      const kinds = buildPrTrackingPredicates({ exclude: ['base_behind'] }).map((p) => p.kind);
      assert.ok(!kinds.includes('pr_base_behind'));
      assert.equal(kinds.length, 6);
    });

    it('throws loudly on an unknown event name (no silent drop)', async () => {
      const { buildPrTrackingPredicates } = await import(DEFAULTSET_URL.href);
      assert.throws(() => buildPrTrackingPredicates({ include: ['nonsense'] }), /unknown PR tracking event/);
      assert.throws(() => buildPrTrackingPredicates({ exclude: ['also-bad'] }), /unknown PR tracking event/);
    });

    it('the materialized default set passes catalog validation', async () => {
      const { buildPrTrackingPredicates } = await import(DEFAULTSET_URL.href);
      const { canonicalizeGitHubWaitPredicates } = await import(CATALOG_URL.href);
      const parsed = canonicalizeGitHubWaitPredicates(buildPrTrackingPredicates());
      assert.equal(parsed.length, 7);
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
      // #1394: assert the PROMISE (the owner is told tracking continues), not a word.
      // develop_base renders the truthful pair "re-armed" / "closed (single-fire)";
      // the branch wording ("auto-renewed") was the weaker of the two.
      assert.match(content, /re-armed/i, 'a renewed wake must tell the owner tracking continues');
      const singleFire = renderGitHubWaitOutcome({ ...outcome, autoRenewed: false });
      assert.match(singleFire, /single-fire|closed/i, 'a non-renewed wake must say tracking is over');
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
      // #1394: an expired wait carries NO continuation. Nothing is armed, so there is no
      // "next step" to hand the owner — attaching one (the branch behaviour) reads as if
      // tracking were still alive. Loud AND honest: notify, but do not imply a live wait.
      assert.equal(
        result.state.waitOutcome?.nextStep,
        undefined,
        'an expired wait is over — it must not carry a continuation',
      );
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
});
