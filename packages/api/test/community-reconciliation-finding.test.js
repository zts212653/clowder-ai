/**
 * CommunityReconciliationFindingStore tests (F168 Phase D — D3+D4)
 *
 * Redis-backed finding store with no TTL.
 * AC coverage:
 * D4.1 — finding lifecycle (stable id, open/acknowledged/resolved/waived)
 * D4.2 — waiver audit (requires reason + actor + evidence)
 *
 * Runs only under `pnpm test:redis` (isolated Redis on port 6398, DB 15).
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = `test-finding-${Date.now()}:`;

describe('CommunityReconciliationFindingStore (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let CommunityReconciliationFindingStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'CommunityReconciliationFindingStore');

    const mod = await import('../dist/domains/community/CommunityReconciliationFindingStore.js');
    CommunityReconciliationFindingStore = mod.CommunityReconciliationFindingStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient(REDIS_URL, { keyPrefix: KEY_PREFIX });
    await redis.ping();
    connected = true;
    store = new CommunityReconciliationFindingStore(redis);
  });

  after(async () => {
    if (connected) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  beforeEach(async () => {
    if (connected) await cleanupClientKeyspace(redis);
  });

  // -----------------------------------------------------------------------
  // D4.1 — finding lifecycle
  // -----------------------------------------------------------------------

  describe('finding lifecycle (D4.1)', () => {
    const baseFinding = {
      findingId: 'reconcile:issue:acme/repo#1:github-closed-case-open',
      subjectKey: 'issue:acme/repo#1',
      findingKind: 'github-closed-case-open',
      severity: 'warning',
      message: 'GitHub is closed but case is still open.',
    };

    it('upsert creates a new finding in open status', async () => {
      await store.upsert(baseFinding);
      const all = await store.listBySubject(baseFinding.subjectKey);
      assert.equal(all.length, 1);
      assert.equal(all[0].findingId, baseFinding.findingId);
      assert.equal(all[0].status, 'open');
    });

    it('upsert is idempotent — same findingId does not duplicate', async () => {
      await store.upsert(baseFinding);
      await store.upsert(baseFinding);
      const all = await store.listBySubject(baseFinding.subjectKey);
      assert.equal(all.length, 1);
    });

    it('acknowledge transitions open → acknowledged', async () => {
      await store.upsert(baseFinding);
      await store.acknowledge(baseFinding.findingId);
      const all = await store.listBySubject(baseFinding.subjectKey);
      assert.equal(all[0].status, 'acknowledged');
    });

    it('resolve transitions finding to resolved status', async () => {
      await store.upsert(baseFinding);
      await store.resolve(baseFinding.findingId);
      const all = await store.listBySubject(baseFinding.subjectKey);
      assert.equal(all[0].status, 'resolved');
    });

    it('resolved finding remains queryable', async () => {
      await store.upsert(baseFinding);
      await store.resolve(baseFinding.findingId);
      const f = await store.get(baseFinding.findingId);
      assert.ok(f);
      assert.equal(f.status, 'resolved');
    });

    it('resolveAbsent marks open findings as resolved when absent', async () => {
      await store.upsert(baseFinding);
      await store.resolveAbsent(baseFinding.subjectKey, []);
      const f = await store.get(baseFinding.findingId);
      assert.equal(f.status, 'resolved');
    });

    it('resolveAbsent does NOT resolve a waived finding', async () => {
      await store.upsert(baseFinding);
      await store.waive(baseFinding.findingId, {
        reason: 'intentional',
        actor: 'opus',
        evidence: 'link',
      });
      await store.resolveAbsent(baseFinding.subjectKey, []);
      const f = await store.get(baseFinding.findingId);
      assert.equal(f.status, 'waived');
    });

    it('waived does not reopen on re-upsert with same fingerprint', async () => {
      await store.upsert(baseFinding);
      await store.waive(baseFinding.findingId, {
        reason: 'intentional',
        actor: 'opus',
        evidence: 'original-link',
      });
      // Re-upsert same finding — should stay waived
      await store.upsert(baseFinding);
      const f = await store.get(baseFinding.findingId);
      assert.equal(f.status, 'waived');
    });

    it('resolved finding reopens on re-upsert (recurring drift)', async () => {
      await store.upsert(baseFinding);
      await store.resolve(baseFinding.findingId);
      // Drift recurs — same finding re-upserted → must reopen
      await store.upsert(baseFinding);
      const f = await store.get(baseFinding.findingId);
      assert.equal(f.status, 'open');
    });

    it('waived reopens when evidence fingerprint changes', async () => {
      await store.upsert(baseFinding);
      await store.waive(baseFinding.findingId, {
        reason: 'intentional',
        actor: 'opus',
        evidence: 'original-link',
      });
      // Re-upsert with CHANGED evidence fingerprint — should reopen
      await store.upsert({ ...baseFinding, evidenceFingerprint: 'new-sha' });
      const f = await store.get(baseFinding.findingId);
      assert.equal(f.status, 'open');
    });
  });

  // -----------------------------------------------------------------------
  // D4.2 — waiver audit
  // -----------------------------------------------------------------------

  describe('waiver audit (D4.2)', () => {
    const finding = {
      findingId: 'reconcile:issue:acme/repo#2:stale-awaiting-external',
      subjectKey: 'issue:acme/repo#2',
      findingKind: 'stale-awaiting-external',
      severity: 'warning',
      message: 'Stale awaiting external.',
    };

    it('waiver rejects empty reason', async () => {
      await store.upsert(finding);
      await assert.rejects(
        () => store.waive(finding.findingId, { reason: '', actor: 'cat', evidence: 'link' }),
        /reason/i,
      );
    });

    it('waiver rejects empty actor', async () => {
      await store.upsert(finding);
      await assert.rejects(
        () => store.waive(finding.findingId, { reason: 'ok', actor: '', evidence: 'link' }),
        /actor/i,
      );
    });

    it('waiver rejects empty evidence', async () => {
      await store.upsert(finding);
      await assert.rejects(
        () => store.waive(finding.findingId, { reason: 'ok', actor: 'cat', evidence: '' }),
        /evidence/i,
      );
    });

    it('valid waiver stores reason + actor + evidence on the finding', async () => {
      await store.upsert(finding);
      await store.waive(finding.findingId, {
        reason: 'expected behavior',
        actor: 'opus',
        evidence: 'https://example.com/discussion',
      });
      const f = await store.get(finding.findingId);
      assert.equal(f.status, 'waived');
      assert.equal(f.waiver.reason, 'expected behavior');
      assert.equal(f.waiver.actor, 'opus');
      assert.equal(f.waiver.evidence, 'https://example.com/discussion');
    });
  });

  // -----------------------------------------------------------------------
  // Read model — listOpen
  // -----------------------------------------------------------------------

  describe('read model', () => {
    it('listOpen returns only open and acknowledged findings', async () => {
      const f1 = {
        findingId: 'rm-f1',
        subjectKey: 'issue:acme/repo#10',
        findingKind: 'github-closed-case-open',
        severity: 'warning',
        message: 'm1',
      };
      const f2 = {
        findingId: 'rm-f2',
        subjectKey: 'issue:acme/repo#10',
        findingKind: 'stale-needs-info',
        severity: 'warning',
        message: 'm2',
      };
      await store.upsert(f1);
      await store.upsert(f2);
      await store.resolve(f2.findingId);

      const open = await store.listOpen();
      const openIds = open.map((f) => f.findingId);
      assert.ok(openIds.includes('rm-f1'));
      assert.ok(!openIds.includes('rm-f2'));
    });

    it('listAll returns findings of every status (open, acknowledged, resolved, waived)', async () => {
      const findings = [
        {
          findingId: 'all-f1',
          subjectKey: 'issue:acme/repo#20',
          findingKind: 'k1',
          severity: 'warning',
          message: 'open',
        },
        {
          findingId: 'all-f2',
          subjectKey: 'issue:acme/repo#20',
          findingKind: 'k2',
          severity: 'warning',
          message: 'ack',
        },
        {
          findingId: 'all-f3',
          subjectKey: 'issue:acme/repo#20',
          findingKind: 'k3',
          severity: 'warning',
          message: 'resolved',
        },
        {
          findingId: 'all-f4',
          subjectKey: 'issue:acme/repo#20',
          findingKind: 'k4',
          severity: 'warning',
          message: 'waived',
        },
      ];
      for (const f of findings) await store.upsert(f);
      await store.acknowledge('all-f2');
      await store.resolve('all-f3');
      await store.waive('all-f4', { reason: 'ok', actor: 'cat', evidence: 'link' });

      const all = await store.listAll();
      const allIds = all.map((f) => f.findingId).sort();
      assert.deepEqual(allIds, ['all-f1', 'all-f2', 'all-f3', 'all-f4']);
      // Verify each status is preserved
      const byId = Object.fromEntries(all.map((f) => [f.findingId, f.status]));
      assert.equal(byId['all-f1'], 'open');
      assert.equal(byId['all-f2'], 'acknowledged');
      assert.equal(byId['all-f3'], 'resolved');
      assert.equal(byId['all-f4'], 'waived');
    });
  });
});
