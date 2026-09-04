import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisApprovalLifecycleEpochAuthority } from '../../dist/domains/approval-hub/ApprovalLifecycleEpochAuthority.js';
import { registerF311E0EvalRepairOwnerRuntime } from '../../dist/infrastructure/capability-evolution/change/f311-e0-eval-repair-owner-runtime-registration.js';
import {
  createEvalRepairOwnerRuntime,
  EvalRepairOwnerRuntimeRegistration,
} from '../../dist/infrastructure/harness-eval/eval-repair-owner-runtime.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';
import { MemoryEventLog } from './eval-repair-approval-fixtures.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'test:f313:owner-alpha-preflight:';
const PROGRAM_ID = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
const TARGET_REF = { ownerFeatureId: 'F311', ownerStateRef: 'capability:f311-investor-roadshow-expression' };
const principal = {
  invocationId: 'inv-alpha-owner',
  userId: 'default-user',
  catId: 'codex-sol',
  threadId: 'thread-alpha-owner',
  originMessageId: 'message-alpha-owner',
};

function registration(connects) {
  const value = new EvalRepairOwnerRuntimeRegistration();
  registerF311E0EvalRepairOwnerRuntime({
    registration: value,
    repoRoot: new URL('../../../..', import.meta.url).pathname,
    ownerUserId: 'default-user',
    programReader: {
      async get() {
        return {
          program: {
            programId: PROGRAM_ID,
            objectRef: TARGET_REF,
            valueOwnerRef: { ownerFeatureId: 'F311', ownerStateRef: 'user:default-user' },
            cycle: 1,
          },
        };
      },
    },
    invocationRegistry: {
      async peekRecord(invocationId) {
        return invocationId === principal.invocationId
          ? {
              ...principal,
              ownerAuthProvenance: 'strict',
              originTriggerMessageId: principal.originMessageId,
            }
          : null;
      },
    },
    connectEvolutionOwner(owner) {
      connects.owner = owner;
    },
    connectOutcomeService(service) {
      connects.outcome = service;
    },
  });
  return value;
}

function runtimeOptions(epochAuthority, eventLog, ownerRegistration, cards) {
  return {
    lifecycleVersion: 1,
    loaderVersion: 1,
    routeVersion: 1,
    materializerVersion: 1,
    eventLog,
    approvalIngress: {
      async publish(card) {
        cards.push(card);
        throw new Error('fail-closed E0 must not publish an Approval card');
      },
    },
    approvalAdapter: {
      featureId: 'F266',
      async listPending() {
        return [];
      },
      async listSettled() {
        return [];
      },
    },
    epochAuthority,
    caseActionResolver: async () => null,
    releaseTruth: {
      loadedRuntimeHead: undefined,
      verifyMainLanded() {
        throw new Error('no intervention receipt is authorized');
      },
      verifyLiveActive() {
        throw new Error('no intervention receipt is authorized');
      },
    },
    registration: ownerRegistration,
  };
}

describe('F313 official Alpha owner-integration preflight', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F313 Alpha owner-integration preflight');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupClientKeyspace(redis);
  });

  it('stays dormant for missing/legacy production epochs, then becomes reachable only in isolated v1_active Alpha', async () => {
    const epoch = new RedisApprovalLifecycleEpochAuthority(redis);
    const missingConnects = {};
    const missingEvents = new MemoryEventLog();
    const missingCards = [];
    const missing = await createEvalRepairOwnerRuntime(
      runtimeOptions(epoch, missingEvents, registration(missingConnects), missingCards),
    );
    assert.equal(missing.status, 'dormant');
    assert.ok(missing.missing.includes('epoch:proposal_ingress:v1_active'));
    assert.deepEqual(missingConnects, {});
    assert.equal((await missingEvents.listSubjectIds()).length, 0);
    assert.equal(missingCards.length, 0);

    await epoch.initializeLegacy('F266', 31, '2026-09-02T00:00:00.000Z');
    const legacyConnects = {};
    const legacy = await createEvalRepairOwnerRuntime(
      runtimeOptions(epoch, new MemoryEventLog(), registration(legacyConnects), []),
    );
    assert.equal(legacy.status, 'dormant');
    assert.deepEqual(legacyConnects, {});

    await epoch.transition({
      producerId: 'F266',
      expectedEpoch: 31,
      expectedRevision: 0,
      to: 'draining',
      occurredAt: '2026-09-02T00:01:00.000Z',
    });
    await epoch.transition({
      producerId: 'F266',
      expectedEpoch: 31,
      expectedRevision: 1,
      to: 'fenced',
      occurredAt: '2026-09-02T00:02:00.000Z',
    });
    await epoch.transition({
      producerId: 'F266',
      expectedEpoch: 31,
      expectedRevision: 2,
      to: 'v1_active',
      occurredAt: '2026-09-02T00:03:00.000Z',
      quiescence: { activeDecisionCommands: 0, materializationAttempts: 0, recoveryLeases: 0 },
      cutoverReceiptRef: 'alpha-preflight:f313-owner-integration',
    });

    const activeConnects = {};
    const activeEvents = new MemoryEventLog();
    const activeCards = [];
    const active = await createEvalRepairOwnerRuntime(
      runtimeOptions(epoch, activeEvents, registration(activeConnects), activeCards),
    );
    assert.equal(active.status, 'active');
    assert.equal(activeConnects.owner, active.evolutionOwner);
    assert.equal(activeConnects.outcome, active.outcomeService);

    const forged = await active.evolutionOwner.requestApproval({
      programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
      cycleRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-cycle:${PROGRAM_ID}:1` },
      interventionRef: TARGET_REF,
      clientMessageId: 'alpha-forged-origin',
      requestAuthority: { ...principal, originMessageId: 'forged' },
    });
    assert.deepEqual(forged, { status: 'blocked', reason: 'request_origin_unverified' });

    const noLineage = await active.evolutionOwner.requestApproval({
      programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
      cycleRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-cycle:${PROGRAM_ID}:1` },
      interventionRef: TARGET_REF,
      clientMessageId: 'alpha-missing-lineage',
      requestAuthority: principal,
    });
    assert.deepEqual(noLineage, { status: 'blocked', reason: 'lineage_missing' });

    const forgedReceipt = await active.outcomeService.recordIntervention({
      caseRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-case:missing' },
      proposalRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-proposal:missing' },
      approvalRef: { ownerFeatureId: 'F246', ownerStateRef: 'approval:missing' },
      ownerAuthorizationRef: { ownerFeatureId: 'F311', ownerStateRef: 'owner-authorization:forged' },
      targetVersionRef: {
        ...TARGET_REF,
        version: 'owner-binding-v1',
        assetKind: 'capability',
        assetId: 'f311-investor-roadshow-expression',
      },
      interventionRef: TARGET_REF,
      receiptRef: { ownerFeatureId: 'F311', ownerStateRef: 'owner-receipt:forged' },
    });
    assert.deepEqual(forgedReceipt, { status: 'blocked', reason: 'proposal_not_found' });
    assert.equal(activeCards.length, 0);
    assert.equal((await activeEvents.listSubjectIds()).length, 0);
  });
});
