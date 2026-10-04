import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { LiveCarrierOperationGate } from '../src/domains/concierge/live/LiveCarrierOperationGate.ts';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.ts';
import { createA2ADispositionAuth, createA2ADispositionHarness } from './helpers/a2a-dispatch-disposition-harness.js';
import { createLiveDispatchReceiptFixture } from './helpers/f317-live-dispatch-receipt-fixture.mjs';

for (const termination of ['stop', 'fail']) {
  test(`an admitted disposition survives immediate ${termination} before its first microtask`, async () => {
    const sessions = new LiveCompanionSessions();
    const h = await createLiveDispatchReceiptFixture({
      isLiveCarrierInvocation: sessions.isActiveCarrier.bind(sessions),
      withLiveCarrierOperation: sessions.withCarrierOperation.bind(sessions),
    });
    const call = await sessions.prepare({
      binding: { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', callId: 'call' },
      messageStore: h.messageStore,
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      verifyNativeBinding: async () => true,
      publish() {},
    });
    try {
      sessions.claim(call.id, 'user-1', 'thread-1', ['codex-sol']);
      await call.configure({
        CAT_CAFE_API_URL: 'http://localhost:3012',
        CAT_CAFE_USER_ID: 'user-1',
        CAT_CAFE_THREAD_ID: 'thread-1',
        CAT_CAFE_CAT_ID: 'codex-sol',
        CAT_CAFE_INVOCATION_ID: 'inv-1',
        CAT_CAFE_CALLBACK_TOKEN: 'test-secret',
      });
      await call.ready('native', { request: async () => ({}), submitText: async () => 'unused' });
      const auth = createA2ADispositionAuth(h);
      const pending = h.service.completeAdopted(auth, h.source.id, 'completed');
      const stopped = termination === 'stop' ? call.stop() : call.fail(new Error('fixture failure'));
      await assert.rejects(h.service.completeAdopted(auth, h.source.id, 'completed'), /closing|unavailable/);
      const result = await pending;
      await stopped;
      assert.equal(result.outcome, 'applied');
      assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody.handledByCatIds, ['codex-sol']);
      assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
      assert.equal(await sessions.isActiveCarrier(auth), false);
    } finally {
      await sessions.close();
    }
  });
}

for (const scenario of ['wrong-scope', 'stale-invocation', 'missing-read']) {
  test(`admission lease does not authorize ${scenario}`, async () => {
    const gate = new LiveCarrierOperationGate();
    const h = await createA2ADispositionHarness({
      registry: { isLatest: async () => scenario !== 'stale-invocation' },
      isLiveCarrierInvocation: async () => true,
      withLiveCarrierOperation: (query, operation) =>
        gate.runForCarrier(scenario === 'wrong-scope' ? { ...query, threadId: 'foreign' } : query, operation),
      getReadEvidenceForMessage: async () => null,
    });
    await assert.rejects(
      h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed'),
      new RegExp(
        scenario === 'wrong-scope'
          ? 'not_live_carrier'
          : scenario === 'stale-invocation'
            ? 'stale_invocation'
            : 'not_read',
      ),
    );
    assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 0);
  });
}
