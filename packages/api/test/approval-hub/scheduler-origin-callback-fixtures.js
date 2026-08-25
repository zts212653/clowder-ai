import assert from 'node:assert/strict';

export const OWNER = 'user-1';
export const CAT = 'opus';

export const load = (path) => import(`../../dist/${path}.js`);
export const socket = () => ({ emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} });

/**
 * The exact row infrastructure/scheduler/delivery.ts persists for a 持球唤醒 wake:
 * authored by the `scheduler` pseudo-user with a null catId, never by the session owner.
 */
export async function appendSchedulerWakeRow(messageStore, threadId) {
  const row = await messageStore.append({
    userId: 'scheduler',
    catId: null,
    content: '[hold-ball] the condition you were waiting on expired',
    mentions: [],
    origin: 'callback',
    timestamp: Date.now(),
    threadId,
    source: { connector: 'scheduler', label: '定时任务', icon: 'scheduler' },
    extra: { scheduler: { hiddenTrigger: true } },
  });
  // Fixture self-check. If this ever drifts back to an owner-authored row, every positive
  // case below keeps passing with the exemption deleted — the file would assert nothing.
  assert.equal(row.userId, 'scheduler', 'the wake row must be scheduler-authored');
  assert.equal(row.catId, null, 'a cat-authored row wearing a system userId must not be the fixture');
  assert.notEqual(row.userId, OWNER, 'owner-authored origins never needed the exemption');
  return row;
}

/**
 * invoke-single-cat.ts passes the turn's trigger id as arg 7 (originTriggerMessageId) and
 * leaves args 4-6 undefined on the scheduler path. Arg 5 is a2aTriggerMessageId: putting the
 * wake id there also compiles, yields an A2A-shaped record, and would test nothing.
 *
 * The record's userId is the OWNER. Only the message row is the scheduler's — that
 * asymmetry between record and row is the entire bug.
 */
export const schedulerWokenAuth = (registry, threadId, wakeMessageId) =>
  registry.create(OWNER, CAT, threadId, undefined, undefined, undefined, wakeMessageId);

export const post = (app, url, auth, payload) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    payload,
  });

export async function assertAnchoredToWakeRow(store, proposalId, threadId, wakeRow) {
  const publication = await store.getPublication(proposalId);
  assert.equal(publication?.state, 'anchored', 'the proposal must reach an anchored publication');
  assert.deepEqual(
    publication.envelope.originRef,
    { kind: 'message', threadId, messageId: wakeRow.id },
    'the published origin must be the scheduler wake row itself, not a substitute',
  );
}
