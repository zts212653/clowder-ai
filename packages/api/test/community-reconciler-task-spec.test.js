/**
 * CommunityReconcilerTaskSpec tests (F168 Phase D — D3)
 *
 * Integration tests for the schedule-driven reconciliation TaskSpec.
 * Verifies TaskSpec-level logic that isn't covered by pure reconciler tests.
 *
 * AC coverage:
 * P2-1 — baseline must not be marked when fetch failures occur
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

const NOW = 1_718_700_000_000;

describe('CommunityReconcilerTaskSpec', () => {
  let createCommunityReconcilerTaskSpec;

  before(async () => {
    const mod = await import('../dist/domains/community/reconciliation/CommunityReconcilerTaskSpec.js');
    createCommunityReconcilerTaskSpec = mod.createCommunityReconcilerTaskSpec;
  });

  // -----------------------------------------------------------------------
  // P2-1 — baseline deferred on fetch failure
  // -----------------------------------------------------------------------

  describe('baseline + fetch failures (cloud P2-1)', () => {
    it('projects an appended reconciliation event even when cancellation arrives at the append boundary', async () => {
      const controller = new AbortController();
      const applied = [];
      const projection = {
        repo: 'acme/repo',
        type: 'issue',
        number: 1,
        subjectKey: 'issue:acme/repo#1',
        state: 'new',
        ownerThreadId: null,
        ownerRole: null,
        nextOwner: 'none',
        lastExternalActivityAt: null,
        lastPublicCommentAt: null,
        linkedIssues: [],
        linkedPrs: [],
        closureWaiver: null,
        appliedEventCount: 1,
        lastRejectedEvent: null,
        deliveryCursor: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const taskSpec = createCommunityReconcilerTaskSpec({
        objectStore: {
          get: async () => projection,
          listSubjectKeys: async () => [projection.subjectKey],
        },
        eventLog: {
          append: async () => {
            controller.abort(new Error('scheduler timeout'));
            return { appended: true, sequence: 1 };
          },
        },
        projector: { apply: async (event) => applied.push(event.kind) },
        findingStore: { upsert: async () => {}, resolveAbsent: async () => {} },
        fetchIssueState: async () => ({
          state: 'closed',
          closedAt: '2026-08-22T00:00:00.000Z',
          mergedAt: null,
        }),
        fetchPrState: async () => null,
        log: { info() {}, warn() {} },
        isBaselineEstablished: async () => true,
        markBaselineEstablished: async () => {},
      });

      await taskSpec.run
        .execute({ subjectKeys: [projection.subjectKey] }, 'community:reconciler:batch', {
          assignedCatId: null,
          signal: controller.signal,
        })
        .catch(() => {});

      assert.deepEqual(applied, ['issue.closed']);
    });

    it('stops the batch loop before starting another GitHub fetch after cancellation', async () => {
      const controller = new AbortController();
      const fetched = [];
      let persisted = false;
      const taskSpec = createCommunityReconcilerTaskSpec({
        objectStore: {
          get: async (sk) => ({
            repo: 'acme/repo',
            type: 'issue',
            number: Number(sk.at(-1)),
            subjectKey: sk,
            state: 'new',
            ownerThreadId: null,
            ownerRole: null,
            nextOwner: 'none',
            lastExternalActivityAt: null,
            lastPublicCommentAt: null,
            linkedIssues: [],
            linkedPrs: [],
            closureWaiver: null,
            appliedEventCount: 1,
            lastRejectedEvent: null,
            deliveryCursor: null,
            createdAt: NOW,
            updatedAt: NOW,
          }),
          listSubjectKeys: async () => [],
        },
        eventLog: { append: async () => ({ appended: false }) },
        projector: { apply: async () => {} },
        findingStore: {
          upsert: async () => {
            persisted = true;
          },
          resolveAbsent: async () => {
            persisted = true;
          },
        },
        fetchIssueState: async (_repo, number, signal) => {
          assert.equal(signal, controller.signal);
          fetched.push(number);
          controller.abort(new Error('scheduler timeout'));
          return { state: 'open', closedAt: null, mergedAt: null };
        },
        fetchPrState: async () => null,
        log: { info() {}, warn() {} },
        isBaselineEstablished: async () => false,
        markBaselineEstablished: async () => {
          persisted = true;
        },
      });

      await assert.rejects(
        taskSpec.run.execute(
          { subjectKeys: ['issue:acme/repo#1', 'issue:acme/repo#2'] },
          'community:reconciler:batch',
          { assignedCatId: null, signal: controller.signal },
        ),
        /scheduler timeout/,
      );
      assert.deepEqual(fetched, [1]);
      assert.equal(persisted, false);
    });

    it('does NOT mark baseline when some subjects have fetch failures', async () => {
      let baselineMarked = false;
      const logs = [];

      const taskSpec = createCommunityReconcilerTaskSpec({
        objectStore: {
          get: async (sk) => ({
            repo: 'acme/repo',
            type: 'issue',
            number: sk === 'issue:acme/repo#1' ? 1 : 2,
            subjectKey: sk,
            state: 'new',
            ownerThreadId: null,
            ownerRole: null,
            nextOwner: 'none',
            lastExternalActivityAt: null,
            lastPublicCommentAt: null,
            linkedIssues: [],
            linkedPrs: [],
            closureWaiver: null,
            appliedEventCount: 1,
            lastRejectedEvent: null,
            deliveryCursor: null,
            createdAt: NOW - 86_400_000 * 10,
            updatedAt: NOW - 86_400_000 * 5,
          }),
          listSubjectKeys: async () => ['issue:acme/repo#1', 'issue:acme/repo#2'],
        },
        eventLog: { append: async () => ({ appended: false }) },
        projector: { apply: async () => {} },
        findingStore: {
          upsert: async () => {},
          resolveAbsent: async () => {},
        },
        // Issue #1 succeeds, issue #2 throws (fetch failure)
        fetchIssueState: async (_repo, num) => {
          if (num === 2) throw new Error('GitHub API 502');
          return { state: 'open', closedAt: null, mergedAt: null };
        },
        fetchPrState: async () => ({ state: 'open', closedAt: null, mergedAt: null }),
        log: {
          info: (...a) => logs.push(['info', ...a]),
          warn: (...a) => logs.push(['warn', ...a]),
        },
        isBaselineEstablished: async () => false,
        markBaselineEstablished: async () => {
          baselineMarked = true;
        },
      });

      // Execute the batch run
      const signal = { subjectKeys: ['issue:acme/repo#1', 'issue:acme/repo#2'] };
      await taskSpec.run.execute(signal, 'community:reconciler:batch', {});

      // Baseline must NOT be marked — issue #2 had a fetch failure
      assert.equal(baselineMarked, false, 'baseline should NOT be marked when fetch failures exist');
      // Should log a warning about deferred baseline
      const warnLogs = logs.filter((l) => l[0] === 'warn');
      assert.ok(
        warnLogs.some((l) => String(l[1]).includes('deferred') || String(l[1]).includes('Baseline')),
        'should log a warning about deferred baseline',
      );
    });

    it('marks baseline when ALL subjects are fetched successfully', async () => {
      let baselineMarked = false;

      const taskSpec = createCommunityReconcilerTaskSpec({
        objectStore: {
          get: async (sk) => ({
            repo: 'acme/repo',
            type: 'issue',
            number: sk === 'issue:acme/repo#1' ? 1 : 2,
            subjectKey: sk,
            state: 'new',
            ownerThreadId: null,
            ownerRole: null,
            nextOwner: 'none',
            lastExternalActivityAt: null,
            lastPublicCommentAt: null,
            linkedIssues: [],
            linkedPrs: [],
            closureWaiver: null,
            appliedEventCount: 1,
            lastRejectedEvent: null,
            deliveryCursor: null,
            createdAt: NOW - 86_400_000 * 10,
            updatedAt: NOW - 86_400_000 * 5,
          }),
          listSubjectKeys: async () => ['issue:acme/repo#1', 'issue:acme/repo#2'],
        },
        eventLog: { append: async () => ({ appended: false }) },
        projector: { apply: async () => {} },
        findingStore: {
          upsert: async () => {},
          resolveAbsent: async () => {},
        },
        fetchIssueState: async () => ({ state: 'open', closedAt: null, mergedAt: null }),
        fetchPrState: async () => ({ state: 'open', closedAt: null, mergedAt: null }),
        log: { info: () => {}, warn: () => {} },
        isBaselineEstablished: async () => false,
        markBaselineEstablished: async () => {
          baselineMarked = true;
        },
      });

      const signal = { subjectKeys: ['issue:acme/repo#1', 'issue:acme/repo#2'] };
      await taskSpec.run.execute(signal, 'community:reconciler:batch', {});

      assert.equal(baselineMarked, true, 'baseline should be marked when all fetches succeed');
    });
  });
});
