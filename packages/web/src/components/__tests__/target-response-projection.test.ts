import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectTargetReply, targetReplyNotice } from '../target-response-projection';

const source: ChatMessage = {
  id: 'input',
  type: 'user',
  content: 'hello',
  timestamp: 1,
  lifecycle: {
    kind: 'input',
    orderKey: '1',
    dispatchRefs: [{ targetId: 'instance', statusMessageId: 'receipt', phase: 'settled', dispatchedAt: 2 }],
  },
};
const receipt: ChatMessage = {
  id: 'receipt',
  type: 'system',
  from: { kind: 'system', service: 'plugin_delivery' },
  content: 'receipt',
  timestamp: 2,
  extra: {
    pluginAddressedReceipt: { inputMessageId: 'input', targetId: 'instance', accepted: true, phase: 'accepted' },
    targetResponse: {
      v: 1,
      revision: 1,
      inputMessageId: 'input',
      targetId: 'instance',
      execution: { kind: 'plugin', id: 'delivery' },
      status: 'waiting',
      startedAt: 2,
      updatedAt: 2,
    },
  },
};
describe('one participant response projection', () => {
  it('persists waiting across a page revisit and distinguishes transport settlement from response completion', () => {
    const view = projectTargetReply(receipt, [source, receipt]);
    expect(view?.status).toBe('waiting');
    expect(view?.terminal).toBe(false);
    expect(view?.showFrame).toBe(true);
  });
  it.each([
    'completed',
    'failed',
    'canceled',
    'interrupted',
  ] as const)('uses the same terminal %s outcome for both backends', (status) => {
    const plugin = {
      ...receipt,
      extra: { ...receipt.extra, targetResponse: { ...receipt.extra!.targetResponse!, status } },
    };
    const member: ChatMessage = {
      id: 'member',
      type: 'assistant',
      content: '',
      timestamp: 2,
      lifecycle: {
        kind: 'response',
        orderKey: '2',
        targetId: 'member',
        invocationId: 'real',
        inputEntryIds: ['q'],
        inputMessageIds: ['input'],
        status,
        startedAt: 2,
      },
    };
    expect(projectTargetReply(plugin, [source, plugin])?.terminal).toBe(true);
    expect(projectTargetReply(member, [source, member])?.terminal).toBe(true);
    expect(targetReplyNotice(projectTargetReply(plugin, [source, plugin])!.status)).toBe(
      targetReplyNotice(projectTargetReply(member, [source, member])!.status),
    );
  });
  it('content takes over without fabricating completion for a multi-part plugin', () => {
    const body: ChatMessage = {
      id: 'part',
      type: 'connector',
      from: { kind: 'plugin', instanceId: 'instance' },
      replyTo: 'input',
      content: 'partial',
      timestamp: 3,
    };
    const view = projectTargetReply(receipt, [source, receipt, body]);
    expect(view?.hasBody).toBe(true);
    expect(view?.showFrame).toBe(false);
    expect(view?.terminal).toBe(false);
  });
  it('a durable terminal result reference does not revive waiting when its body is paged out', () => {
    const done = {
      ...receipt,
      extra: {
        ...receipt.extra,
        targetResponse: {
          ...receipt.extra!.targetResponse!,
          status: 'completed' as const,
          resultMessageId: 'stored-result',
        },
      },
    };
    expect(projectTargetReply(done, [source, done])?.showFrame).toBe(false);
  });
});
