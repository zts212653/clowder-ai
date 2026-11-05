import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { sendLiveText } from '../src/domains/concierge/live/host/live-text-delivery.js';

test('native acceptance is persisted only after acknowledgement, preserving existing internal source identities', async () => {
  const store = new MessageStore();
  let acknowledge!: (value: string) => void;
  const accepted = new Promise<string>((resolve) => {
    acknowledge = resolve;
  });
  let started!: () => void;
  const submitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const operation = sendLiveText({
    options: {
      binding: {
        userId: 'owner',
        threadId: 'home',
        callId: 'original-internal-call',
        catId: createCatId('codex61-sol'),
      },
      messageStore: store,
      mcpDistDir: '',
      allowedDirectories: [],
      verifyNativeBinding: async () => true,
      publish() {},
    },
    client: {
      request: async () => ({}),
      submitText: async () => {
        started();
        return accepted;
      },
    },
    nativeThreadId: 'native',
    isAvailable: () => true,
    text: 'Input',
    clientMessageId: 'original-internal-client',
    deliveries: new Map(),
    exposedMessages: new Map(),
  });
  await submitted;
  const original = store.getByThread('home', 1, 'owner')[0]!;
  assert.equal(
    original.companionDeliveryReceipt,
    undefined,
    'persisting a user Message does not prove native acceptance',
  );
  acknowledge('native-turn');
  assert.equal((await operation).delivery, 'accepted');
  const fact = store.getById(original.id)?.companionDeliveryReceipt;
  assert.equal(fact?.clientMessageId, 'original-internal-client');
  assert.equal(fact?.callId, 'original-internal-call');
});
