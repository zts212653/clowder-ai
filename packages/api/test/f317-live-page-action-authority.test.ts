import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { LivePageActionApprovalLedger } from '../src/domains/concierge/live/host/live-page-action-approval-ledger.js';
import { LivePageActionAuthority } from '../src/domains/concierge/live/host/live-page-action-authority.js';
import { appendUser, fixture, issueFixtureApproval, scope } from './helpers/f317-page-action-fixture.js';

test('Host stages only the current direct owner request and uses its canonical revision', async () => {
  const f = fixture();
  const authorityId = await f.authority.stage({
    requestMessageId: f.source.id,
    approval: f.approval,
    port: f.port,
  });
  assert.match(authorityId, /^[0-9a-f-]{36}$/);
  const result = await f.authority.execute(authorityId, f.selector);
  assert.equal(result.status, 'applied');
  assert.equal(f.effects(), 1);
  assert.equal(f.closed(), true);
  assert.ok(f.approvalChecks() >= 2, 'approval must be re-read beyond staging');
});

test('a newer owner turn or revoked approval cannot commit an old action', async () => {
  for (const change of ['new_request', 'queued_request', 'revoke_approval', 'new_generation'] as const) {
    const f = fixture();
    const authorityId = await f.authority.stage({
      requestMessageId: f.source.id,
      approval: f.approval,
      port: f.port,
    });
    if (change === 'new_request') appendUser(f.store, 'I changed my mind', 'owner-request-2');
    if (change === 'queued_request') {
      const entry = new InvocationQueue().enqueue({
        userId: scope.userId,
        threadId: scope.threadId,
        source: 'user',
        ownerAuthProvenance: 'strict',
        content: 'Wait, do something else first',
        targetCats: [scope.catId],
        intent: 'coordinate',
      }).entry;
      assert.ok(entry);
      f.store.append({
        userId: scope.userId,
        threadId: scope.threadId,
        catId: null,
        content: 'Wait, do something else first',
        mentions: [scope.catId],
        timestamp: Date.now(),
        deliveryStatus: 'queued',
        queueCustody: createInitialQueuedMessageCustody(entry),
      });
    }
    if (change === 'revoke_approval') f.revokeApproval();
    if (change === 'new_generation') f.changeScope();
    const result = await f.authority.execute(authorityId, f.selector);
    assert.notEqual(result.status, 'applied', change);
    assert.equal(f.effects(), 0, change);
    assert.equal(f.closed(), true, change);
  }
});

test('stop releases an unresolved approval read and closes the action port', async () => {
  const f = fixture();
  const authorityId = await f.authority.stage({
    requestMessageId: f.source.id,
    approval: f.approval,
    port: f.port,
  });
  f.onApprovalCheck(async () => new Promise<never>(() => {}));
  const pending = f.authority.execute(authorityId, f.selector);
  setTimeout(() => f.authority.close(), 10);
  const result = await Promise.race([
    pending,
    new Promise<{ status: 'timeout_after_stop' }>((resolve) =>
      setTimeout(() => resolve({ status: 'timeout_after_stop' }), 350),
    ),
  ]);
  assert.equal(result.status, 'cancelled');
  await f.authority.drain();
  assert.equal(f.closed(), true);
  assert.equal(f.effects(), 0);
});

test('a user interruption releases staging while browser inspection is unresolved', async () => {
  const f = fixture();
  f.onInspect(async () => new Promise<never>(() => {}));
  const staging = f.authority.stage({
    requestMessageId: f.source.id,
    approval: f.approval,
    port: f.port,
  });
  setTimeout(() => f.authority.interrupt(), 10);
  const outcome = await Promise.race([
    staging.then(
      () => 'unexpected_grant',
      () => 'interrupted',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout_after_interrupt'), 250)),
  ]);
  assert.equal(outcome, 'interrupted');
  await f.authority.drain();
  assert.equal(f.closed(), true);
});

test('revocation during selection aborts before the browser effect', async () => {
  const f = fixture();
  const authorityId = await f.authority.stage({
    requestMessageId: f.source.id,
    approval: f.approval,
    port: f.port,
  });
  f.selector.select = async () => {
    f.authority.revoke(f.approval.approvalId);
    return { kind: 'act', targetId: 'note', operation: 'fill', value: 'filled' };
  };
  const result = await f.authority.execute(authorityId, f.selector);
  assert.equal(result.status, 'cancelled');
  assert.equal(f.effects(), 0);
  assert.equal(f.closed(), true);
});

test('a competing staged action releases its rejected browser actor', async () => {
  const f = fixture();
  await f.authority.stage({ requestMessageId: f.source.id, approval: f.approval, port: f.port });
  let rejectedActorClosed = false;
  const rejectedPort = {
    ...f.port,
    async close() {
      rejectedActorClosed = true;
    },
  };
  await assert.rejects(
    f.authority.stage({ requestMessageId: f.source.id, approval: f.approval, port: rejectedPort }),
    /unavailable/,
  );
  assert.equal(rejectedActorClosed, true);
  f.authority.close();
  await f.authority.drain();
});

test('one owner approval cannot be replayed as another browser action', async () => {
  const f = fixture();
  const authorityId = await f.authority.stage({ requestMessageId: f.source.id, approval: f.approval, port: f.port });
  assert.equal((await f.authority.execute(authorityId, f.selector)).status, 'applied');
  let replayActorClosed = false;
  await assert.rejects(
    f.authority.stage({
      requestMessageId: f.source.id,
      approval: f.approval,
      port: {
        ...f.port,
        async close() {
          replayActorClosed = true;
        },
      },
    }),
    /unavailable/,
  );
  assert.equal(replayActorClosed, true);
  assert.equal(f.effects(), 1, 'the first applied effect must not be repeated');
});

test('a rebuilt actor fingerprint cannot borrow the prior owner ledger approval', async () => {
  const f = fixture();
  const ledger = new LivePageActionApprovalLedger();
  await issueFixtureApproval(ledger, f);
  let closed = false;
  const actor = {
    ...f.port,
    async inspect() {
      const snapshot = await f.port.inspect();
      const candidate = snapshot.candidates[0];
      assert.ok(candidate);
      return { ...snapshot, candidates: [{ ...candidate, fingerprint: `sha256:${'b'.repeat(64)}` }] };
    },
    async close() {
      closed = true;
    },
  };
  const authority = new LivePageActionAuthority({
    currentScope: () => scope,
    messages: f.store,
    isCurrentThread: async () => true,
    verifyCompanion: async () => true,
    verifyApproval: (input) => ledger.verify(input),
    run: (operation) => operation(),
  });
  await assert.rejects(
    authority.stage({ requestMessageId: f.source.id, approval: f.approval, port: actor }),
    /approval unavailable/,
  );
  assert.equal(closed, true);
  assert.equal(f.effects(), 0);
});

test('a pre-interruption direct request with a future timestamp cannot become fresh authority', async () => {
  const f = fixture(Date.now() + 10_000);
  f.authority.interrupt();
  await assert.rejects(
    f.authority.stage({ requestMessageId: f.source.id, approval: f.approval, port: f.port }),
    /unavailable/,
  );
  assert.equal(f.closed(), true);
  assert.equal(f.effects(), 0);
});

test('owner preview reads only the same canonical direct request as action admission', async () => {
  const f = fixture();
  const preview = await f.authority.inspectRequest(f.source.id);
  assert.equal(preview?.scope.callId, scope.callId);
  assert.equal(preview?.request.sourceRef, `${scope.threadId}#${f.source.id}`);
  assert.equal(preview?.request.text, f.source.content);
  appendUser(f.store, 'I changed my mind', 'owner-request-preview-2');
  assert.equal(await f.authority.inspectRequest(f.source.id), null);
});

test('the Host-generated Live admission source cannot authorize a browser action', async () => {
  const f = fixture();
  const authority = new LivePageActionAuthority({
    currentScope: () => scope,
    messages: f.store,
    isCurrentThread: async () => true,
    verifyCompanion: async () => true,
    verifyApproval: async () => true,
    isHostAdmissionSource: (id) => id === f.source.id,
    run: (operation) => operation(),
  });
  assert.equal(await authority.inspectRequest(f.source.id), null);
});

test('a user interruption revokes the pending owner preview signal before the next direct turn', () => {
  const f = fixture();
  const oldSignal = f.authority.previewSignal();
  f.authority.interrupt();
  assert.equal(oldSignal.aborted, true);
  assert.equal(f.authority.previewSignal().aborted, false);
  f.authority.close();
  assert.equal(f.authority.previewSignal().aborted, true);
});
