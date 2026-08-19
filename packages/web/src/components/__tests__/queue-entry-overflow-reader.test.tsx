import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: 'co-creator',
    aliases: [],
    mentionPatterns: [],
  }),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [{ id: 'codex-sol', displayName: '缅因猫 Sol', variantLabel: 'GPT-5.6 Sol' }],
    getCatById: (id: string) =>
      id === 'codex-sol' ? { id, displayName: '缅因猫 Sol', variantLabel: 'GPT-5.6 Sol' } : undefined,
  }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

const LONG_QUEUE_MESSAGE =
  '✅ **CI 通过**\n\n这是一条需要完整保留的排队消息。中文没有空格分词，家庭 emoji 👨‍👩‍👧‍👦 也不能被切坏。\n\n最后一段是验证尾部仍可恢复的证据。';

const QUEUE_ENTRY: QueueEntry = {
  id: 'queue-long-content',
  threadId: 'thread-f269',
  userId: 'system',
  content: LONG_QUEUE_MESSAGE,
  messageId: 'message-f269',
  mergedMessageIds: [],
  source: 'connector',
  sourceCategory: 'ci',
  targetCats: ['codex-sol'],
  intent: 'execute',
  status: 'queued',
  createdAt: Date.now(),
};

const resizeCallbacks = new Set<ResizeObserverCallback>();

class MockResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.add(callback);
  }

  disconnect() {}
  observe() {}
  unobserve() {}
}

function setElementSize(element: Element, size: { clientHeight: number; scrollHeight: number }) {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: size.clientHeight });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: size.scrollHeight });
}

async function notifyResize(element: Element) {
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback([{ target: element } as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}

function requireElement<T extends Element>(element: T | null): T {
  expect(element).not.toBeNull();
  if (!element) throw new Error('Expected element to exist');
  return element;
}

describe('QueueEntryRow long-content recovery', () => {
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
    useChatStore.setState({
      messages: [],
      currentThreadId: 'thread-f269',
      queue: [QUEUE_ENTRY],
      queuePaused: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
    resizeCallbacks.clear();
    vi.restoreAllMocks();
  });

  it('keeps the queue row compact and recovers the complete message in a bounded reader', async () => {
    await act(async () => {
      root.render(<QueuePanel threadId="thread-f269" />);
    });

    const summary = requireElement(container.querySelector<HTMLElement>('[data-overflow-measure="block"]'));
    expect(summary.style.webkitLineClamp).toBe('2');
    expect(container.querySelector('button[aria-haspopup="dialog"]')).toBeNull();

    setElementSize(summary, { clientHeight: 40, scrollHeight: 180 });
    await notifyResize(summary);

    const trigger = requireElement(container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]'));
    expect(trigger.textContent).toContain('查看全文');
    expect(trigger.className).not.toContain('bg-cafe-accent');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const dialogId = trigger.getAttribute('aria-controls');
    expect(dialogId).toBeTruthy();
    const descriptionId = trigger.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    const accessibleSummary = requireElement(document.getElementById(descriptionId ?? ''));
    expect(accessibleSummary.textContent).toContain('排队消息');
    expect(accessibleSummary.textContent).not.toContain('最后一段是验证尾部仍可恢复的证据');
    expect(summary.getAttribute('aria-hidden')).toBe('true');

    await act(async () => trigger.click());

    const dialog = requireElement(document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]'));
    expect(dialog.id).toBe(dialogId);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.textContent).toContain('最后一段是验证尾部仍可恢复的证据');
    expect(dialog.className).toContain('max-h-[calc(100dvh-24px)]');
    expect(dialog.querySelector('article')?.className).toContain('overflow-y-auto');
    expect(summary.style.webkitLineClamp).toBe('2');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});
