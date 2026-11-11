import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { deliveryView, supplementView } from '../delivery-models';

function records(): ChatMessage[] {
  return [
    { id: 'initial', type: 'user', content: '开始', timestamp: 500 },
    {
      id: 'append',
      type: 'user',
      content: '补充内容',
      timestamp: 2000,
      lifecycle: {
        kind: 'input',
        orderKey: '2000:append',
        dispatchRefs: [{ targetId: 'codex', phase: 'settled', statusMessageId: 'reply', dispatchedAt: 2100 }],
      },
    },
    {
      id: 'reply',
      type: 'assistant',
      catId: 'codex',
      content: '答复',
      timestamp: 1000,
      lifecycle: {
        kind: 'response',
        orderKey: '1000:reply',
        invocationId: 'turn',
        targetId: 'codex',
        inputEntryIds: ['e1', 'e2'],
        inputMessageIds: ['initial', 'append'],
        status: 'completed',
        startedAt: 1000,
        completedAt: 3000,
      },
    },
  ];
}
describe('precise lifecycle evidence in engine message components', () => {
  it.each(['sent', 'failed', 'unknown'] as const)('uses the exact current cloud dispatch receipt for %s', (status) => {
    const source: ChatMessage = {
      id: 'cloud-source',
      type: 'user',
      content: 'Cloud question',
      timestamp: 1000,
      lifecycle: {
        kind: 'input',
        orderKey: '1000:cloud-source',
        dispatchRefs: [{ targetId: 'gpt-pro', phase: 'settled', statusMessageId: 'cloud-frame', dispatchedAt: 1100 }],
      },
    };
    const frame: ChatMessage = {
      id: 'cloud-frame',
      type: 'assistant',
      catId: 'gpt-pro',
      content: '',
      timestamp: 1100,
      lifecycle: {
        kind: 'response',
        orderKey: '1100:cloud-frame',
        targetId: 'gpt-pro',
        invocationId: 'current-attempt',
        inputEntryIds: [],
        inputMessageIds: [source.id],
        status: 'completed',
        startedAt: 1100,
        completedAt: 1200,
      },
    };
    const receipt = {
      v: 1,
      sourceMessageId: source.id,
      sourceSender: { kind: 'user', id: 'owner' },
      dispatchInvocationId: 'current-attempt',
      targetCatId: 'gpt-pro',
      status,
      transport: 'host',
      idempotency: { keyKind: 'source_message_id', disposition: 'fresh' },
    };
    const notice: ChatMessage = {
      id: 'cloud-receipt',
      type: 'connector',
      from: { kind: 'system', service: 'cloud-bridge-status' },
      content: 'Owner receipt',
      replyTo: source.id,
      timestamp: 1200,
      source: {
        connector: 'cloud-bridge-status',
        label: 'Cloud',
        icon: 'cloud',
        meta: { cloudBridgeOutboundReceipt: receipt },
      },
    };
    const messages = [source, frame, notice];
    expect(deliveryView(source, messages, [], 'thread')[0]).toMatchObject({
      who: 'gpt-pro',
      state: status === 'sent' ? 'delivered' : status,
      mid: '',
    });
    notice.source!.meta = { cloudBridgeOutboundReceipt: { ...receipt, dispatchInvocationId: 'previous-attempt' } };
    expect(deliveryView(source, messages, [], 'thread')[0].state).toBe('unknown');
  });
  it('does not infer reading from a completed or failed reply', () => {
    const messages = records();
    expect(deliveryView(messages[1], messages, [], 'thread')[0]).toMatchObject({
      who: 'codex',
      state: 'delivered',
      mid: 'reply',
    });
    expect(supplementView(messages[2], messages, (id) => id, '用户')?.items[0].state).not.toBe('read');
    if (messages[2].lifecycle?.kind === 'response')
      messages[2] = { ...messages[2], lifecycle: { ...messages[2].lifecycle, status: 'failed' } };
    expect(supplementView(messages[2], messages, (id) => id, '用户')?.items[0].state).not.toBe('read');
  });
  it('uses the exact dispatch reading receipt on both sender and supplementary source', () => {
    const messages = records();
    messages[1] = {
      ...messages[1],
      lifecycle: {
        ...messages[1].lifecycle!,
        dispatchRefs: [{ ...messages[1].lifecycle!.dispatchRefs![0], inputRead: { status: 'read', at: 2200 } }],
      },
    };
    expect(deliveryView(messages[1], messages, [], 'thread')[0].state).toBe('read');
    expect(supplementView(messages[2], messages, (id) => id, '用户')?.items[0]).toMatchObject({
      mid: 'append',
      text: '补充内容',
    });
    expect(supplementView(messages[2], messages, (id) => id, '用户')?.items[0].state).toBe('read');
    messages[1] = {
      ...messages[1],
      lifecycle: {
        ...messages[1].lifecycle!,
        dispatchRefs: [{ ...messages[1].lifecycle!.dispatchRefs![0], statusMessageId: 'other-reply' }],
      },
    };
    expect(supplementView(messages[2], messages, (id) => id, '用户')?.items[0].state).not.toBe('read');
  });
  it('retains source identity while hiding recalled supplementary text', () => {
    const messages = records();
    messages[1].extra = { recall: { version: 1, exposure: 'seen', recalledAt: 2400 } };
    expect(supplementView(messages[2], messages, (id) => id, '用户')?.items[0]).toMatchObject({
      mid: 'append',
      text: '',
      recalled: true,
    });
  });
});
