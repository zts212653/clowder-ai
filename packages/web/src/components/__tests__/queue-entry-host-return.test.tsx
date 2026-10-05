import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({ name: 'co-creator', aliases: [], mentionPatterns: [] }),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [{ id: 'gpt52', displayName: '缅因猫', variantLabel: 'GPT-5.4' }],
    getCatById: (id: string) => (id === 'gpt52' ? { id, displayName: '缅因猫', variantLabel: 'GPT-5.4' } : undefined),
  }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

const HOST_RETURN =
  '[Host 作品修改请求：原任务续办] 人的明确请求已持久保存。继续下面的同一个 Task。\n{"requestId":"f309-modification-abc","taskId":"task-1"}\n先用 cat_cafe_read_content_modification 读回请求。';

function entry(connector?: string): QueueEntry {
  return {
    id: 'queue-host-return',
    threadId: 'thread-f309',
    userId: 'system',
    content: HOST_RETURN,
    messageId: 'message-host-return',
    mergedMessageIds: [],
    source: 'connector',
    targetCats: ['gpt52'],
    intent: 'execute',
    status: 'queued',
    createdAt: Date.now(),
    ...(connector ? { messagePreview: { connector } } : {}),
  };
}

class MockResizeObserver implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

describe('QueueEntryRow Host content-review return', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof globalThis.ResizeObserver;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver;
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  async function render(queueEntry: QueueEntry) {
    useChatStore.setState({
      messages: [],
      currentThreadId: 'thread-f309',
      queue: [queueEntry],
      queuePaused: false,
    });
    await act(async () => {
      root.render(<QueuePanel threadId="thread-f309" />);
    });
  }

  it('shows the human headline and connector name instead of the cat-facing envelope', async () => {
    await render(entry('content-review'));

    const summary = container.querySelector<HTMLElement>('[data-overflow-measure="block"]');
    expect(summary?.textContent).toBe('作品修改请求：原任务续办');
    expect(container.textContent).not.toContain('requestId');
    expect(container.textContent).not.toContain('cat_cafe_read_content_modification');
    expect(container.textContent).toContain('产物审阅');

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(trigger?.textContent).toContain('查看全文');
    await act(async () => trigger?.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    expect(dialog?.textContent).toContain('cat_cafe_read_content_modification');
  });

  it('leaves other connector rows untouched', async () => {
    await render(entry(undefined));

    const summary = container.querySelector<HTMLElement>('[data-overflow-measure="block"]');
    expect(summary?.textContent).toBe(HOST_RETURN);
  });
});
