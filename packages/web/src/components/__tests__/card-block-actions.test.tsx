import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardBlock } from '@/components/rich/CardBlock';
import type { RichCardBlock } from '@/stores/chat-types';

const mockUpdateRichBlock = vi.fn();

vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ updateRichBlock: mockUpdateRichBlock }) },
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

describe('CardBlock actions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;

  const block: RichCardBlock = {
    id: 'antigravity-recovery-card',
    kind: 'card',
    v: 1,
    title: 'Antigravity 恢复建议',
    bodyMarkdown: '连接中断后请继续未完成动作。',
    actions: [
      {
        label: '复制诊断',
        action: 'copy-to-clipboard',
        payload: { text: 'diagnostic summary text' },
      },
    ],
  };

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockUpdateRichBlock.mockReset();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('copies diagnostic text for copy-to-clipboard actions', async () => {
    await act(async () => {
      root.render(React.createElement(CardBlock, { block, messageId: 'msg-1' }));
    });

    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '复制诊断');
    expect(button).toBeTruthy();
    const copyButton = button as HTMLButtonElement;

    await act(async () => {
      copyButton.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('diagnostic summary text');
    expect(container.textContent).toContain('已复制');
  });

  it('wraps long action labels instead of squeezing them into vertical columns', async () => {
    const manyActionsBlock: RichCardBlock = {
      ...block,
      id: 'many-concierge-actions',
      actions: Array.from({ length: 8 }, (_, index) => ({
        label: `跳过去：这是第 ${index + 1} 个很长的中文 thread 标题`,
        action: 'concierge_teleport',
        payload: { threadId: `thread_${index + 1}` },
      })),
    };

    await act(async () => {
      root.render(React.createElement(CardBlock, { block: manyActionsBlock, messageId: 'msg-many' }));
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(8);
    expect(buttons[0].parentElement?.classList.contains('flex-wrap')).toBe(true);
    for (const button of buttons) {
      expect(button.classList.contains('max-w-full')).toBe(true);
      expect(button.classList.contains('text-left')).toBe(true);
      expect(button.classList.contains('break-words')).toBe(true);
    }
  });
});
