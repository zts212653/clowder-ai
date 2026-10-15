import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexNativeFence } from './codex-native-fence.js';

const input = {
  action: 'steer',
  sessionId: 'thread',
  nativeSessionId: 'thread',
  expectedTurnId: 'A',
  operationId: 'op',
  prompt: [{ type: 'text', text: 'sentinel' }],
};
test('W4.P controlled A→B race forwards caller A to the native fence and never starts B', async () => {
  let current: string | null = 'A';
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wire: unknown[] = [];
  const control = new CodexNativeFence(() => ({ sessionId: 'thread', currentTurnId: current }), {
    async steerTurn(params) {
      wire.push(params);
      await gate;
      if (params.turnId !== current) throw new Error('native_stale_target');
      return { turnId: current };
    },
  });
  assert.deepEqual(await control.handle({ action: 'snapshot', sessionId: 'thread' }), {
    nativeSessionId: 'thread',
    nativeTurnId: 'A',
    source: 'native_turn_start_callback',
  });
  const pending = control.handle(input);
  current = 'B';
  release?.();
  await assert.rejects(pending, /native_stale_target/);
  assert.equal((wire[0] as { turnId: string }).turnId, 'A');
  await assert.rejects(control.handle(input), /native_stale_target/);
  assert.equal(wire.length, 1, 'duplicate operation cannot repeat native side effects');
  assert.equal(current, 'B');
});
test('W4.P actual target receipt, operation conflict and unknown/foreign bindings fail closed', async () => {
  const wire: unknown[] = [];
  const control = new CodexNativeFence(
    (session) => {
      if (session !== 'thread') throw new Error('unknown_session');
      return { sessionId: session, currentTurnId: 'A' };
    },
    {
      async steerTurn(params) {
        wire.push(params);
        return { turnId: params.turnId };
      },
    },
  );
  const receipt = await control.handle(input);
  assert.equal(receipt.nativeTurnId, 'A');
  assert.deepEqual(await control.handle(input), receipt);
  assert.equal(wire.length, 1);
  await assert.rejects(control.handle({ ...input, expectedTurnId: 'B' }), /operation_conflict/);
  await assert.rejects(
    control.handle({ ...input, operationId: 'foreign', nativeSessionId: 'other' }),
    /invalid_native_target/,
  );
  await assert.rejects(control.handle({ ...input, sessionId: 'other' }), /unknown_session/);
  await assert.rejects(control.handle({ ...input, expectedTurnId: '' }), /invalid_native_target/);
  assert.equal(wire.length, 1);
});
