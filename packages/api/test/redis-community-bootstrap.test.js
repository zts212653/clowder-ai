/**
 * community-bootstrap tests (F168 Phase A — Task 5)
 * Redis-backed — idempotent migration from CommunityIssueStore → Event Log + projection.
 *
 * Scenarios:
 * 1. 3 issues with different states → bootstrap → projections created with correct state mapping
 * 2. Re-run is idempotent (no duplicate events)
 * 3. Dry-run mode → reports diff but does not write
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function makeIssueRecord(repo, issueNumber, state) {
  return {
    id: `${repo}-${issueNumber}`,
    repo,
    issueNumber,
    issueType: 'bug',
    title: `Issue ${issueNumber}`,
    state,
    replyState: 'unreplied',
    assignedThreadId: null,
    assignedCatId: null,
    linkedPrNumbers: [],
    directionCard: null,
    ownerDecision: null,
    relatedFeature: null,
    guardianAssignment: null,
    lastActivity: { at: 1000, event: 'created' },
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe('community-bootstrap (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let bootstrap;
  let CommunityEventLog;
  let CommunityObjectStore;
  let createRedisClient;
  let redis;
  let eventLog;
  let objectStore;
  let connected = false;

  const KEY_PATTERNS = ['community:events:*', 'community:object:*', 'community:objects:*'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'CommunityBootstrap');

    const bMod = await import('../dist/domains/community/community-bootstrap.js');
    bootstrap = bMod.communityBootstrap;

    const elMod = await import('../dist/domains/community/CommunityEventLog.js');
    CommunityEventLog = elMod.RedisCommunityEventLog;

    const osMod = await import('../dist/domains/community/CommunityObjectStore.js');
    CommunityObjectStore = osMod.RedisCommunityObjectStore;

    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient(REDIS_URL);
    await redis.ping();
    connected = true;

    eventLog = new CommunityEventLog(redis);
    objectStore = new CommunityObjectStore(redis);
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  // -----------------------------------------------------------------------
  // State mapping
  // -----------------------------------------------------------------------

  describe('state mapping', () => {
    it('maps unreplied → new', async () => {
      const issues = [makeIssueRecord('owner/repo', 1, 'unreplied')];
      await bootstrap({ issues, eventLog, objectStore, dryRun: false });
      const proj = await objectStore.get('issue:owner/repo#1');
      assert.strictEqual(proj.state, 'new');
    });

    it('maps discussing → triaged', async () => {
      const issues = [makeIssueRecord('owner/repo', 2, 'discussing')];
      await bootstrap({ issues, eventLog, objectStore, dryRun: false });
      const proj = await objectStore.get('issue:owner/repo#2');
      assert.strictEqual(proj.state, 'triaged');
    });

    it('maps pending-decision → triaged', async () => {
      const issues = [makeIssueRecord('owner/repo', 3, 'pending-decision')];
      await bootstrap({ issues, eventLog, objectStore, dryRun: false });
      const proj = await objectStore.get('issue:owner/repo#3');
      assert.strictEqual(proj.state, 'triaged');
    });

    it('maps accepted → routed', async () => {
      const issues = [makeIssueRecord('owner/repo', 4, 'accepted')];
      await bootstrap({ issues, eventLog, objectStore, dryRun: false });
      const proj = await objectStore.get('issue:owner/repo#4');
      assert.strictEqual(proj.state, 'routed');
    });

    it('maps declined → declined', async () => {
      const issues = [makeIssueRecord('owner/repo', 5, 'declined')];
      await bootstrap({ issues, eventLog, objectStore, dryRun: false });
      const proj = await objectStore.get('issue:owner/repo#5');
      assert.strictEqual(proj.state, 'declined');
    });

    it('maps closed → closed (closure invariant exempted for bootstrap)', async () => {
      const issues = [makeIssueRecord('owner/repo', 6, 'closed')];
      await bootstrap({ issues, eventLog, objectStore, dryRun: false });
      const proj = await objectStore.get('issue:owner/repo#6');
      assert.strictEqual(proj.state, 'closed');
    });
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------

  describe('idempotency', () => {
    it('re-run produces no duplicate events', async () => {
      const issues = [makeIssueRecord('owner/repo', 10, 'unreplied')];
      await bootstrap({ issues, eventLog, objectStore, dryRun: false });
      await bootstrap({ issues, eventLog, objectStore, dryRun: false });
      const events = await eventLog.read('issue:owner/repo#10');
      assert.strictEqual(events.length, 1, 'exactly one bootstrap event expected');
    });
  });

  // -----------------------------------------------------------------------
  // Dry-run
  // -----------------------------------------------------------------------

  describe('dry-run', () => {
    it('dry-run does not write events or projections', async () => {
      const issues = [makeIssueRecord('owner/repo', 20, 'unreplied')];
      const report = await bootstrap({ issues, eventLog, objectStore, dryRun: true });
      assert.ok(Array.isArray(report), 'dry-run should return a report array');
      assert.ok(report.length > 0, 'dry-run should report would-create items');

      const proj = await objectStore.get('issue:owner/repo#20');
      assert.strictEqual(proj, null, 'dry-run must not write projections');
      const events = await eventLog.read('issue:owner/repo#20');
      assert.strictEqual(events.length, 0, 'dry-run must not write events');
    });
  });
});
