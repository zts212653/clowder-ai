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

  it('offers visible managed-hold receipts but keeps other connector and hidden scheduler rows out', () => {
    const managedReceipt = message({
      type: 'connector',
      extra: { queueReceipt: { version: 1, entryId: 'entry-1', targets: [], reminderAttempts: [] } },
      source: {
        connector: 'hold-ball',
        label: '持球结果',
        icon: '🏓',
        meta: { taskId: 'hold-ball-task-1', threadId: 'thread-source', catId: 'opus5', wakeWhen: true },
      },
    });

    expect(isMessageSelectableForBundle(managedReceipt)).toBe(true);
    expect(isMessageSelectableForBundle({ ...managedReceipt, extra: undefined })).toBe(false);
    expect(
      isMessageSelectableForBundle({
        ...managedReceipt,
        extra: {
          queueReceipt: { version: 1, entryId: 'entry-1', targets: [], reminderAttempts: [] },
          scheduler: { hiddenTrigger: true },
        },
      }),
    ).toBe(false);
    expect(
      isMessageSelectableForBundle({
        ...managedReceipt,
        extra: {
          queueReceipt: { version: 1, entryId: 'entry-1', targets: [], reminderAttempts: [] },
          scheduler: {},
        },
      }),
    ).toBe(true);
    expect(
      isMessageSelectableForBundle(
        message({
          type: 'connector',
          source: { connector: 'github', label: 'GitHub', icon: '🐙' },
        }),
      ),
    ).toBe(false);
    expect(
      isMessageSelectableForBundle(
        message({
          type: 'system',
          extra: { scheduler: { hiddenTrigger: true } },
        }),
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

function classTokens(element: Element | null | undefined): string[] {
  return (element?.className ?? '').split(/\s+/).filter(Boolean);
}

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

  it('keeps message actions out of the resting layout and off the native context menu', () => {
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
    // At rest the toolbar is neither painted nor clickable, and reserves no row of its own.
    expect(toolbar?.className).toContain('opacity-0');
    expect(toolbar?.className).toContain('pointer-events-none');
    expect(toolbar?.className).toContain('group-hover:opacity-100');
    expect(toolbar?.className).toContain('group-focus-within:opacity-100');
    expect(toolbar?.className).toContain('-translate-y-full');
    // The reserved row is media-gated, not unconditional: pointer devices get no row at all,
    // while touch-only devices keep one because they have no hover to reveal the toolbar.
    const hostTokens = classTokens(container.querySelector('[data-context-quote-source="message"]'));
    expect(hostTokens).not.toContain('pt-8');
    expect(hostTokens).toContain('[@media(hover:none)_and_(pointer:coarse)]:pt-8');
    expect(toolbar?.className).toContain('[@media(hover:none)_and_(pointer:coarse)]:opacity-100');
    expect(toolbar?.className).toContain('[@media(hover:none)_and_(pointer:coarse)]:pointer-events-auto');
    const secondaryActions = toolbar?.querySelector('[data-testid="message-secondary-actions"]');
    // Selection joins the existing message actions: the whole group is revealed together,
    // with no second collapse animation and no displaced reply/delete/more controls.
    expect(secondaryActions?.className).not.toContain('max-w-0');
    expect(toolbar?.querySelector('button[title="引用回复"]')).not.toBeNull();
    expect(toolbar?.querySelector('button[title="删除"]')).not.toBeNull();
    expect(toolbar?.querySelector('button[aria-label="更多消息操作"]')).not.toBeNull();
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

  it('keeps the assistant-side toolbar clear of the avatar without reserving layout', () => {
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

    expect(toolbar?.className).toContain('opacity-0');
    expect(toolbar?.className).toContain('left-10');
    expect(toolbar?.className).not.toContain('right-10');
    expect(toolbar?.className).toContain('-translate-y-full');
    expect(classTokens(container.querySelector('[data-context-quote-source="message"]'))).not.toContain('pt-8');
  });

  it('reveals the toolbar for keyboard users when focus enters the message', () => {
    React.act(() => {
      root.render(
        <MessageActions message={message()} threadId="thread-1" selectionEligible onEnterSelection={vi.fn()}>
          <p>message body</p>
        </MessageActions>,
      );
    });

    const select = container.querySelector('button[aria-label="多选消息"]') as HTMLButtonElement | null;
    const toolbar = select?.closest('div.absolute');

    React.act(() => select?.focus());

    expect(document.activeElement).toBe(select);
    expect(toolbar?.matches(':focus-within')).toBe(true);
    expect(toolbar?.className).toContain('group-focus-within:pointer-events-auto');
    expect(toolbar?.className).toContain('group-focus-within:opacity-100');
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
      forwardingDisabled: false,
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

  it('keeps exports usable but disables forwarding until the browser document is admitted', () => {
    const onForward = vi.fn();
    renderToolbar({ onForward, forwardingDisabled: true });

    expect(button('文档').disabled).toBe(false);
    expect(button('文本').disabled).toBe(false);
    expect(button('长图').disabled).toBe(false);
    expect(button('转发').disabled).toBe(true);
    expect(button('取消').disabled).toBe(false);
    expect(button('转发').title).toBe('正在验证页面版本，暂不可转发');

    React.act(() => button('转发').click());
    expect(onForward).not.toHaveBeenCalled();

    renderToolbar({ onForward, forwardingDisabled: false });
    expect(button('转发').disabled).toBe(false);
    React.act(() => button('转发').click());
    expect(onForward).toHaveBeenCalledOnce();
  });

  it('cancels without issuing an export request', () => {
    const props = renderToolbar();
    React.act(() => button('取消').click());
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
