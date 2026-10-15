import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CodexNativeFence } from './codex-native-fence.js';

const input = {
  action: 'steer',
  sessionId: 'thread',
  nativeSessionId: 'thread',
  bindingRevision: 'binding-v1',
  expectedTurnId: 'A',
  operationId: 'recover-op',
  prompt: [{ type: 'text', text: 'synthetic notice' }],
};
const snapshot = () => ({ sessionId: 'thread', currentTurnId: 'A' });
async function directory(t: { after(callback: () => Promise<void>): void }) {
  const base = resolve(tmpdir());
  const dir = await mkdtemp(join(base, 'acp-control-recovery-'));
  t.after(async () => {
    if (!dir.startsWith(base + '/') && !dir.startsWith(base + '\\')) throw new Error('unsafe_test_cleanup');
    await rm(dir, { recursive: true, force: true });
  });
  return { journalDirectory: dir, bindingRevision: 'binding-v1' };
}
test('W4.P a lost ACP receipt survives a cold bridge owner without another native injection', async (t) => {
  const options = await directory(t);
  let calls = 0;
  const bridge = {
    async steerTurn(params: { turnId: string }) {
      calls++;
      return { turnId: params.turnId };
    },
  };
  const first = new CodexNativeFence(snapshot, bridge, options);
  const receipt = await first.handle(input); // Caller loses this wire reply.
  const reconnected = new CodexNativeFence(snapshot, bridge, options);
  assert.deepEqual(await reconnected.handle(input), receipt);
  assert.equal(calls, 1, 'reconnect must not repeat the native steer');
});
test('W4.P uncertain native reply reconciles only an exact native client ID, turn and input', async (t) => {
  const options = await directory(t);
  let calls = 0;
  let accepted:
    | { threadId: string; turnId: string; clientUserMessageId?: string; prompt: typeof input.prompt }
    | undefined;
  const bridge = {
    async steerTurn(params: NonNullable<typeof accepted>) {
      calls++;
      accepted = params;
      throw new Error('lost_native_reply');
    },
    async readUserMessage() {
      assert.ok(accepted?.clientUserMessageId, 'native stable client ID required for reconciliation');
      return {
        nativeSessionId: 'thread',
        nativeTurnId: 'A',
        nativeItemId: 'native-item',
        clientUserMessageId: accepted.clientUserMessageId,
        prompt: accepted.prompt,
      };
    },
  };
  await assert.rejects(new CodexNativeFence(snapshot, bridge, options).handle(input), /lost_native_reply/);
  const restored = new CodexNativeFence(snapshot, bridge, options);
  const receipt = await restored.handle({ ...input, action: 'receipt' });
  assert.equal(receipt.outcome, 'injected');
  assert.equal((receipt.nativeReceipt as { source: string }).source, 'native_history');
  assert.equal(calls, 1);
  assert.equal((await restored.handle(input)).outcome, 'injected');
  assert.equal(calls, 1);
});
test('W4.P a live owner promotes its failed promise after authoritative receipt reconciliation', async (t) => {
  const options = await directory(t);
  let calls = 0;
  let accepted: Parameters<import('./codex-native-fence.js').NativeCodexBridge['steerTurn']>[0] | undefined;
  const control = new CodexNativeFence(
    snapshot,
    {
      async steerTurn(params) {
        calls++;
        accepted = params;
        throw new Error('lost_reply');
      },
      async readUserMessage() {
        assert.ok(accepted?.clientUserMessageId);
        return {
          nativeSessionId: 'thread',
          nativeTurnId: 'A',
          nativeItemId: 'item',
          clientUserMessageId: accepted.clientUserMessageId,
          prompt: accepted.prompt,
        };
      },
    },
    options,
  );
  await assert.rejects(control.handle(input), /lost_reply/);
  const receipt = await control.handle({ ...input, action: 'receipt' });
  assert.equal(receipt['outcome'], 'injected');
  assert.deepEqual(await control.handle(input), receipt);
  assert.equal(calls, 1);
});
test('W4.P an unproved native outcome remains unknown and cannot be resent', async (t) => {
  const options = await directory(t);
  let calls = 0;
  const bridge = {
    async steerTurn() {
      calls++;
      throw new Error('transport_failed');
    },
    async readUserMessage() {
      return null;
    },
  };
  await assert.rejects(new CodexNativeFence(snapshot, bridge, options).handle(input), /transport_failed/);
  const restored = new CodexNativeFence(snapshot, bridge, options);
  assert.equal((await restored.handle({ ...input, action: 'receipt' })).outcome, 'outcome_unknown');
  assert.equal((await restored.handle(input)).outcome, 'outcome_unknown');
  assert.equal(calls, 1);
});
test('W4.P concurrent bridge owners cannot claim the same operation twice', async (t) => {
  const options = await directory(t);
  let calls = 0;
  const bridge = {
    async steerTurn() {
      calls++;
      await new Promise((r) => setTimeout(r, 15));
      return { turnId: 'A' };
    },
  };
  const a = new CodexNativeFence(snapshot, bridge, options);
  const b = new CodexNativeFence(snapshot, bridge, options);
  const receipts = await Promise.all([a.handle(input), b.handle(input)]);
  assert.equal(calls, 1);
  assert.ok(receipts.some((r) => r.outcome === 'injected'));
});
test('W4.P a reused operation with new content or foreign revision fails closed after restart', async (t) => {
  const options = await directory(t);
  let calls = 0;
  const bridge = {
    async steerTurn() {
      calls++;
      return { turnId: 'A' };
    },
  };
  await new CodexNativeFence(snapshot, bridge, options).handle(input);
  const restored = new CodexNativeFence(snapshot, bridge, options);
  await assert.rejects(
    restored.handle({ ...input, prompt: [{ type: 'text', text: 'changed' }] }),
    /operation_conflict/,
  );
  await assert.rejects(restored.handle({ ...input, bindingRevision: 'foreign' }), /invalid_native_target/);
  assert.equal(calls, 1);
});
