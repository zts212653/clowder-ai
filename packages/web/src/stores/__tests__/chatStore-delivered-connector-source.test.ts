/**
 * A connector notice that reaches the timeline through Queue delivery must stay a connector.
 *
 * #1398 normalized producers to write an explicit `from: {kind:'system', service}` on connector
 * notices. Before that, those notices stored no `from` at all, so the server synthesized
 * `{kind:'external', connectorId}` from `source` and every consumer derived `connector` for free.
 * The server timeline projection already handles the explicit form —
 * `external || plugin || (system && source)` — but the client copies of that same rule never
 * learned the `system && source` branch. So a hold-ball notice arrived as `type:'system'` with no
 * `source`, `ChatMessage`'s `isConnector && message.source` gate failed, and the hold-ball card
 * silently degraded to a plain text block: the exact regression that 3057 green tests and 16 green
 * CI checks could not see, because every one of them asserts persistence or the REST projection,
 * never what the live socket hands the store.
 *
 * These cases pin the store-level contract: delivery carries `source` through and classifies the
 * envelope the same way the server does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

const NOW = 1700000000000;

const HOLD_BALL_SOURCE = {
  connector: 'hold-ball',
  label: '持球通知',
  icon: '🏓',
  meta: {
    managedHold: true,
    phase: 'wake',
    taskId: 'hold-ball-1789973271596-6qevg0',
    threadId: 'thread-1',
    catId: 'cat-06km2rgh',
    wakeWhen: true,
  },
} as const;

function deliveredHoldBallNotice(id: string) {
  return {
    id,
    // The envelope #1398 actually admits for a managed-command wake.
    from: { kind: 'system' as const, service: 'managed-command-wake' },
    content: '[定时任务] 持球唤醒（命令完成）',
    catId: null,
    timestamp: NOW,
    mentions: [] as readonly string[],
    userId: 'default-user',
    source: HOLD_BALL_SOURCE,
  };
}

describe('markMessagesDelivered connector framing', () => {
  beforeEach(() => {
    useChatStore.setState({ currentThreadId: 'thread-1', messages: [], threadStates: {} });
  });

  it('classifies a system-authored notice that carries a source as a connector', () => {
    useChatStore.getState().markMessagesDelivered('thread-1', ['m1'], NOW + 1, [deliveredHoldBallNotice('m1')]);

    const message = useChatStore.getState().messages.find((candidate) => candidate.id === 'm1');
    expect(message).toBeDefined();
    // `type:'system'` here is what made the hold-ball card vanish.
    expect(message?.type).toBe('connector');
  });

  it('keeps the source on the delivered message so the connector card can render', () => {
    useChatStore.getState().markMessagesDelivered('thread-1', ['m1'], NOW + 1, [deliveredHoldBallNotice('m1')]);

    const message = useChatStore.getState().messages.find((candidate) => candidate.id === 'm1');
    // ConnectorBubble needs `source.connector` plus a string `source.meta.taskId` to offer the
    // hold controls at all; dropping `source` removes the whole card, not just the button.
    expect(message?.source?.connector).toBe('hold-ball');
    expect(typeof message?.source?.meta?.taskId).toBe('string');
  });

  it('still classifies a system notice with no source as a system message', () => {
    useChatStore.getState().markMessagesDelivered('thread-1', ['m2'], NOW + 1, [
      {
        id: 'm2',
        from: { kind: 'system' as const, service: 'routing-guard' },
        content: 'plain system notice',
        catId: null,
        timestamp: NOW,
        mentions: [] as readonly string[],
        userId: 'default-user',
      },
    ]);

    const message = useChatStore.getState().messages.find((candidate) => candidate.id === 'm2');
    expect(message?.type).toBe('system');
  });
});
