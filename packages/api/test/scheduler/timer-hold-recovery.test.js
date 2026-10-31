import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import {
  classifyTimerHoldRecovery,
  persistTimerHoldDisposition,
} from '../../dist/infrastructure/scheduler/timer-hold-recovery.js';

const ID = 'hold-ball-task-1';
const WAKE_AT = 1_700_000_000_000;
const SLA_UNTIL = WAKE_AT + 3_600_000;

const makeLifecycle = (overrides = {}) => ({
  mode: 'timer',
  status: 'active',
  wakeAt: WAKE_AT,
  waitSourceRef: { slaUntilMs: SLA_UNTIL },
  await: {
    subjectRef: `timer:${ID}`,
    generation: 1,
    expiresAt: SLA_UNTIL,
    baseline: { kind: 'timer', fireAt: WAKE_AT },
    continuation: { when: [{ kind: 'timer_elapsed' }] },
  },
  ...overrides,
});

const makeDef = (overrides = {}) => ({
  id: ID,
  templateId: 'reminder',
  trigger: { type: 'once', fireAt: WAKE_AT },
  params: { message: 'wake', holdLifecycle: makeLifecycle() },
  display: { label: 'timer hold', category: 'system' },
  deliveryThreadId: null,
  enabled: true,
  createdBy: 'hold-ball:cat-1',
  createdAt: new Date(WAKE_AT - 60_000).toISOString(),
  ...overrides,
});

describe('classifyTimerHoldRecovery — not_timer_hold', () => {
  it('returns not_timer_hold when id lacks the hold-ball- prefix', () => {
    const result = classifyTimerHoldRecovery(makeDef({ id: 'other-task-1' }), 'strict');
    assert.deepEqual(result, { kind: 'not_timer_hold' });
  });

  it('returns not_timer_hold when templateId is not reminder', () => {
    const result = classifyTimerHoldRecovery(makeDef({ templateId: 'repo-activity' }), 'strict');
    assert.deepEqual(result, { kind: 'not_timer_hold' });
  });

  it('returns not_timer_hold when createdBy lacks the hold-ball: prefix', () => {
    const result = classifyTimerHoldRecovery(makeDef({ createdBy: 'cat-1' }), 'strict');
    assert.deepEqual(result, { kind: 'not_timer_hold' });
  });

  it('returns not_timer_hold when lifecycle.mode is not timer', () => {
    const def = makeDef();
    def.params.holdLifecycle = makeLifecycle({ mode: 'managed_command' });
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'not_timer_hold' });
  });
});

describe('classifyTimerHoldRecovery — inactive', () => {
  it('returns inactive with the stored status when lifecycle is retired', () => {
    const def = makeDef();
    def.params.holdLifecycle = makeLifecycle({ status: 'retired_expired' });
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'inactive', status: 'retired_expired' });
  });

  it('returns inactive with unknown when status is not a string', () => {
    const def = makeDef();
    def.params.holdLifecycle = makeLifecycle({ status: 42 });
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'inactive', status: 'unknown' });
  });

  it('returns inactive with unknown when status is missing', () => {
    const def = makeDef();
    delete def.params.holdLifecycle.status;
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'inactive', status: 'unknown' });
  });
});

describe('classifyTimerHoldRecovery — invalid branches', () => {
  it('returns owner_auth_unknown when owner provenance is unknown', () => {
    const result = classifyTimerHoldRecovery(makeDef(), 'unknown');
    assert.deepEqual(result, { kind: 'invalid', reason: 'owner_auth_unknown' });
  });

  it('returns trigger_not_once when the trigger is not a once trigger', () => {
    const def = makeDef({ trigger: { type: 'interval', ms: 60000 } });
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'trigger_not_once' });
  });

  it('returns timer_wait_identity_mismatch when wakeAt is not a number', () => {
    const def = makeDef();
    def.params.holdLifecycle.wakeAt = 'soon';
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when trigger.fireAt is earlier than wakeAt', () => {
    const def = makeDef({ trigger: { type: 'once', fireAt: WAKE_AT - 1 } });
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when slaUntilMs is not a number', () => {
    const def = makeDef();
    def.params.holdLifecycle.waitSourceRef = { slaUntilMs: 'later' };
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when slaUntilMs is not finite', () => {
    const def = makeDef();
    def.params.holdLifecycle.waitSourceRef = { slaUntilMs: Infinity };
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when subjectRef does not match timer:<def.id>', () => {
    const def = makeDef();
    def.params.holdLifecycle.await.subjectRef = 'timer:other-task';
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when generation is not 1', () => {
    const def = makeDef();
    def.params.holdLifecycle.await.generation = 2;
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when autoRenew is defined and not false', () => {
    const def = makeDef();
    def.params.holdLifecycle.await.autoRenew = true;
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('accepts autoRenew explicitly set to false', () => {
    const def = makeDef();
    def.params.holdLifecycle.await.autoRenew = false;
    const result = classifyTimerHoldRecovery(def, 'strict', WAKE_AT);
    assert.deepEqual(result, { kind: 'recover', retryUntil: SLA_UNTIL, scheduledAt: WAKE_AT });
  });

  it('accepts legacy awaits where autoRenew is undefined', () => {
    const result = classifyTimerHoldRecovery(makeDef(), 'strict', WAKE_AT);
    assert.deepEqual(result, { kind: 'recover', retryUntil: SLA_UNTIL, scheduledAt: WAKE_AT });
  });

  it('returns timer_wait_identity_mismatch when expiresAt differs from slaUntilMs', () => {
    const def = makeDef();
    def.params.holdLifecycle.await.expiresAt = SLA_UNTIL + 1;
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when baseline.kind is not timer', () => {
    const def = makeDef();
    def.params.holdLifecycle.await.baseline = { kind: 'manual', fireAt: WAKE_AT };
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when baseline.fireAt differs from wakeAt', () => {
    const def = makeDef();
    def.params.holdLifecycle.await.baseline = { kind: 'timer', fireAt: WAKE_AT + 1 };
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when there are no continuation predicates', () => {
    const def = makeDef();
    def.params.holdLifecycle.await.continuation = { when: [] };
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when there are multiple continuation predicates', () => {
    const def = makeDef();
    def.params.holdLifecycle.await.continuation = {
      when: [{ kind: 'timer_elapsed' }, { kind: 'timer_elapsed' }],
    };
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });

  it('returns timer_wait_identity_mismatch when the predicate kind is not timer_elapsed', () => {
    const def = makeDef();
    def.params.holdLifecycle.await.continuation = { when: [{ kind: 'issue_comment_added' }] };
    const result = classifyTimerHoldRecovery(def, 'strict');
    assert.deepEqual(result, { kind: 'invalid', reason: 'timer_wait_identity_mismatch' });
  });
});

describe('classifyTimerHoldRecovery — expired boundary', () => {
  it('returns expired when now is past slaUntilMs', () => {
    const result = classifyTimerHoldRecovery(makeDef(), 'strict', SLA_UNTIL + 1);
    assert.deepEqual(result, { kind: 'expired', slaUntilMs: SLA_UNTIL });
  });

  it('returns recover when now equals slaUntilMs', () => {
    const result = classifyTimerHoldRecovery(makeDef(), 'strict', SLA_UNTIL);
    assert.deepEqual(result, { kind: 'recover', retryUntil: SLA_UNTIL, scheduledAt: WAKE_AT });
  });

  it('returns recover with retryUntil=slaUntilMs and scheduledAt=wakeAt when now is before slaUntilMs', () => {
    const result = classifyTimerHoldRecovery(makeDef(), 'strict', SLA_UNTIL - 1000);
    assert.deepEqual(result, { kind: 'recover', retryUntil: SLA_UNTIL, scheduledAt: WAKE_AT });
  });
});

describe('persistTimerHoldDisposition', () => {
  const makeStore = () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    return { db, store: new DynamicTaskStore(db) };
  };

  it('persists fired disposition with scheduledAt, latenessMs and disables the task', () => {
    const { db, store } = makeStore();
    const def = makeDef();
    store.insert(def);
    const firedAt = WAKE_AT + 5000;

    const ok = persistTimerHoldDisposition(store, def, { status: 'fired', at: firedAt });

    assert.equal(ok, true);
    const stored = store.getById(ID);
    assert.equal(stored.enabled, false);
    const lifecycle = stored.params.holdLifecycle;
    assert.equal(lifecycle.status, 'fired');
    assert.equal(lifecycle.firedAt, firedAt);
    assert.equal(lifecycle.scheduledAt, WAKE_AT);
    assert.equal(lifecycle.latenessMs, 5000);
    assert.equal(stored.params.message, 'wake');
    db.close();
  });

  it('clamps latenessMs to 0 when the fire happens before wakeAt', () => {
    const { db, store } = makeStore();
    const def = makeDef();
    store.insert(def);

    const ok = persistTimerHoldDisposition(store, def, { status: 'fired', at: WAKE_AT - 10 });

    assert.equal(ok, true);
    const lifecycle = store.getById(ID).params.holdLifecycle;
    assert.equal(lifecycle.status, 'fired');
    assert.equal(lifecycle.latenessMs, 0);
    db.close();
  });

  it('falls back to input.at as scheduledAt when wakeAt is missing', () => {
    const { db, store } = makeStore();
    const def = makeDef();
    delete def.params.holdLifecycle.wakeAt;
    store.insert(def);
    const firedAt = WAKE_AT + 1000;

    const ok = persistTimerHoldDisposition(store, def, { status: 'fired', at: firedAt });

    assert.equal(ok, true);
    const lifecycle = store.getById(ID).params.holdLifecycle;
    assert.equal(lifecycle.scheduledAt, firedAt);
    assert.equal(lifecycle.latenessMs, 0);
    db.close();
  });

  it('persists retired_expired with retiredAt and dispositionReason, and disables the task', () => {
    const { db, store } = makeStore();
    const def = makeDef();
    store.insert(def);
    const retiredAt = SLA_UNTIL + 100;

    const ok = persistTimerHoldDisposition(store, def, {
      status: 'retired_expired',
      at: retiredAt,
      reason: 'sla_elapsed',
    });

    assert.equal(ok, true);
    const stored = store.getById(ID);
    assert.equal(stored.enabled, false);
    const lifecycle = stored.params.holdLifecycle;
    assert.equal(lifecycle.status, 'retired_expired');
    assert.equal(lifecycle.retiredAt, retiredAt);
    assert.equal(lifecycle.dispositionReason, 'sla_elapsed');
    db.close();
  });

  it('persists retired_invalid with dispositionReason', () => {
    const { db, store } = makeStore();
    const def = makeDef();
    store.insert(def);

    const ok = persistTimerHoldDisposition(store, def, {
      status: 'retired_invalid',
      at: WAKE_AT + 100,
      reason: 'timer_wait_identity_mismatch',
    });

    assert.equal(ok, true);
    const lifecycle = store.getById(ID).params.holdLifecycle;
    assert.equal(lifecycle.status, 'retired_invalid');
    assert.equal(lifecycle.retiredAt, WAKE_AT + 100);
    assert.equal(lifecycle.dispositionReason, 'timer_wait_identity_mismatch');
    db.close();
  });

  it('omits dispositionReason when no reason is given', () => {
    const { db, store } = makeStore();
    const def = makeDef();
    store.insert(def);

    const ok = persistTimerHoldDisposition(store, def, {
      status: 'retired_expired',
      at: SLA_UNTIL + 100,
    });

    assert.equal(ok, true);
    const lifecycle = store.getById(ID).params.holdLifecycle;
    assert.equal(lifecycle.status, 'retired_expired');
    assert.equal('dispositionReason' in lifecycle, false);
    db.close();
  });

  it('returns false and writes nothing when the stored params no longer match the caller copy', () => {
    const { db, store } = makeStore();
    const def = makeDef();
    store.insert(def);
    const stale = makeDef();
    stale.params.holdLifecycle = makeLifecycle({ wakeAt: WAKE_AT + 999 });

    const ok = persistTimerHoldDisposition(store, stale, { status: 'fired', at: WAKE_AT + 5000 });

    assert.equal(ok, false);
    const stored = store.getById(ID);
    assert.equal(stored.enabled, true);
    assert.equal(stored.params.holdLifecycle.status, 'active');
    assert.equal('firedAt' in stored.params.holdLifecycle, false);
    db.close();
  });

  it('returns false when the def has no holdLifecycle params', () => {
    const { db, store } = makeStore();
    const def = makeDef();
    store.insert(def);
    const bare = makeDef();
    delete bare.params.holdLifecycle;

    const ok = persistTimerHoldDisposition(store, bare, { status: 'fired', at: WAKE_AT });

    assert.equal(ok, false);
    const stored = store.getById(ID);
    assert.equal(stored.enabled, true);
    assert.equal(stored.params.holdLifecycle.status, 'active');
    db.close();
  });
});
