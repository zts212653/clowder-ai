import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '@/components/MessageActions';
import { MessageSelectionToolbar } from '@/components/MessageSelectionToolbar';
import { isMessageSelectableForBundle, normalizeSelectedMessageIds } from '@/components/message-selection';
import type { ChatMessage } from '@/stores/chatStore';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useTextSelectionAction', () => ({
  useTextSelectionAction: () => null,
}));

vi.mock('@/components/useMessageAnnotationMarkers', () => ({
  useMessageAnnotationMarkers: () => [],
}));

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    type: 'user',
    content: '稳定正文',
    timestamp: 1,
    ...overrides,
  };
}

describe('whole-message selection rules', () => {
  it('admits stable authored messages and rejects unstable or internal projections', () => {
    expect(isMessageSelectableForBundle(message())).toBe(true);
    expect(isMessageSelectableForBundle(message({ type: 'assistant', catId: 'opus' }))).toBe(true);
    expect(isMessageSelectableForBundle(message({ isStreaming: true }))).toBe(false);
    expect(
      isMessageSelectableForBundle(message({ extra: { recall: { version: 1, exposure: 'seen', recalledAt: 2 } } })),
    ).toBe(false);
    expect(isMessageSelectableForBundle(message({ type: 'system' }))).toBe(false);
    expect(
      isMessageSelectableForBundle(
        message({ content: '', toolEvents: [{ id: 'tool-1', type: 'tool_use', label: 'read', timestamp: 1 }] }),
      ),
    ).toBe(false);
  });

  it('normalizes the basket by timeline order instead of click order', () => {
    const messages = [
      message({ id: 'message-2', timestamp: 2 }),
      message({ id: 'message-1', timestamp: 1 }),
      message({ id: 'message-3', timestamp: 3 }),
    ];
    expect(normalizeSelectedMessageIds(messages, new Set(['message-3', 'message-1']))).toEqual([
      'message-1',
      'message-3',
    ]);
  });
});

describe('MessageActions selection entry', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
  });

  it('exposes multi-select directly without hijacking the native context menu', () => {
    const onEnterSelection = vi.fn();
    React.act(() => {
      root.render(
        <MessageActions message={message()} threadId="thread-1" selectionEligible onEnterSelection={onEnterSelection}>
          <p>message body</p>
        </MessageActions>,
      );
    });

    const select = container.querySelector('button[aria-label="多选消息"]') as HTMLButtonElement | null;
    expect(select).toBeTruthy();
    const toolbar = select?.closest('div.absolute');
    expect(toolbar?.className).toContain('opacity-100');
    expect(toolbar?.className).not.toContain('opacity-0');
    expect(toolbar?.className).toContain('top-0');
    expect(toolbar?.className).not.toContain('-translate-y-full');
    expect(container.querySelector('[data-context-quote-source="message"]')?.className).toContain('pt-8');
    const secondaryActions = toolbar?.querySelector('[data-testid="message-secondary-actions"]');
    expect(secondaryActions?.className).toContain('max-w-0');
    expect(secondaryActions?.className).toContain('opacity-0');
    expect(secondaryActions?.className).toContain('group-hover:max-w-48');
    expect(select?.className).toContain('order-2');
    expect(secondaryActions?.className).toContain('order-1');
    React.act(() => select?.click());
    expect(onEnterSelection).toHaveBeenCalledWith('message-1');

    onEnterSelection.mockClear();
    const source = container.querySelector('[data-context-quote-source="message"]');
    expect(source).toBeTruthy();
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    React.act(() => source?.dispatchEvent(contextMenu));
    expect(contextMenu.defaultPrevented).toBe(false);
    expect(onEnterSelection).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('reserves the assistant-side primary entry without applying the user-side order inversion', () => {
    React.act(() => {
      root.render(
        <MessageActions
          message={message({ type: 'assistant', catId: 'opus' })}
          threadId="thread-1"
          selectionEligible
          onEnterSelection={vi.fn()}
        >
          <p>assistant message body</p>
        </MessageActions>,
      );
    });

    const select = container.querySelector('button[aria-label="多选消息"]') as HTMLButtonElement | null;
    const toolbar = select?.closest('div.absolute');
    const secondaryActions = toolbar?.querySelector('[data-testid="message-secondary-actions"]');

    expect(toolbar?.className).toContain('opacity-100');
    expect(toolbar?.className).toContain('top-0');
    expect(toolbar?.className).toContain('left-10');
    expect(toolbar?.className).not.toContain('right-10');
    expect(toolbar?.className).not.toContain('-translate-y-full');
    expect(container.querySelector('[data-context-quote-source="message"]')?.className).toContain('pt-8');
    expect(select?.className).not.toContain('order-2');
    expect(secondaryActions?.className).not.toContain('order-1');
  });

  it('expands secondary actions when keyboard focus enters the visible primary control', () => {
    React.act(() => {
      root.render(
        <MessageActions message={message()} threadId="thread-1" selectionEligible onEnterSelection={vi.fn()}>
          <p>message body</p>
        </MessageActions>,
      );
    });

    const select = container.querySelector('button[aria-label="多选消息"]') as HTMLButtonElement | null;
    const toolbar = select?.closest('div.absolute');
    const secondaryActions = toolbar?.querySelector('[data-testid="message-secondary-actions"]');

    React.act(() => select?.focus());

    expect(document.activeElement).toBe(select);
    expect(toolbar?.matches(':focus-within')).toBe(true);
    expect(secondaryActions?.className).toContain('group-focus-within:max-w-48');
    expect(secondaryActions?.className).toContain('group-focus-within:pointer-events-auto');
    expect(secondaryActions?.className).toContain('group-focus-within:opacity-100');
  });

  it('places every selection checkbox in a sender-independent leading gutter', () => {
    const onToggleSelection = vi.fn();
    React.act(() => {
      root.render(
        <MessageActions
          message={message()}
          threadId="thread-1"
          selectionMode
          selected
          selectionEligible
          onToggleSelection={onToggleSelection}
        >
          <p>user message body</p>
        </MessageActions>,
      );
    });

    const userRow = container.querySelector('[data-context-quote-source="message"]');
    const userCheckbox = container.querySelector('[role="checkbox"]') as HTMLButtonElement | null;
    expect(userRow?.getAttribute('data-selection-layout')).toBe('leading-gutter');
    expect(userRow?.className).toContain('pl-12');
    expect(userCheckbox?.className).toContain('left-2');
    expect(userCheckbox?.className).not.toContain('right-1');

    React.act(() => {
      root.render(
        <MessageActions
          message={message({ type: 'assistant', catId: 'opus' })}
          threadId="thread-1"
          selectionMode
          selected={false}
          selectionEligible
          onToggleSelection={onToggleSelection}
        >
          <p>assistant message body</p>
        </MessageActions>,
      );
    });

    const assistantRow = container.querySelector('[data-context-quote-source="message"]');
    const assistantCheckbox = container.querySelector('[role="checkbox"]') as HTMLButtonElement | null;
    expect(assistantRow?.getAttribute('data-selection-layout')).toBe('leading-gutter');
    expect(assistantRow?.className).toContain('pl-12');
    expect(assistantCheckbox?.className).toContain('left-2');
    expect(assistantCheckbox?.className).not.toContain('right-1');
  });

  it('keeps the lower-frequency branch action in the more-actions menu', () => {
    React.act(() => {
      root.render(
        <MessageActions message={message()} threadId="thread-1" selectionEligible onEnterSelection={vi.fn()}>
          <p>message body</p>
        </MessageActions>,
      );
    });

    expect(container.querySelector('button[title="从这里分支"]')).toBeNull();
    const more = container.querySelector('button[aria-label="更多消息操作"]') as HTMLButtonElement;
    React.act(() => more.click());
    expect(
      Array.from(document.querySelectorAll('[role="menuitem"]')).some((item) =>
        item.textContent?.includes('从这里分支'),
      ),
    ).toBe(true);
  });
});

describe('MessageSelectionToolbar', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalCreateObjectUrl: typeof URL.createObjectURL;
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;

  beforeEach(() => {
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalCreateObjectUrl = URL.createObjectURL;
    originalRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:selection');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    vi.restoreAllMocks();
  });

  function renderToolbar(overrides: Partial<React.ComponentProps<typeof MessageSelectionToolbar>> = {}) {
    const props: React.ComponentProps<typeof MessageSelectionToolbar> = {
      threadId: 'thread-1',
      selectedMessageIds: ['message-1', 'message-2'],
      onCancel: vi.fn(),
      onExportSuccess: vi.fn(),
      ...overrides,
    };
    React.act(() => root.render(<MessageSelectionToolbar {...props} />));
    return props;
  }

  function button(label: string): HTMLButtonElement {
    const match = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (!match) throw new Error(`button not found: ${label}`);
    return match;
  }

  it('uses a compact icon dock instead of a row of developer-facing text pills', () => {
    renderToolbar();

    const toolbar = container.querySelector('[data-testid="message-selection-toolbar"]');
    expect(toolbar?.getAttribute('data-selection-layout')).toBe('action-dock');
    for (const label of ['文档', '文本', '长图', '转发', '取消']) {
      const action = button(label);
      expect(action.className).toContain('flex-col');
      expect(action.querySelector('svg')).toBeTruthy();
    }
    expect(container.textContent).not.toContain('退出多选');
    expect(container.textContent).not.toContain('Markdown');
    expect(container.textContent).not.toContain('TXT');
    expect(container.textContent).not.toContain('PNG');
  });

  it('exports Markdown with exact ordered refs and clears only after success', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response('# selection', { status: 200 }));
    const props = renderToolbar();

    await React.act(async () => button('文档').click());

    expect(apiFetchMock).toHaveBeenCalledWith('/api/export/thread/thread-1/selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'md',
        items: [
          { kind: 'message', messageId: 'message-1' },
          { kind: 'message', messageId: 'message-2' },
        ],
      }),
    });
    expect(props.onExportSuccess).toHaveBeenCalledOnce();
  });

  it('preserves the basket and explains a failed export', async () => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'source_unavailable' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const props = renderToolbar();

    await React.act(async () => button('文本').click());

    expect(props.onExportSuccess).not.toHaveBeenCalled();
    expect(container.textContent).toContain('source_unavailable');
    expect(container.textContent).toContain('已选 2 条');
  });

  it('uses the selective image endpoint and exposes the Phase B forward exit', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(new Blob(['png']), { status: 200 }));
    renderToolbar();

    await React.act(async () => button('长图').click());

    expect(apiFetchMock).toHaveBeenCalledWith('/api/threads/thread-1/export-selection-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          { kind: 'message', messageId: 'message-1' },
          { kind: 'message', messageId: 'message-2' },
        ],
      }),
    });
    expect(button('转发').disabled).toBe(true);
  });

  it('cancels without issuing an export request', () => {
    const props = renderToolbar();
    React.act(() => button('取消').click());
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
