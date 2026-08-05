import type { QueueMessageReceipt } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { collectInvocationLineageMessageIds, focusInvocationLineage, MessageReceiptDock } from '../MessageReceiptDock';

const receipt: QueueMessageReceipt = {
  version: 1,
  entryId: 'entry-1',
  targets: [
    {
      catId: 'opus',
      state: 'handled',
      authorIntent: {
        requested: 'continue_current',
        effective: 'continue_current',
        boundParentInvocationId: 'parent-1',
        carrierCapability: {
          provider: 'openai_codex',
          carrier: 'codex_app_server',
          deliverySemantics: 'exact_active_turn',
        },
      },
      invocationId: 'inv-response',
      seenAt: 400,
      outcome: {
        invocationId: 'inv-response',
        disposition: 'responded',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-response' },
        handledAt: 500,
      },
    },
    {
      catId: 'codex',
      state: 'handled',
      authorIntent: {
        requested: 'next_work',
        effective: 'next_work',
        carrierCapability: {
          provider: 'anthropic',
          carrier: 'claude_print_sdk',
          deliverySemantics: 'unsupported',
        },
      },
      invocationId: 'inv-complete',
      seenAt: 550,
      outcome: {
        invocationId: 'inv-complete',
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-complete' },
        handledAt: 600,
      },
    },
    { catId: 'gpt52', state: 'seen', invocationId: 'inv-active', seenAt: 300 },
    { catId: 'sonnet', state: 'failed', invocationId: 'inv-failed', seenAt: 350 },
    { catId: 'gemini', state: 'steering' },
  ],
  reminderAttempts: [
    {
      id: 'reminder-seen',
      targetCatId: 'gpt52',
      invocationId: 'inv-active',
      state: 'seen',
      requestedAt: 100,
      seenAt: 120,
    },
    {
      id: 'reminder-missed',
      targetCatId: 'gemini',
      invocationId: 'inv-old',
      state: 'missed',
      requestedAt: 200,
      missedAt: 220,
      missedReason: 'invocation_ended_before_delivery',
    },
  ],
};

describe('MessageReceiptDock', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('keeps response handling, turn completion, Steer, and reminder truth visibly distinct', () => {
    const executionMessages: ChatMessage[] = [
      {
        id: 'ordinary-output',
        type: 'assistant',
        catId: 'opus',
        content: 'ordinary answer',
        timestamp: 1,
        extra: {
          turnExecution: {
            invocationId: 'inv-response',
            parentInvocationId: 'parent-1',
            executionKind: 'ordinary',
          },
        },
      },
      {
        id: 'supplement-output',
        type: 'assistant',
        catId: 'codex',
        content: 'late answer',
        timestamp: 2,
        extra: {
          turnExecution: {
            invocationId: 'inv-complete',
            parentInvocationId: 'parent-1',
            executionKind: 'freshness_supplement',
          },
        },
      },
      {
        id: 'guard-output',
        type: 'assistant',
        catId: 'gpt52',
        content: 'original body',
        timestamp: 3,
        extra: {
          auxiliaryTurnExecutions: [
            {
              invocationId: 'inv-active',
              parentInvocationId: 'parent-1',
              executionKind: 'routing_guard',
            },
          ],
        },
      },
    ];
    act(() => {
      root.render(
        <MessageReceiptDock
          receipt={receipt}
          messages={executionMessages}
          activeInvocationIds={new Set(['inv-active'])}
          getCatLabel={(catId) => ({ opus: '布偶', codex: '砚砚' })[catId] ?? catId}
        />,
      );
    });

    expect(container.textContent).toContain('布偶 · 已由回复明确处理');
    expect(container.textContent).toContain('砚砚 · 已随本轮完成');
    expect(container.textContent).toContain('接着当前工作 · 等待本轮读取');
    expect(container.textContent).toContain('下一件工作 · 本轮不可见');
    expect(container.querySelector('[data-receipt-target="opus"]')?.textContent).toContain('codex_app_server');
    expect(container.querySelector('[data-receipt-target="codex"]')?.textContent).toContain('unsupported');
    expect(container.textContent).toContain('gpt52 · 已读 · 当前轮处理中');
    expect(container.textContent).toContain('sonnet · 已读取 · 未收口，已回队列');
    expect(container.textContent).toContain('正文读取');
    expect(container.textContent).toContain('处理完成');
    expect(container.textContent).toContain('提醒后已读取');
    expect(container.textContent).toContain('gemini · Steer 中');
    expect(container.textContent).toContain('提醒未赶上本轮');
    expect(container.querySelector('[data-receipt-target="opus"]')?.textContent).toContain('普通执行');
    expect(container.querySelector('[data-receipt-target="codex"]')?.textContent).toContain('后到消息补充');
    expect(container.querySelector('[data-receipt-target="gpt52"]')?.textContent).toContain('系统补路由');
    const unloadedLineageLinks = container.querySelectorAll<HTMLButtonElement>('[data-receipt-lineage-link]');
    expect(unloadedLineageLinks).toHaveLength(2);
    expect([...unloadedLineageLinks].every((button) => !button.disabled)).toBe(true);
    const opusTiming = container.querySelector('[data-receipt-target="opus"] [data-seen-at]');
    expect(opusTiming?.getAttribute('data-seen-at')).toBe('400');
    expect(opusTiming?.getAttribute('data-handled-at')).toBe('500');
    const failedTiming = container.querySelector('[data-receipt-target="sonnet"] [data-seen-at]');
    expect(failedTiming?.getAttribute('data-seen-at')).toBe('350');
    expect(failedTiming?.hasAttribute('data-handled-at')).toBe(false);
  });

  it('labels a seen target without a matching live invocation as unsettled', () => {
    act(() => {
      root.render(
        <MessageReceiptDock
          receipt={receipt}
          messages={[]}
          activeInvocationIds={new Set(['inv-unrelated'])}
          getCatLabel={(catId) => catId}
        />,
      );
    });

    expect(container.textContent).toContain('gpt52 · 已读，但关联回合已结束；尚未确认处理完成');
    expect(container.textContent).not.toContain('gpt52 · 已读 · 当前轮处理中');
  });

  it('does not borrow a different live invocation for the same target cat', () => {
    act(() => {
      root.render(
        <MessageReceiptDock
          receipt={receipt}
          messages={[]}
          activeInvocationIds={new Set(['inv-gpt52-successor'])}
          getCatLabel={(catId) => catId}
        />,
      );
    });

    expect(container.textContent).toContain('gpt52 · 已读，但关联回合已结束；尚未确认处理完成');
  });

  it('renders a terminal-silent cross-thread consumption as a system receipt, not a cat reply', () => {
    const terminalReceipt: QueueMessageReceipt = {
      version: 1,
      entryId: 'cross-thread:message-1',
      scope: 'cross_thread_delivery',
      targets: [
        {
          catId: 'codex',
          state: 'handled',
          invocationId: 'child-terminal-silent',
          seenAt: 700,
          outcome: {
            invocationId: 'child-terminal-silent',
            disposition: 'completed_with_turn',
            evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-terminal-silent' },
            handledAt: 800,
            consumption: {
              kind: 'terminal_silent',
              projectionState: 'covered_empty',
              wake: 'coordination_terminal',
            },
          },
        },
      ],
      reminderAttempts: [],
    };

    act(() => {
      root.render(<MessageReceiptDock receipt={terminalReceipt} messages={[]} getCatLabel={() => '砚砚'} />);
    });

    expect(container.textContent).toContain('系统回执');
    expect(container.textContent).toContain('砚砚 · 已消费 · terminal 静默结束');
    expect(container.textContent).toContain('协调链已结束，没有新任务，因此无需回复');
    expect(container.querySelector('[data-terminal-consumption="terminal_silent"]')).not.toBeNull();
    expect(container.querySelector('[data-cat-reply]')).toBeNull();
  });

  it('shows cross-thread admission and exact child wake as distinct receipt stages', () => {
    const base: QueueMessageReceipt = {
      version: 1,
      entryId: 'cross-thread:message-2',
      scope: 'cross_thread_delivery',
      targets: [{ catId: 'codex', state: 'queued' }],
      reminderAttempts: [],
    };

    act(() => {
      root.render(<MessageReceiptDock receipt={base} messages={[]} getCatLabel={() => '砚砚'} />);
    });
    expect(container.textContent).toContain('砚砚 · 已送达');

    act(() => {
      root.render(
        <MessageReceiptDock
          receipt={{
            ...base,
            targets: [{ catId: 'codex', state: 'awakened', invocationId: 'child-live', awakenedAt: 650 }],
          }}
          messages={[]}
          activeInvocationIds={new Set(['child-live'])}
          getCatLabel={() => '砚砚'}
        />,
      );
    });
    expect(container.textContent).toContain('砚砚 · 已唤醒 · 等待接入本轮');
    expect(container.textContent).toContain('回合唤醒');

    act(() => {
      root.render(
        <MessageReceiptDock
          receipt={{
            ...base,
            targets: [{ catId: 'codex', state: 'seen', invocationId: 'child-live', seenAt: 700 }],
          }}
          messages={[]}
          activeInvocationIds={new Set(['child-live'])}
          getCatLabel={() => '砚砚'}
        />,
      );
    });
    expect(container.textContent).toContain('砚砚 · 已唤醒 · 当前轮处理中');
  });

  it('distinguishes failure before child creation from invoked-but-unsettled', () => {
    const base: QueueMessageReceipt = {
      version: 1,
      entryId: 'cross-thread:message-failed',
      scope: 'cross_thread_delivery',
      targets: [{ catId: 'codex', state: 'failed' }],
      reminderAttempts: [],
    };

    act(() => {
      root.render(<MessageReceiptDock receipt={base} messages={[]} getCatLabel={() => '砚砚'} />);
    });
    expect(container.textContent).toContain('砚砚 · 未能唤醒 · 已回队列');

    act(() => {
      root.render(
        <MessageReceiptDock
          receipt={{
            ...base,
            targets: [
              {
                catId: 'codex',
                state: 'failed',
                invocationId: 'child-unsettled',
                awakenedAt: 750,
              },
            ],
          }}
          messages={[]}
          getCatLabel={() => '砚砚'}
        />,
      );
    });
    expect(container.textContent).toContain('砚砚 · 已唤醒 · 未收口，已回队列');

    act(() => {
      root.render(
        <MessageReceiptDock
          receipt={{
            ...base,
            targets: [
              {
                catId: 'codex',
                state: 'failed',
                invocationId: 'child-read-unsettled',
                seenAt: 800,
              },
            ],
          }}
          messages={[]}
          getCatLabel={() => '砚砚'}
        />,
      );
    });
    expect(container.textContent).toContain('砚砚 · 已读取 · 未收口，已回队列');
  });

  it('keeps author withdrawal visible as history instead of actionable Queue work', () => {
    const withdrawnReceipt: QueueMessageReceipt = {
      version: 1,
      entryId: 'entry-withdrawn',
      targets: [{ catId: 'codex', state: 'withdrawn', withdrawnAt: 900 }],
      reminderAttempts: [
        {
          id: 'reminder-withdrawn',
          targetCatId: 'codex',
          invocationId: 'parent-old',
          state: 'missed',
          requestedAt: 800,
          missedAt: 900,
          missedReason: 'source_withdrawn',
        },
      ],
    };

    act(() => {
      root.render(<MessageReceiptDock receipt={withdrawnReceipt} messages={[]} getCatLabel={() => '砚砚'} />);
    });

    expect(container.textContent).toContain('砚砚 · 已撤出待处理 · 历史保留');
    expect(container.textContent).toContain('撤出待处理');
    expect(container.querySelector('[data-withdrawn-at="900"]')).not.toBeNull();
    expect(container.querySelector('[title="消息已由你撤出待处理，提醒随之结束"]')).not.toBeNull();
  });

  it('does not render a work-period dock for the message that started the invocation', () => {
    act(() => {
      root.render(
        <MessageReceiptDock
          receipt={{ ...receipt, scope: 'primary_trigger' }}
          messages={[]}
          getCatLabel={(catId) => catId}
        />,
      );
    });

    expect(container.querySelector('[data-testid="message-receipt-dock"]')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('invocation lineage navigation', () => {
  const messages: ChatMessage[] = [
    {
      id: 'msg-original',
      type: 'assistant',
      catId: 'opus',
      content: 'answer',
      timestamp: 1,
      extra: { stream: { invocationId: 'inv-1', turnInvocationId: 'turn-1' } },
    },
    {
      id: 'msg-second-bubble',
      type: 'assistant',
      catId: 'opus',
      content: 'more',
      timestamp: 2,
      extra: { stream: { invocationId: 'inv-1', turnInvocationId: 'turn-2' } },
    },
    {
      id: 'msg-supplement',
      type: 'assistant',
      catId: 'opus',
      content: 'supplement',
      timestamp: 3,
      extra: {
        supplement: {
          lineageId: 'msg-original',
          supplementId: 'sup-1',
          seq: 1,
          originalMessageId: 'msg-original',
        },
      },
    },
    { id: 'msg-unrelated', type: 'assistant', catId: 'codex', content: 'other', timestamp: 4 },
  ];

  it('collects every bubble and supplement in the invocation lineage', () => {
    expect(collectInvocationLineageMessageIds(messages, 'inv-1')).toEqual([
      'msg-original',
      'msg-second-bubble',
      'msg-supplement',
    ]);
  });

  it('highlights the whole lineage and scrolls to its first loaded bubble', () => {
    const host = document.createElement('div');
    for (const id of ['msg-original', 'msg-second-bubble', 'msg-supplement', 'msg-unrelated']) {
      const node = document.createElement('div');
      node.dataset.messageId = id;
      node.scrollIntoView = vi.fn();
      host.appendChild(node);
    }
    document.body.appendChild(host);

    expect(focusInvocationLineage(messages, 'inv-1')).toBe(true);
    expect(host.querySelectorAll('[data-lineage-focus="true"]')).toHaveLength(3);
    expect((host.firstElementChild as HTMLElement).scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });

    host.remove();
  });
});
