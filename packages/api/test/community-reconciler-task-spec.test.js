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
    const mod = await import('../dist/domains/community/CommunityReconcilerTaskSpec.js');
    createCommunityReconcilerTaskSpec = mod.createCommunityReconcilerTaskSpec;
  });

  // -----------------------------------------------------------------------
  // P2-1 — baseline deferred on fetch failure
  // -----------------------------------------------------------------------

  describe('baseline + fetch failures (cloud P2-1)', () => {
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
