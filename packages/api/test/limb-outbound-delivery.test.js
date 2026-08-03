import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryLimbEmbodimentBindingStore } from '../dist/domains/limb/LimbEmbodimentBindingStore.js';
import { LimbOutboundDeliveryHook } from '../dist/domains/limb/LimbOutboundDeliveryHook.js';
import { OutboundDeliveryHook } from '../dist/infrastructure/connectors/OutboundDeliveryHook.js';

const NOW = Date.parse('2026-08-01T09:16:00.000Z');

test('fans one bound cat final through Limb authority as approved face and voice actions', async () => {
  const bindingStore = new MemoryLimbEmbodimentBindingStore();
  await bindingStore.put({
    nodeId: 'stackchan-home',
    userId: 'default-user',
    threadId: 'thread-stackchan',
    catId: 'codex-sol',
    expressionRef: 'yanyan:replying',
    voiceProfileRef: 'yanyan:local',
    volumePercent: 35,
    updatedAt: NOW,
  });
  const invoked = [];
  let id = 0;
  const hook = new LimbOutboundDeliveryHook({
    bindingStore,
    now: () => NOW,
    createId: () => `generated-${++id}`,
    limbRegistry: {
      async invoke(...args) {
        invoked.push(args);
        return { success: true };
      },
    },
  });

  await hook.deliver('thread-stackchan', '我在这里。', 'codex-sol', 'message-transcript-1');

  assert.equal(invoked.length, 2);
  assert.equal(invoked[0][0], 'stackchan-home');
  assert.equal(invoked[0][1], 'physical_limb.execute');
  assert.deepEqual(invoked[0][2].instruction.payload, {
    expression: 'yanyan:replying',
    expressionSource: { kind: 'play', ref: 'message-transcript-1' },
  });
  assert.deepEqual(invoked[1][2].instruction.payload, {
    text: '我在这里。',
    voiceProfileRef: 'yanyan:local',
    volumePercent: 35,
  });
  assert.equal(invoked[1][3].catId, 'codex-sol');
  assert.equal(invoked[1][3].threadId, 'thread-stackchan');
  assert.equal(invoked[1][3].userMessageId, 'message-transcript-1');

  await hook.deliver('thread-stackchan', '不该说', 'fable5', 'message-2');
  assert.equal(invoked.length, 2);
});

test('surfaces Limb refusal instead of bypassing policy or replaying directly', async () => {
  const bindingStore = new MemoryLimbEmbodimentBindingStore();
  await bindingStore.put({
    nodeId: 'stackchan-home',
    userId: 'default-user',
    threadId: 'thread-stackchan',
    catId: 'codex-sol',
    expressionRef: 'yanyan:replying',
    voiceProfileRef: 'yanyan:local',
    volumePercent: 35,
    updatedAt: NOW,
  });
  const hook = new LimbOutboundDeliveryHook({
    bindingStore,
    now: () => NOW,
    createId: () => 'generated',
    limbRegistry: {
      async invoke() {
        return { success: false, error: 'lease lost' };
      },
    },
  });

  await assert.rejects(hook.deliver('thread-stackchan', '我在这里。', 'codex-sol', 'message-1'), /lease lost/);
});

test('coalesces in-flight and recently completed retries for the same physical reply', async () => {
  const bindingStore = new MemoryLimbEmbodimentBindingStore();
  await bindingStore.put({
    nodeId: 'stackchan-home',
    userId: 'default-user',
    threadId: 'thread-stackchan',
    catId: 'codex-sol',
    expressionRef: 'yanyan:replying',
    voiceProfileRef: 'yanyan:local',
    volumePercent: 35,
    updatedAt: NOW,
  });
  let releaseFirstAction;
  const firstActionGate = new Promise((resolve) => {
    releaseFirstAction = resolve;
  });
  let idCount = 0;
  let invokeCount = 0;
  const hook = new LimbOutboundDeliveryHook({
    bindingStore,
    now: () => NOW,
    createId: () => `generated-${++idCount}`,
    limbRegistry: {
      async invoke() {
        invokeCount += 1;
        if (invokeCount === 1) await firstActionGate;
        return { success: true };
      },
    },
  });

  const first = hook.deliver('thread-stackchan', '不要复读我。', 'codex-sol', 'message-transcript-1');
  await new Promise((resolve) => setImmediate(resolve));
  const overlappingRetry = hook.deliver('thread-stackchan', '不要复读我。', 'codex-sol', 'message-transcript-1');
  releaseFirstAction();
  await Promise.all([first, overlappingRetry]);
  await hook.deliver('thread-stackchan', '不要复读我。', 'codex-sol', 'message-transcript-1');

  assert.equal(invokeCount, 2, 'one display + one speaker action for one logical reply');
});

test('connector outbound fanout still reaches a body when the thread has no chat connector', async () => {
  const delivered = [];
  const noop = () => {};
  const hook = new OutboundDeliveryHook({
    bindingStore: {
      async getByThread() {
        return [];
      },
    },
    adapters: new Map(),
    log: { info: noop, warn: noop, error: noop },
    limbDelivery: {
      async deliver(...args) {
        delivered.push(args);
      },
    },
  });

  await hook.deliver(
    'thread-stackchan',
    '我在这里。',
    'codex-sol',
    undefined,
    undefined,
    undefined,
    'message-transcript-1',
  );

  assert.deepEqual(delivered, [['thread-stackchan', '我在这里。', 'codex-sol', 'message-transcript-1']]);
});
