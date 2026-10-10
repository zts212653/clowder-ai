/**
 * F194 → F117 KD-23: getThreadLiveInvocations, the liveness read model.
 *
 * A member is processing when its record is running and someone verifiably runs its turn:
 *   - this process's tracker holds its slot for the record's execution   → record+tracker
 *   - the owner snapshot lists a live CLI owner for it                    → record+owner
 * A running child with neither only stands in for its owner while the snapshot cannot tell, because
 * the caller has none or it is incomplete                                 → parent+child-execution, degraded
 * A slot whose execution has no running record yet                        → tracker-only, degraded
 *
 * Nothing reads a draft or a timestamp, and nothing is classified as a zombie.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getThreadLiveInvocations } from '../dist/domains/cats/services/agents/invocation/getThreadLiveInvocations.js';

const THREAD_ID = 'thread-test-1';
const USER_ID = 'user-1';

function makeRecord(overrides = {}) {
  return {
    id: 'inv-1',
    threadId: THREAD_ID,
    userId: USER_ID,
    userMessageId: 'msg-1',
    targetCats: ['opus'],
    intent: 'execute',
    status: 'running',
    idempotencyKey: 'idem-1',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeChild(overrides = {}) {
  return {
    invocationId: 'child-1',
    parentInvocationId: 'inv-1',
    threadId: THREAD_ID,
    userId: USER_ID,
    catId: 'opus',
    executionKind: 'ordinary',
    startedAt: 1_500,
    status: 'running',
    ...overrides,
  };
}

function makeOwner(overrides = {}) {
  return {
    executionId: 'inv-1',
    invocationId: 'child-1',
    threadId: THREAD_ID,
    catId: 'opus',
    userId: USER_ID,
    startedAt: 1_600,
    ...overrides,
  };
}

/** A tracker holding `catId` for `executionId` on behalf of `userId`. */
function slot(catId, executionId, { userId = USER_ID, startedAt = 2_000, activeRun } = {}) {
  return { catId, executionId, userId, startedAt, ...(activeRun ? { activeRun } : {}) };
}

function makeDeps({ records = [], slots = [], children = {}, ownerSnapshot, withChildStore = true } = {}) {
  return {
    listRunningRecords: () => records,
    getActiveSlots: () =>
      slots.map(({ catId, startedAt, activeRun }) => ({ catId, startedAt, ...(activeRun ? { activeRun } : {}) })),
    getTrackerUserId: (_threadId, catId) => slots.find((s) => s.catId === catId)?.userId ?? null,
    getTrackerExecutionId: (_threadId, catId) => slots.find((s) => s.catId === catId)?.executionId,
    ...(withChildStore ? { listTurnExecutionsByParent: (parentId) => children[parentId] ?? [] } : {}),
    ...(ownerSnapshot ? { ownerSnapshot } : {}),
  };
}

function summary(result) {
  return result.active.map(({ catId, executionId, invocationId, source, degraded, reason }) => ({
    catId,
    executionId,
    invocationId,
    source,
    degraded,
    reason,
  }));
}

describe('F117 KD-23 getThreadLiveInvocations — who counts as processing', () => {
  it('a running record whose slot this process holds for that execution is processing', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({ records: [makeRecord()], slots: [slot('opus', 'inv-1')] }),
    );
    assert.deepEqual(summary(result), [
      {
        catId: 'opus',
        executionId: 'inv-1',
        invocationId: 'inv-1',
        source: 'record+tracker',
        degraded: false,
        reason: 'tracker_present',
      },
    ]);
  });

  it('names the child turn, its response R and its own start from the run the tracker slot has bound', async () => {
    const activeRun = { invocationId: 'child-1', responseMessageId: 'response-1', startedAt: 2_500 };
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({ records: [makeRecord()], slots: [slot('opus', 'inv-1', { startedAt: 2_000, activeRun })] }),
    );
    assert.equal(result.active[0].invocationId, 'child-1');
    assert.equal(result.active[0].responseMessageId, 'response-1');
    // A later member of a multi-cat chain: its timer counts its own turn, not the whole chain.
    assert.equal(result.active[0].startedAt, 2_500);
  });

  it("before a run is bound, names the turn and its start from the member's running child", async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord()],
        slots: [slot('opus', 'inv-1', { startedAt: 2_000 })],
        children: { 'inv-1': [makeChild({ invocationId: 'child-bound-soon', startedAt: 2_200 })] },
      }),
    );
    // The slot is the evidence; the child only names the turn while the tracker binds its run.
    assert.deepEqual(
      summary(result).map(({ invocationId, source }) => ({ invocationId, source })),
      [{ invocationId: 'child-bound-soon', source: 'record+tracker' }],
    );
    assert.equal(result.active[0].startedAt, 2_200);
  });

  it('a bound run outranks the durable child for the turn identity', async () => {
    const activeRun = { invocationId: 'child-run', responseMessageId: 'response-run', startedAt: 2_300 };
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord()],
        slots: [slot('opus', 'inv-1', { startedAt: 2_000, activeRun })],
        children: { 'inv-1': [makeChild({ invocationId: 'child-older', startedAt: 2_100 })] },
      }),
    );
    assert.equal(result.active[0].invocationId, 'child-run');
    assert.equal(result.active[0].startedAt, 2_300);
  });

  it('falls back to when the tracker took the slot before a run is bound', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({ records: [makeRecord()], slots: [slot('opus', 'inv-1', { startedAt: 2_000 })] }),
    );
    assert.equal(result.active[0].startedAt, 2_000);
  });

  it('a slot held for another execution does not prove this record processing', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({ records: [makeRecord()], slots: [slot('opus', 'inv-2')] }),
    );
    // The slot's own execution has no running record yet: it is this process's pre-start window.
    assert.deepEqual(
      summary(result).map(({ executionId, source }) => ({ executionId, source })),
      [{ executionId: 'inv-2', source: 'tracker-only' }],
    );
  });

  it('a slot whose execution has no running record yet is processing, degraded (pre-start window)', async () => {
    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, makeDeps({ slots: [slot('opus', 'inv-9')] }));
    assert.deepEqual(summary(result), [
      {
        catId: 'opus',
        executionId: 'inv-9',
        invocationId: 'inv-9',
        source: 'tracker-only',
        degraded: true,
        reason: 'tracker_active_missing_record',
      },
    ]);
  });

  it('a slot whose execution the tracker cannot name is processing, degraded, and names no execution', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord()],
        slots: [slot('opus', undefined)],
        ownerSnapshot: { complete: true, owners: [] },
      }),
    );
    assert.deepEqual(summary(result), [
      {
        catId: 'opus',
        executionId: undefined,
        invocationId: undefined,
        source: 'tracker-only',
        degraded: true,
        reason: 'tracker_active_missing_record',
      },
    ]);
  });

  it('a record that is not running is never listed, whatever else points at it', async () => {
    for (const status of ['queued', 'succeeded', 'failed', 'canceled']) {
      const result = await getThreadLiveInvocations(
        THREAD_ID,
        USER_ID,
        makeDeps({
          records: [makeRecord({ status })],
          children: { 'inv-1': [makeChild()] },
          ownerSnapshot: { complete: true, owners: [makeOwner()] },
        }),
      );
      assert.deepEqual(result.active, [], `status ${status}`);
    }
  });
});

describe('F117 KD-23 getThreadLiveInvocations — a running child is not an owner', () => {
  it('with a complete snapshot, a live owner proves the member processing', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord()],
        children: { 'inv-1': [makeChild()] },
        ownerSnapshot: { complete: true, owners: [makeOwner()] },
      }),
    );
    assert.deepEqual(summary(result), [
      {
        catId: 'opus',
        executionId: 'inv-1',
        invocationId: 'child-1',
        source: 'record+owner',
        degraded: false,
        reason: 'cli_owner_alive',
      },
    ]);
  });

  it('with a complete snapshot and no owner, a running child without a slot proves nothing', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord()],
        children: { 'inv-1': [makeChild()] },
        ownerSnapshot: { complete: true, owners: [] },
      }),
    );
    assert.deepEqual(result.active, []);
  });

  it('with an incomplete snapshot, a running child stands in for its unverified owner, degraded', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord()],
        children: { 'inv-1': [makeChild()] },
        ownerSnapshot: { complete: false, owners: [] },
      }),
    );
    assert.deepEqual(summary(result), [
      {
        catId: 'opus',
        executionId: 'inv-1',
        invocationId: 'child-1',
        source: 'parent+child-execution',
        degraded: true,
        reason: 'child_running_owner_unverified',
      },
    ]);
  });

  it('without a snapshot, a running child stands in for its unverified owner, degraded', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({ records: [makeRecord()], children: { 'inv-1': [makeChild()] } }),
    );
    assert.deepEqual(
      summary(result).map(({ source, degraded }) => ({ source, degraded })),
      [{ source: 'parent+child-execution', degraded: true }],
    );
  });

  it('an owner an incomplete snapshot does list is still verified, and its child is not listed twice', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord()],
        children: { 'inv-1': [makeChild()] },
        ownerSnapshot: { complete: false, owners: [makeOwner()] },
      }),
    );
    assert.deepEqual(
      summary(result).map(({ source, degraded }) => ({ source, degraded })),
      [{ source: 'record+owner', degraded: false }],
    );
  });

  it('with an incomplete snapshot, a running record nothing else lists stays listed through its members', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord({ targetCats: ['opus', 'codex'], updatedAt: 1_200 })],
        ownerSnapshot: { complete: false, owners: [] },
      }),
    );
    assert.deepEqual(
      result.active.map(({ catId, executionId, invocationId, startedAt, source, degraded, reason }) => ({
        catId,
        executionId,
        invocationId,
        startedAt,
        source,
        degraded,
        reason,
      })),
      ['opus', 'codex'].map((catId) => ({
        catId,
        executionId: 'inv-1',
        invocationId: 'inv-1',
        startedAt: 1_200,
        source: 'record-only',
        degraded: true,
        reason: 'record_running_owner_unverified',
      })),
    );
  });

  it('without a snapshot, or with a complete one, a running record with no slot, owner or child is not processing', async () => {
    for (const ownerSnapshot of [undefined, { complete: true, owners: [] }]) {
      const result = await getThreadLiveInvocations(
        THREAD_ID,
        USER_ID,
        makeDeps({ records: [makeRecord()], ownerSnapshot }),
      );
      assert.deepEqual(result.active, [], JSON.stringify(ownerSnapshot));
    }
  });

  it('with an incomplete snapshot, a record something already lists does not add its other members', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord({ targetCats: ['opus', 'codex'] })],
        slots: [slot('opus', 'inv-1')],
        ownerSnapshot: { complete: false, owners: [] },
      }),
    );
    assert.deepEqual(
      summary(result).map(({ catId, source }) => ({ catId, source })),
      [{ catId: 'opus', source: 'record+tracker' }],
    );
  });

  it('a slot this process holds needs no snapshot, and hides nothing behind it', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord()],
        slots: [slot('opus', 'inv-1')],
        children: { 'inv-1': [makeChild()] },
        ownerSnapshot: { complete: false, owners: [makeOwner()] },
      }),
    );
    assert.deepEqual(
      summary(result).map(({ source }) => source),
      ['record+tracker'],
    );
  });

  it('lists the newest running child per member, and each member of the execution separately', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord({ targetCats: ['opus', 'codex'] })],
        children: {
          'inv-1': [
            makeChild({ invocationId: 'child-old', startedAt: 1_100 }),
            makeChild({ invocationId: 'child-new', startedAt: 1_900 }),
            makeChild({ invocationId: 'child-codex', catId: 'codex', startedAt: 1_200 }),
            makeChild({ invocationId: 'child-done', catId: 'codex', startedAt: 1_950, status: 'succeeded' }),
          ],
        },
      }),
    );
    assert.deepEqual(
      summary(result)
        .map(({ catId, invocationId }) => ({ catId, invocationId }))
        .sort((a, b) => a.catId.localeCompare(b.catId)),
      [
        { catId: 'codex', invocationId: 'child-codex' },
        { catId: 'opus', invocationId: 'child-new' },
      ],
    );
  });
});

describe('F117 KD-23 getThreadLiveInvocations — scope guards', () => {
  it('ignores records of another user or another thread', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [
          makeRecord({ id: 'other-user', userId: 'user-2' }),
          makeRecord({ id: 'other-thread', threadId: 'thread-2' }),
        ],
        slots: [slot('opus', 'other-user')],
      }),
    );
    // The slot names an execution that is not a running record of this scope: at most a pre-start window.
    assert.deepEqual(
      summary(result).map(({ executionId, source }) => ({ executionId, source })),
      [{ executionId: 'other-user', source: 'tracker-only' }],
    );
  });

  it('does not count a tracker slot owned by another user (cross-user collision)', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({ records: [makeRecord()], slots: [slot('opus', 'inv-1', { userId: 'user-2' })] }),
    );
    assert.deepEqual(result.active, []);
  });

  it('ignores owners of another execution, user or thread', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord()],
        ownerSnapshot: {
          complete: true,
          owners: [
            makeOwner({ executionId: 'inv-2' }),
            makeOwner({ userId: 'user-2' }),
            makeOwner({ threadId: 'thread-2' }),
          ],
        },
      }),
    );
    assert.deepEqual(result.active, []);
  });

  it('ignores children of another parent, user or thread', async () => {
    const result = await getThreadLiveInvocations(
      THREAD_ID,
      USER_ID,
      makeDeps({
        records: [makeRecord()],
        children: {
          'inv-1': [
            makeChild({ parentInvocationId: 'inv-2' }),
            makeChild({ userId: 'user-2' }),
            makeChild({ threadId: 'thread-2' }),
          ],
        },
      }),
    );
    assert.deepEqual(result.active, []);
  });

  it('lets a failing child store propagate: unknown must not read as "no running child"', async () => {
    const deps = {
      ...makeDeps({ records: [makeRecord()] }),
      listTurnExecutionsByParent: () => {
        throw new Error('turn execution store unavailable');
      },
    };
    await assert.rejects(getThreadLiveInvocations(THREAD_ID, USER_ID, deps), /turn execution store unavailable/);
  });

  it('does not mutate its inputs', async () => {
    const records = [makeRecord()];
    const children = { 'inv-1': [makeChild()] };
    const ownerSnapshot = { complete: true, owners: [makeOwner()] };
    const before = JSON.stringify({ records, children, ownerSnapshot });
    await getThreadLiveInvocations(THREAD_ID, USER_ID, makeDeps({ records, children, ownerSnapshot }));
    assert.equal(JSON.stringify({ records, children, ownerSnapshot }), before);
  });
});
