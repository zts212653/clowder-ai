import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AntigravitySideEffectJournal } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravitySideEffectJournal.js';
import {
  ANTIGRAVITY_SUPERVISOR_KEY_PREFIX,
  InMemoryAntigravitySupervisorStore,
  projectAntigravitySupervisorToInvocationLiveness,
  RedisAntigravitySupervisorStore,
} from '../dist/domains/cats/services/agents/providers/antigravity/AntigravitySupervisorStore.js';
import { classifyAntigravityStepEffect } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-step-effects.js';

class FakeRedis {
  constructor() {
    this.values = new Map();
    this.setCalls = [];
    this.expireCalls = [];
  }

  async set(key, value) {
    this.setCalls.push([key, value]);
    this.values.set(key, value);
    return 'OK';
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async expire(key, seconds) {
    this.expireCalls.push([key, seconds]);
    return 1;
  }
}

function buildJournalSummary(target = '/home/user/id_rsa') {
  const journal = new AntigravitySideEffectJournal({
    threadId: 'thread-1',
    catId: 'antig-opus',
    cascadeId: 'cascade-1',
    invocationId: 'inv-1',
    now: () => 1770000000000,
  });
  const step = {
    type: 'CORTEX_STEP_TYPE_CODE_ACTION',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { operation: 'write', path: target },
  };
  journal.observeStep({ step, stepIndex: 2, effect: classifyAntigravityStepEffect(step) });
  return journal.summary();
}

function buildSupervisorRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    originalInvocationId: 'inv-1',
    threadId: 'thread-1',
    catId: 'antig-opus',
    cascadeId: 'cascade-1',
    status: 'running',
    lastObservedStepCount: 8,
    lastDeliveredStepIndex: 6,
    lastTrajectoryAt: 1770000000100,
    lastLivenessEvidence: {
      kind: 'trajectory_progress',
      observedAt: 1770000000200,
      summary: 'trajectory step count advanced from 6 to 8',
    },
    nativeExecutorEvidence: {
      toolName: 'run_command',
      stepType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      stepIndex: 7,
      status: 'completed',
      observedAt: 1770000000250,
      summary: 'native executor completed run_command step 7',
    },
    journalSummarySnapshot: buildJournalSummary(),
    receiptState: 'clean',
    recoveryStrategy: 'wait',
    resumeAttemptCount: 0,
    createdAt: 1770000000000,
    updatedAt: 1770000000300,
    ...overrides,
  };
}

describe('F201 AntigravitySupervisorStore', () => {
  let auditDir;

  beforeEach(() => {
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-supervisor-store-'));
  });

  afterEach(() => {
    fs.rmSync(auditDir, { recursive: true, force: true });
  });

  test('persists supervisor records with a copied journal summary snapshot', async () => {
    const store = new InMemoryAntigravitySupervisorStore();
    const record = buildSupervisorRecord();

    await store.upsert(record);

    record.journalSummarySnapshot.entries[0].target = 'mutated-after-upsert';
    const found = await store.get('inv-1', 'cascade-1');

    assert.ok(found);
    assert.equal(found.journalSummarySnapshot.entries[0].target, '[REDACTED_TARGET]');
    assert.equal(found.nativeExecutorEvidence.status, 'completed');

    found.journalSummarySnapshot.entries[0].target = 'mutated-after-get';
    const foundAgain = await store.get('inv-1', 'cascade-1');

    assert.equal(foundAgain.journalSummarySnapshot.entries[0].target, '[REDACTED_TARGET]');
  });

  test('redis store writes persistent keys without expire and hydrates records', async () => {
    const redis = new FakeRedis();
    const store = new RedisAntigravitySupervisorStore(redis);
    const record = buildSupervisorRecord({ status: 'probing', recoveryStrategy: 'probe' });

    await store.upsert(record);

    const expectedKey = `${ANTIGRAVITY_SUPERVISOR_KEY_PREFIX}inv-1:cascade-1`;
    assert.equal(redis.setCalls.length, 1);
    assert.equal(redis.setCalls[0][0], expectedKey);
    assert.deepEqual(redis.expireCalls, []);

    const found = await store.get('inv-1', 'cascade-1');
    assert.ok(found);
    assert.equal(found.status, 'probing');
    assert.equal(found.recoveryStrategy, 'probe');
    assert.equal(found.journalSummarySnapshot.entries[0].target, '[REDACTED_TARGET]');
  });

  test('audit append redacts sensitive side-effect targets', async () => {
    const store = new InMemoryAntigravitySupervisorStore({
      auditDir,
      now: () => Date.parse('2026-05-17T10:00:00Z'),
    });
    const record = buildSupervisorRecord();

    await store.appendAudit({ type: 'upsert', record, target: '/home/user/id_rsa' });

    const auditPath = path.join(auditDir, 'supervisor-2026-05-17.jsonl');
    const line = fs.readFileSync(auditPath, 'utf8').trim();
    const auditEntry = JSON.parse(line);

    assert.equal(auditEntry.target, '[REDACTED_TARGET]');
    assert.equal(auditEntry.record.journalSummarySnapshot.entries[0].target, '[REDACTED_TARGET]');
    assert.equal(line.includes('id_rsa'), false);
  });

  test('audit append redacts sensitive target arrays', async () => {
    const store = new InMemoryAntigravitySupervisorStore({
      auditDir,
      now: () => Date.parse('2026-05-17T10:00:00Z'),
    });

    await store.appendAudit({
      type: 'probe',
      target: ['/home/user/id_rsa', '/home/user/id_ed25519'],
    });

    const auditPath = path.join(auditDir, 'supervisor-2026-05-17.jsonl');
    const line = fs.readFileSync(auditPath, 'utf8').trim();
    const auditEntry = JSON.parse(line);

    assert.deepEqual(auditEntry.target, ['[REDACTED_TARGET]', '[REDACTED_TARGET]']);
    assert.equal(line.includes('id_rsa'), false);
    assert.equal(line.includes('id_ed25519'), false);
  });

  test('redis store rejects malformed supervisor payloads', async () => {
    const redis = new FakeRedis();
    const store = new RedisAntigravitySupervisorStore(redis);
    const expectedKey = `${ANTIGRAVITY_SUPERVISOR_KEY_PREFIX}inv-1:cascade-1`;

    redis.values.set(expectedKey, JSON.stringify({ schemaVersion: 1 }));
    assert.equal(await store.get('inv-1', 'cascade-1'), null);

    redis.values.set(expectedKey, JSON.stringify([]));
    assert.equal(await store.get('inv-1', 'cascade-1'), null);

    redis.values.set(
      expectedKey,
      JSON.stringify(
        buildSupervisorRecord({
          nativeExecutorEvidence: {
            toolName: 'run_command',
            stepType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            stepIndex: 1,
            status: 'unknown_status',
            observedAt: 1770000000200,
            summary: 'bad native status',
          },
        }),
      ),
    );
    assert.equal(await store.get('inv-1', 'cascade-1'), null);
  });

  test('liveness projection omits provider-specific side-effect details', () => {
    const record = buildSupervisorRecord({
      status: 'resumable',
      recoveryStrategy: 'manual_card',
      receiptState: 'native_success_trajectory_error',
    });

    const projected = projectAntigravitySupervisorToInvocationLiveness(record);

    assert.deepEqual(projected, {
      provider: 'antigravity',
      originalInvocationId: 'inv-1',
      catId: 'antig-opus',
      threadId: 'thread-1',
      status: 'resumable',
      recoveryStrategy: 'manual_card',
      lastLivenessEvidence: record.lastLivenessEvidence,
      updatedAt: 1770000000300,
    });
    assert.equal('journalSummarySnapshot' in projected, false);
    assert.equal('receiptState' in projected, false);
    assert.equal('cascadeId' in projected, false);
  });
});
