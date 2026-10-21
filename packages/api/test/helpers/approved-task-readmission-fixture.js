import assert from 'node:assert/strict';
import { approvedTaskFixture, OWNER, TARGET, USER } from './approved-task-contract-fixture.js';

export async function runningFixture(t) {
  const f = await approvedTaskFixture(t);
  assert.equal((await f.continueTask()).statusCode, 200);
  assert.equal((await f.implement()).statusCode, 200);
  return { ...f, lease: (await f.leases.listActiveTaskLeases())[0] };
}

// Inject at the actual Redis commit, both before and after the WATCH-based fix.
export function revokeAtCommit(f, field = 'title', value = 'Different work at commit') {
  let changed = false;
  const revoke = async () => {
    if (changed) return;
    changed = true;
    await f.redis.hset(`task:${f.task.id}`, field, value);
  };
  const evaluate = f.redis.eval.bind(f.redis);
  f.redis.eval = async (script, ...args) => {
    if (script.includes('tonumber(current.revision)') || script.includes('local candidateDetailKey')) await revoke();
    return evaluate(script, ...args);
  };
  const duplicate = f.redis.duplicate.bind(f.redis);
  f.redis.duplicate = (...args) => {
    const session = duplicate(...args);
    const multi = session.multi.bind(session);
    session.multi = (...multiArgs) => {
      const transaction = multi(...multiArgs);
      const exec = transaction.exec.bind(transaction);
      transaction.exec = async (...execArgs) => {
        await revoke();
        return exec(...execArgs);
      };
      return transaction;
    };
    return session;
  };
  return () => assert.equal(changed, true, 'the race must hit the real commit');
}

export function replacementInput(f, lease = f.lease) {
  return {
    expectedGeneration: lease.generation,
    holderCatIds: [TARGET],
    holderThreadId: f.childId,
    predecessorCatId: OWNER,
    predecessorThreadId: f.source.id,
    dispatchId: 'cross-post:replacement',
    terminalPredicate: lease.terminalPredicate,
    evidenceRef: 'callback:replacement',
    now: Date.now(),
  };
}

export function refreshInput(lease) {
  return {
    expectedGeneration: lease.generation,
    expectedRevision: lease.revision,
    predecessorCatId: lease.predecessorCatId,
    predecessorThreadId: lease.predecessorThreadId,
    holderCatIds: lease.holderCatIds,
    holderThreadId: lease.holderThreadId,
    mode: lease.mode,
    terminalPredicateDigest: lease.terminalPredicate.digest,
    dispatchId: `${lease.dispatchId.split(':')[0]}:refreshed`,
    evidenceRef: 'callback:refreshed',
    now: Date.now(),
  };
}

export async function returnToOwner(f) {
  const returned = await f.leases.returnToPredecessor(f.lease.leaseId, {
    expectedGeneration: f.lease.generation,
    rejectingCatId: TARGET,
    rejectingThreadId: f.childId,
    dispatchId: 'return:original-owner',
    groundingEvidenceRef: 'grounding:return',
    now: Date.now(),
  });
  assert.equal(returned.outcome, 'returned');
  const delivered = await f.leases.markReturnDelivered(returned.lease.leaseId, {
    expectedGeneration: returned.lease.generation,
    evidenceRef: 'queue:return:delivered',
    now: Date.now(),
  });
  assert.equal(delivered.outcome, 'delivered');
  return delivered.lease;
}

export async function assertUnchanged(f, before) {
  assert.deepEqual(await f.leases.get(before.leaseId), before);
  assert.equal((await f.queue.listAllDurable(f.childId)).length, 1);
  assert.equal((await f.messages.getByThreadAfter(f.childId, undefined, undefined, USER)).length, 3);
}
