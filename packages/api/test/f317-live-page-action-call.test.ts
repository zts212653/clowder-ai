import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';
import type { LiveCompanionCallOptions } from '../src/domains/concierge/live/live-call-options.js';
import { fixture, issueFixtureApproval, scope, startedActionCall } from './helpers/f317-page-action-fixture.js';

test('the ordinary Live call has no page-action entry without an owner approval source', async () => {
  const f = fixture();
  const call = await LiveCompanionCall.create({
    binding: { userId: scope.userId, threadId: scope.threadId, catId: scope.catId, callId: 'no-page-action' },
    messageStore: f.store,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    publish() {},
  });
  let closed = false;
  try {
    await assert.rejects(
      call.boundaryContexts.runPageAction({
        requestMessageId: f.source.id,
        approval: f.approval,
        port: {
          ...f.port,
          async close() {
            closed = true;
          },
        },
        selector: f.selector,
      }),
      /unavailable/,
    );
    assert.equal(closed, true);
    assert.equal(f.effects(), 0);
  } finally {
    await call.stop();
  }
});

test('a caller-supplied true verifier cannot install page actions without an independent ledger', async () => {
  const f = fixture();
  const forged = {
    messages: f.store,
    isCurrentThread: async () => true,
    verifyApproval: async () => true,
  } as unknown as NonNullable<LiveCompanionCallOptions['pageAction']>;
  const call = await LiveCompanionCall.create({
    binding: { userId: scope.userId, threadId: scope.threadId, catId: scope.catId, callId: 'forged-approval' },
    messageStore: f.store,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    pageAction: forged,
    verifyNativeBinding: async () => true,
    publish() {},
  });
  try {
    await assert.rejects(
      call.configure({
        CAT_CAFE_API_URL: 'http://localhost:3012',
        CAT_CAFE_USER_ID: scope.userId,
        CAT_CAFE_THREAD_ID: scope.threadId,
        CAT_CAFE_CAT_ID: scope.catId,
        CAT_CAFE_INVOCATION_ID: scope.invocationId,
        CAT_CAFE_CALLBACK_TOKEN: 'token',
      }),
      /approval ledger unavailable/,
    );
  } finally {
    await call.stop();
  }
});

test('Live Host owns page-action interruption on exact native user speech and stop', async () => {
  const f = fixture();
  const { call, approvalLedger } = await startedActionCall(f);
  try {
    let started: (() => void) | undefined;
    const selecting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const selector = {
      async select() {
        started?.();
        return new Promise<never>(() => {});
      },
    };
    const action = call.boundaryContexts.runPageAction({
      requestMessageId: f.source.id,
      approval: f.approval,
      port: f.port,
      selector,
    });
    await selecting;
    await call.observe({
      method: 'thread/realtime/transcript/delta',
      params: { threadId: 'foreign', role: 'user', delta: 'not this call' },
    });
    assert.equal(f.closed(), false, 'foreign native speech cannot revoke this call');
    await call.observe({
      method: 'thread/realtime/transcript/delta',
      params: { threadId: 'native', role: 'user', delta: 'wait, change the request' },
    });
    const result = await Promise.race([
      action,
      new Promise<{ status: 'timeout_after_speech' }>((resolve) =>
        setTimeout(() => resolve({ status: 'timeout_after_speech' }), 350),
      ),
    ]);
    assert.equal(result.status, 'cancelled');
    assert.equal(f.effects(), 0);
    assert.equal(f.closed(), true);
    let deniedPortClosed = false;
    await assert.rejects(
      call.boundaryContexts.runPageAction({
        requestMessageId: f.source.id,
        approval: f.approval,
        port: {
          ...f.port,
          async close() {
            deniedPortClosed = true;
          },
        },
        selector,
      }),
      /unavailable/,
    );
    assert.equal(deniedPortClosed, true, 'speech keeps the action entry closed');
    await call.observe({ method: 'thread/realtime/transcript/done', params: { threadId: 'native', role: 'user' } });
    let stalePortClosed = false;
    await assert.rejects(
      call.boundaryContexts.runPageAction({
        requestMessageId: f.source.id,
        approval: f.approval,
        port: {
          ...f.port,
          async close() {
            stalePortClosed = true;
          },
        },
        selector: f.selector,
      }),
      /request|unavailable/i,
    );
    assert.equal(stalePortClosed, true, 'the old direct request stays revoked after speech ends');
    const freshDelivery = await call.sendText('Fill the revised approved note', 'owner-request-after-speech');
    assert.equal(freshDelivery.delivery, 'accepted');
    const freshRequest = f.store.getById(freshDelivery.messageId);
    assert.ok(freshRequest);
    const freshApproval = { ...f.approval, approvalId: 'owner-confirmation-after-speech' };
    await issueFixtureApproval(approvalLedger, f, freshRequest, freshApproval);
    let secondActorClosed = false;
    let secondStarted: (() => void) | undefined;
    const selectingAgain = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const secondAction = call.boundaryContexts.runPageAction({
      requestMessageId: freshRequest.id,
      approval: freshApproval,
      port: {
        ...f.port,
        async close() {
          secondActorClosed = true;
        },
      },
      selector: {
        async select() {
          secondStarted?.();
          return new Promise<never>(() => {});
        },
      },
    });
    await selectingAgain;
    await call.stop();
    const stopped = await Promise.race([
      secondAction,
      new Promise<{ status: 'timeout_after_stop' }>((resolve) =>
        setTimeout(() => resolve({ status: 'timeout_after_stop' }), 350),
      ),
    ]);
    assert.equal(stopped.status, 'cancelled');
    assert.equal(secondActorClosed, true);
    assert.equal(f.effects(), 0);
  } finally {
    await call.stop();
  }
});

test('Live transport failure aborts a pending page action before carrier drain', async () => {
  const f = fixture();
  const { call } = await startedActionCall(f);
  void call.finished.catch(() => {});
  let selecting: (() => void) | undefined;
  const selectionStarted = new Promise<void>((resolve) => {
    selecting = resolve;
  });
  try {
    const action = call.boundaryContexts.runPageAction({
      requestMessageId: f.source.id,
      approval: f.approval,
      port: f.port,
      selector: {
        async select() {
          selecting?.();
          return new Promise<never>(() => {});
        },
      },
    });
    await selectionStarted;
    await Promise.race([
      call.fail(new Error('transport_failed')),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('drain_timeout')), 350)),
    ]);
    assert.equal((await action).status, 'cancelled');
    assert.equal(f.closed(), true);
    assert.equal(f.effects(), 0);
    assert.equal(call.status().state, 'failed');
  } finally {
    await call.stop();
  }
});

test('revoking the independent ledger aborts a suspended model selection immediately', async () => {
  const f = fixture();
  const { call, approvalLedger } = await startedActionCall(f);
  let selecting: (() => void) | undefined;
  const selectionStarted = new Promise<void>((resolve) => {
    selecting = resolve;
  });
  try {
    const action = call.boundaryContexts.runPageAction({
      requestMessageId: f.source.id,
      approval: f.approval,
      port: f.port,
      selector: {
        async select() {
          selecting?.();
          return new Promise<never>(() => {});
        },
      },
    });
    await selectionStarted;
    approvalLedger.revoke(f.approval.approvalId);
    const result = await Promise.race([
      action,
      new Promise<{ status: 'timeout_after_revoke' }>((resolve) =>
        setTimeout(() => resolve({ status: 'timeout_after_revoke' }), 250),
      ),
    ]);
    assert.equal(result.status, 'cancelled');
    assert.equal(f.closed(), true);
    assert.equal(f.effects(), 0);
  } finally {
    await call.stop();
  }
});

test('same-millisecond new Live text may authorize its own action after the old request is cut off', async (t) => {
  const f = fixture();
  const { call, approvalLedger } = await startedActionCall(f);
  const sameMillisecond = Date.now();
  t.mock.method(Date, 'now', () => sameMillisecond);
  try {
    const delivery = await call.sendText('Fill the newly approved note', 'same-millisecond-new-request');
    assert.equal(delivery.delivery, 'accepted');
    const source = f.store.getById(delivery.messageId);
    assert.ok(source);
    assert.equal(source.timestamp, sameMillisecond);
    const approval = { ...f.approval, approvalId: 'owner-confirmation-new-text' };
    await issueFixtureApproval(approvalLedger, f, source, approval);
    const result = await call.boundaryContexts.runPageAction({
      requestMessageId: source.id,
      approval,
      port: f.port,
      selector: f.selector,
    });
    assert.equal(result.status, 'applied');
    assert.equal(f.effects(), 1);
  } finally {
    await call.stop();
  }
});

test('idempotent same-millisecond text replay does not mint a new action source', async (t) => {
  const f = fixture();
  const { call, approvalLedger } = await startedActionCall(f);
  const sameMillisecond = Date.now();
  t.mock.method(Date, 'now', () => sameMillisecond);
  try {
    const first = await call.sendText('Original text', 'same-message');
    const replay = await call.sendText('Original text', 'same-message');
    assert.equal(replay.messageId, first.messageId);
    const source = f.store.getById(first.messageId);
    assert.ok(source);
    const approval = { ...f.approval, approvalId: 'owner-confirmation-replayed-text' };
    await issueFixtureApproval(approvalLedger, f, source, approval);
    let closed = false;
    await assert.rejects(
      call.boundaryContexts.runPageAction({
        requestMessageId: source.id,
        approval,
        port: {
          ...f.port,
          async close() {
            closed = true;
          },
        },
        selector: f.selector,
      }),
      /unavailable/,
    );
    assert.equal(closed, true);
    assert.equal(f.effects(), 0);
  } finally {
    await call.stop();
  }
});
