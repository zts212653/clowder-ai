import { expect, it, vi } from 'vitest';
import { type CloudRecoveryBinding, cloudRecoveryTargets, cloudRecoveryView } from '../cloud-models';
import { fixtureData } from './chat-fixture';

it('keeps recovery on the real notice, exact source and dispatch, and shows an attested reply without another retry', () => {
  const data = fixtureData();
  data.messages.push({
    id: 'notice-1',
    type: 'connector',
    content: 'not sent',
    replyTo: 'user-1',
    timestamp: 2,
    source: {
      connector: 'cloud-bridge-status',
      label: 'Cloud delivery',
      icon: 'cloud',
      meta: {
        cloudBridgeRecovery: {
          v: 1,
          kind: 'needs_binding',
          sourceMessageId: 'user-1',
          targetCatId: 'gpt-pro',
          dispatchInvocationId: 'dispatch-1',
        },
      },
    },
  });
  const target = cloudRecoveryTargets(data.messages, data.threadId)[0];
  expect(target).toEqual({
    mid: 'notice-1',
    dispatchInvocationId: 'dispatch-1',
    identity: { threadId: 'pdl-test', sourceMessageId: 'user-1', targetCatId: 'gpt-pro', attemptId: 'dispatch-1' },
  });
  const binding: CloudRecoveryBinding = {
    target,
    sourceAvailable: true,
    result: { state: 'unverified' },
    controller: {
      loadState: {
        kind: 'ready',
        boundChatUrl: null,
        provider: 'chatgpt',
        hydratedAttemptId: 'dispatch-1',
        retryState: 'ready',
      },
      phase: 'idle',
      operationError: null,
      attemptId: 'dispatch-1',
      refresh: vi.fn(),
      bindAndRetry: vi.fn(),
    },
  };
  // The host gives the provider's render type and its own conditions; the conversation choice is the plugin's.
  expect(cloudRecoveryView(binding).recoveries[0]).toMatchObject({
    type: 'cloudRecovery.chatgpt',
    boundChatUrl: null,
    canSubmit: true,
    args: { sourceMessageId: 'user-1', attemptId: 'dispatch-1', mid: 'notice-1' },
  });
  expect(cloudRecoveryView(binding).recoveries[0]).not.toHaveProperty('candidates');
  binding.controller = { ...binding.controller, loadState: { kind: 'ready', boundChatUrl: null } };
  expect(cloudRecoveryView(binding).recoveries[0].type).toBe('cloudRecovery');
  binding.result = { state: 'replied', replyMessageId: 'reply-1' };
  expect(cloudRecoveryView(binding).recoveries[0]).toMatchObject({
    canSubmit: false,
    reply: { mid: 'reply-1', t: 'pdl-test' },
  });
});
