import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => false }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      { id: 'opus', displayName: '布偶猫 Opus' },
      { id: 'codex', displayName: '缅因猫 Codex' },
    ],
  }),
}));

const { TransferTargetPicker } = await import('../TransferTargetPicker');

function thread(id: string, title: string) {
  return {
    id,
    title,
    projectPath: '/project',
    createdBy: 'user-1',
    participants: [],
    lastActiveAt: 1,
    createdAt: 1,
  };
}

describe('TransferTargetPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    useToastStore.setState({ toasts: [] });
    useChatStore.setState({
      currentThreadId: 'source-thread',
      threads: [thread('source-thread', 'Source'), thread('target-thread', 'Target')],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderPicker(onClose = vi.fn(), onSuccess = vi.fn()) {
    React.act(() => {
      root.render(
        <TransferTargetPicker
          open
          admissionBlocked={false}
          sourceThreadId="source-thread"
          items={[{ kind: 'message', messageId: 'source-message-1' }]}
          onClose={onClose}
          onSuccess={onSuccess}
        />,
      );
    });
    return { onClose, onSuccess };
  }

  function bodyButton(label: string): HTMLButtonElement {
    const match = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(label),
    );
    if (!match) throw new Error(`missing button: ${label}`);
    return match;
  }

  async function chooseTargetAndCat(catLabel = '布偶猫 Opus') {
    React.act(() => bodyButton('Target').click());
    React.act(() => bodyButton(catLabel).click());
    await Promise.resolve();
  }

  function setTextAreaValue(textarea: HTMLTextAreaElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('uses a mobile bottom sheet, exact thread/cat choices, and a success toast with target Bundle action', async () => {
    mocks.apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: 'processing', messageBundleId: 'bundle-target-1' }), { status: 200 }),
    );
    const { onSuccess } = renderPicker();
    await chooseTargetAndCat();

    expect(document.body.querySelector('[data-transfer-surface="bottom-sheet"]')).not.toBeNull();
    await React.act(async () => bodyButton('转发 1 条消息').click());

    expect(mocks.apiFetch).toHaveBeenCalledOnce();
    const request = JSON.parse(mocks.apiFetch.mock.calls[0][1].body);
    expect(request.threadId).toBe('target-thread');
    expect(request.messageBundle).toEqual({
      sourceThreadId: 'source-thread',
      items: [{ kind: 'message', messageId: 'source-message-1' }],
      targetCats: ['opus'],
    });
    expect(request.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(onSuccess).toHaveBeenCalledWith({ targetThreadId: 'target-thread', messageBundleId: 'bundle-target-1' });
    expect(useToastStore.getState().toasts[0]?.action).toEqual({
      label: '查看',
      threadId: 'target-thread',
      messageId: 'bundle-target-1',
    });
  });

  it('renders no writable surface when browser-document admission is blocked', () => {
    React.act(() => {
      root.render(
        <TransferTargetPicker
          open
          admissionBlocked
          sourceThreadId="source-thread"
          items={[{ kind: 'message', messageId: 'source-message-1' }]}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />,
      );
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('searches target threads by title before choosing a destination', () => {
    useChatStore.setState({
      threads: [
        thread('source-thread', 'Source'),
        thread('target-thread', 'Target'),
        thread('notes-thread', 'Release Notes'),
      ],
    });
    renderPicker();

    const search = document.body.querySelector('input[aria-label="搜索目标对话"]') as HTMLInputElement | null;
    expect(search).not.toBeNull();
    React.act(() => {
      if (!search) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'release');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Release Notes');
    expect(document.body.textContent).not.toContain('Target');
  });

  it('retains picker state after failure and reuses the same idempotency key for an unchanged retry', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporary' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageBundleId: 'bundle-retry' }), { status: 202 }));
    renderPicker();
    await chooseTargetAndCat();

    await React.act(async () => bodyButton('转发 1 条消息').click());
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('temporary');
    expect(document.body.querySelector('button[aria-pressed="true"]')).not.toBeNull();
    await React.act(async () => bodyButton('转发 1 条消息').click());

    const first = JSON.parse(mocks.apiFetch.mock.calls[0][1].body);
    const second = JSON.parse(mocks.apiFetch.mock.calls[1][1].body);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('rotates the idempotency key after a failed request when the semantic payload changes', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporary' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageBundleId: 'bundle-changed' }), { status: 200 }));
    renderPicker();
    await chooseTargetAndCat();
    await React.act(async () => bodyButton('转发 1 条消息').click());
    React.act(() => bodyButton('缅因猫 Codex').click());
    await React.act(async () => bodyButton('转发 1 条消息').click());

    const first = JSON.parse(mocks.apiFetch.mock.calls[0][1].body);
    const second = JSON.parse(mocks.apiFetch.mock.calls[1][1].body);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second.messageBundle.targetCats).toEqual(['codex', 'opus']);
  });

  it('keeps a bundle-level note after failure and rotates the retry key when that note changes', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporary' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageBundleId: 'bundle-note' }), { status: 200 }));
    renderPicker();
    await chooseTargetAndCat();
    const note = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="转发留言（可选）"]');
    expect(note).not.toBeNull();
    if (!note) throw new Error('note textarea did not render');
    React.act(() => setTextAreaValue(note, 'first reason'));

    await React.act(async () => bodyButton('转发 1 条消息').click());
    expect(note.value).toBe('first reason');
    React.act(() => setTextAreaValue(note, 'changed reason'));
    await React.act(async () => bodyButton('转发 1 条消息').click());

    const first = JSON.parse(mocks.apiFetch.mock.calls[0][1].body);
    const second = JSON.parse(mocks.apiFetch.mock.calls[1][1].body);
    expect(first.messageBundle.note).toBe('first reason');
    expect(second.messageBundle.note).toBe('changed reason');
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('keeps the optional note outside the independently scrollable cat roster', async () => {
    renderPicker();
    await chooseTargetAndCat();

    const note = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="转发留言（可选）"]');
    const firstCat = bodyButton('布偶猫 Opus');
    const catScroller = document.body.querySelector('[data-testid="transfer-picker-cat-scroll"]');
    expect(note).not.toBeNull();
    expect(catScroller).not.toBeNull();
    if (!note) throw new Error('note textarea did not render');
    expect(note.compareDocumentPosition(firstCat) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(note.closest('[data-testid="transfer-picker-cat-scroll"]')).toBeNull();
    expect(firstCat.closest('[data-testid="transfer-picker-cat-scroll"]')).toBe(catScroller);
  });

  it('keeps a submit failure in the fixed footer instead of below the scrollable cat roster', async () => {
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'source range changed' }), { status: 400 }));
    renderPicker();
    await chooseTargetAndCat();

    await React.act(async () => bodyButton('转发 1 条消息').click());

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('source range changed');
    expect(alert?.closest('footer')).not.toBeNull();
  });

  it('uses Escape as back on the cat step, then closes and returns focus from the thread step', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { onClose } = renderPicker();
    React.act(() => bodyButton('Target').click());

    React.act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })));
    expect(document.body.textContent).toContain('先选择一个目标对话');
    expect(onClose).not.toHaveBeenCalled();
    React.act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })));
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
