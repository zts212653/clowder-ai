/**
 * PR lifecycle community event tests (F168 Phase A — Task 8)
 * Redis-backed — PR merged/closed detection → event log → linked issue projection fixed.
 *
 * Scenarios:
 * 1. PR merged → pr.merged event in log → PR projection → fixed
 * 2. PR merged + linked issue → issue projection → fixed (cascade)
 * 3. PR closed → pr.closed event → PR projection → closed
 * 4. Idempotency: re-run produces no duplicate events
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('PR lifecycle community events (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisCommunityEventLog;
  let RedisCommunityObjectStore;
  let CommunityProjector;
  let createRedisClient;
  let redis;
  let eventLog;
  let objectStore;
  let projector;
  let connected = false;

  const KEY_PATTERNS = ['community:events:*', 'community:object:*', 'community:objects:*'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'PRLifecycle');

    const elMod = await import('../dist/domains/community/CommunityEventLog.js');
    RedisCommunityEventLog = elMod.RedisCommunityEventLog;

    const osMod = await import('../dist/domains/community/CommunityObjectStore.js');
    RedisCommunityObjectStore = osMod.RedisCommunityObjectStore;

    const projMod = await import('../dist/domains/community/community-projector.js');
    CommunityProjector = projMod.CommunityProjector;

    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient(REDIS_URL);
    await redis.ping();
    connected = true;

    eventLog = new RedisCommunityEventLog(redis);
    objectStore = new RedisCommunityObjectStore(redis);
    projector = new CommunityProjector(eventLog, objectStore);
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  // -----------------------------------------------------------------------
  // Helper: seed a PR projection (simulates post-routing state)
  // -----------------------------------------------------------------------

  async function seedPrProjection(repoFullName, prNumber, linkedIssues = []) {
    const subjectKey = `pr:${repoFullName}#${prNumber}`;
    const projection = {
      repo: repoFullName,
      type: 'pr',
      number: prNumber,
      subjectKey,
      state: 'routed',
      ownerThreadId: 'thread-1',
      ownerRole: 'codex',
      nextOwner: 'none',
      lastExternalActivityAt: null,
      lastPublicCommentAt: null,
      linkedIssues,
      linkedPrs: [],
      closureWaiver: null,
      appliedEventCount: 1,
      lastRejectedEvent: null,
      deliveryCursor: null,
      createdAt: 1000,
      updatedAt: 1000,
    };
    await objectStore.save(projection);
  }

  async function seedIssueProjection(repoFullName, issueNumber, state = 'routed') {
    const subjectKey = `issue:${repoFullName}#${issueNumber}`;
    const projection = {
      repo: repoFullName,
      type: 'issue',
      number: issueNumber,
      subjectKey,
      state,
      ownerThreadId: 'thread-1',
      ownerRole: 'codex',
      nextOwner: 'none',
      lastExternalActivityAt: null,
      lastPublicCommentAt: null,
      linkedIssues: [],
      linkedPrs: [`pr:${repoFullName}#${issueNumber}`],
      closureWaiver: null,
      appliedEventCount: 1,
      lastRejectedEvent: null,
      deliveryCursor: null,
      createdAt: 1000,
      updatedAt: 1000,
    };
    await objectStore.save(projection);
  }

  // -----------------------------------------------------------------------
  // Tests
  // -----------------------------------------------------------------------

  it('PR merged → pr.merged event appended → PR projection → fixed', async () => {
    await seedPrProjection('owner/repo', 10, []);

    const prMergedEvent = {
      sourceEventId: 'lifecycle:pr:owner/repo#10:merged',
      subjectKey: 'pr:owner/repo#10',
      kind: 'pr.merged',
      classification: 'state-changing',
      payload: { prState: 'merged', repoFullName: 'owner/repo', prNumber: 10 },
      at: Date.now(),
    };

    const { appended } = await eventLog.append(prMergedEvent);
    assert.ok(appended, 'event must be appended');

    await projector.apply(prMergedEvent);

    const prProj = await objectStore.get('pr:owner/repo#10');
    assert.strictEqual(prProj.state, 'fixed', 'PR projection should be fixed after pr.merged');

    const events = await eventLog.read('pr:owner/repo#10');
    assert.ok(events.length >= 1, 'event log should have at least one event');
    assert.ok(events.some((e) => e.kind === 'pr.merged'));
  });

  it('PR merged + linked issue → issue projection → fixed (cascade)', async () => {
    // Pre-seed PR projection with linkedIssues: [42] (issue number)
    await seedPrProjection('owner/repo', 10, [42]);
    await seedIssueProjection('owner/repo', 42, 'routed');

    const prMergedEvent = {
      sourceEventId: 'lifecycle:pr:owner/repo#10:merged',
      subjectKey: 'pr:owner/repo#10',
      kind: 'pr.merged',
      classification: 'state-changing',
      payload: { prState: 'merged', repoFullName: 'owner/repo', prNumber: 10 },
      at: Date.now(),
    };

    const { appended } = await eventLog.append(prMergedEvent);
    assert.ok(appended);
    await projector.apply(prMergedEvent);

    // PR projection → fixed
    const prProj = await objectStore.get('pr:owner/repo#10');
    assert.strictEqual(prProj.state, 'fixed', 'PR should be fixed');

    // Linked issue → fixed (cascade)
    const issueProj = await objectStore.get('issue:owner/repo#42');
    assert.ok(issueProj, 'linked issue projection should exist');
    assert.strictEqual(issueProj.state, 'fixed', 'linked issue should be fixed via cascade');

    // Cascade event should be in the issue's event log
    const issueEvents = await eventLog.read('issue:owner/repo#42');
    assert.ok(issueEvents.length >= 1, 'cascade event should be in issue event log');
    assert.ok(issueEvents.some((e) => e.kind === 'pr.merged'));
  });

  it('PR closed → pr.closed event → PR projection → closed', async () => {
    await seedPrProjection('owner/repo', 11, []);

    const prClosedEvent = {
      sourceEventId: 'lifecycle:pr:owner/repo#11:closed',
      subjectKey: 'pr:owner/repo#11',
      kind: 'pr.closed',
      classification: 'state-changing',
      payload: { prState: 'closed', repoFullName: 'owner/repo', prNumber: 11 },
      at: Date.now(),
    };

    const { appended } = await eventLog.append(prClosedEvent);
    assert.ok(appended);
    await projector.apply(prClosedEvent);

    const prProj = await objectStore.get('pr:owner/repo#11');
    assert.strictEqual(prProj.state, 'closed', 'PR projection should be closed after pr.closed');
  });

  it('idempotency: re-run produces no duplicate events', async () => {
    await seedPrProjection('owner/repo', 10, []);

    const prMergedEvent = {
      sourceEventId: 'lifecycle:pr:owner/repo#10:merged',
      subjectKey: 'pr:owner/repo#10',
      kind: 'pr.merged',
      classification: 'state-changing',
      payload: { prState: 'merged', repoFullName: 'owner/repo', prNumber: 10 },
      at: Date.now(),
    };

    await eventLog.append(prMergedEvent);
    await projector.apply(prMergedEvent);

    // Re-run same event
    const { appended: secondAppend } = await eventLog.append(prMergedEvent);
    assert.strictEqual(secondAppend, false, 're-run should be deduped');

    const events = await eventLog.read('pr:owner/repo#10');
    assert.strictEqual(events.length, 1, 'exactly one event expected');
  });
});
