import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import type { LiveCarrierOperationLease } from '../src/domains/concierge/live/LiveCarrierOperationGate.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';

for (const termination of ['stop', 'fail'])
  test(`the Live ${termination} fence drains only a claimed, native-bound active Host invocation`, async () => {
    const sessions = new LiveCompanionSessions();
    const query = { invocationId: 'invocation', threadId: 'home', catId: 'codex-astra' };
    assert.equal(await sessions.isActiveCarrier(query), false);
    const call = await sessions.prepare({
      binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'call' },
      messageStore: new MessageStore(),
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      verifyNativeBinding: async () => true,
      publish() {},
    });
    try {
      sessions.claim(call.id, 'owner', 'home', ['codex-astra']);
      await call.configure({
        CAT_CAFE_API_URL: 'http://localhost:3012',
        CAT_CAFE_USER_ID: 'owner',
        CAT_CAFE_THREAD_ID: 'home',
        CAT_CAFE_CAT_ID: 'codex-astra',
        CAT_CAFE_INVOCATION_ID: 'invocation',
        CAT_CAFE_CALLBACK_TOKEN: 'secret',
      });
      assert.equal(
        await sessions.isActiveCarrier(query),
        false,
        'prepared credentials alone do not establish a native binding',
      );
      await call.ready('native', { request: async () => ({}), submitText: async () => 'unused' });
      assert.equal(await sessions.isActiveCarrier(query), true);
      for (const patch of [{ invocationId: 'foreign' }, { threadId: 'foreign' }, { catId: 'foreign' }])
        assert.equal(await sessions.isActiveCarrier({ ...query, ...patch }), false);
      assert.equal(
        await new LiveCompanionSessions().isActiveCarrier(query),
        false,
        'a restart cannot infer authority from history',
      );
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let admittedLease: LiveCarrierOperationLease | undefined;
      const pending = sessions.withCarrierOperation(query, async (lease) => {
        admittedLease = lease;
        assert.equal(lease.matches(query), true);
        for (const patch of [{ invocationId: 'foreign' }, { threadId: 'foreign' }, { catId: 'foreign' }])
          assert.equal(lease.matches({ ...query, ...patch }), false);
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return 'durable receipt';
      });
      await started;
      const stopped = termination === 'stop' ? call.stop() : call.fail(new Error('fixture lease expired'));
      assert.equal(admittedLease?.matches(query), true, 'accepted operation retains exact scope while draining');
      assert.equal(await sessions.isActiveCarrier(query), false, 'stop revokes synchronously, before cleanup waits');
      await assert.rejects(
        sessions.withCarrierOperation(query, async () => 'late'),
        /unavailable|closing/,
      );
      let terminal = false;
      void call.finished.then(
        () => {
          terminal = true;
        },
        () => {
          terminal = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      const terminalBeforeReceipt = terminal;
      release();
      assert.equal(await pending, 'durable receipt');
      assert.equal(admittedLease?.matches(query), false, 'a completed operation cannot lend its admission proof');
      await stopped;
      assert.equal(terminalBeforeReceipt, false, 'carrier terminal must wait for the accepted source operation');
    } finally {
      await sessions.close();
    }
  });
