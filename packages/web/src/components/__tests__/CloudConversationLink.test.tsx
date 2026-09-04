import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { CloudConversationLink } from '@/components/CloudConversationLink';
import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('CloudConversationLink', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: Clipboard }).clipboard;
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows the bound ChatGPT conversation and offers exact copy and user-initiated open actions', async () => {
    const conversationId = '6a928d55-ed7c-83ee-adbf-56bef0ffe336';
    const chatUrl = `https://chatgpt.com/c/${conversationId}`;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mockApiFetch.mockResolvedValue(jsonResponse({ bindings: { 'gpt-pro': chatUrl } }));

    await act(async () => root.render(<CloudConversationLink threadId="thread-owner" />));
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread-owner/cloud-bindings', expect.any(Object));
    expect(container.textContent).toContain(conversationId);

    const openLink = container.querySelector<HTMLAnchorElement>('a[aria-label="在 ChatGPT 中打开当前会话"]');
    expect(openLink?.getAttribute('href')).toBe(chatUrl);
    expect(openLink?.getAttribute('target')).toBe('_blank');
    expect(openLink?.getAttribute('rel')).toBe('noopener noreferrer');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="复制 ChatGPT 会话链接"]')?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(chatUrl);
    expect(container.textContent).toContain('已复制');
  });

  it('keeps the thread truth visible when no ChatGPT conversation is bound', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ bindings: {} }));

    await act(async () => root.render(<CloudConversationLink threadId="thread-empty" />));
    await flushEffects();

    expect(container.textContent).toContain('未绑定');
    expect(container.textContent).toContain('ChatGPT Conversation');
    expect(container.textContent).toContain('先在目标会话点击扩展的「授权此会话」');
    expect(container.querySelector('a[href="https://chatgpt.com/"]')).not.toBeNull();
    expect(container.querySelector('a[href="/settings?s=plugins#personal-chatgpt-pro"]')).not.toBeNull();
    expect(container.querySelector('a[aria-label="在 ChatGPT 中打开当前会话"]')).toBeNull();
  });

  it('does not let a delayed prior-thread binding overwrite the current thread', async () => {
    let resolveOldBinding!: (body: { bindings: { 'gpt-pro': string } }) => void;
    const oldBindingBody = new Promise<{ bindings: { 'gpt-pro': string } }>((resolve) => {
      resolveOldBinding = resolve;
    });
    mockApiFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => oldBindingBody,
      } as Response)
      .mockResolvedValueOnce(jsonResponse({ bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-new' } }));

    await act(async () => root.render(<CloudConversationLink threadId="thread-old" />));
    await flushEffects();
    await act(async () => root.render(<CloudConversationLink threadId="thread-new" />));
    await flushEffects();
    expect(container.textContent).toContain('conversation-new');

    resolveOldBinding({ bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-old' } });
    await flushEffects();

    expect(container.textContent).toContain('conversation-new');
    expect(container.textContent).not.toContain('conversation-old');
  });

  it('does not let a delayed prior-thread copy completion update the current thread', async () => {
    let resolveOldCopy!: () => void;
    const oldCopy = new Promise<void>((resolve) => {
      resolveOldCopy = resolve;
    });
    const writeText = vi.fn().mockReturnValueOnce(oldCopy);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse({ bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-old' } }))
      .mockResolvedValueOnce(jsonResponse({ bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-new' } }));

    await act(async () => root.render(<CloudConversationLink threadId="thread-old" />));
    await flushEffects();
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="复制 ChatGPT 会话链接"]')?.click();
    });
    expect(writeText).toHaveBeenCalledWith('https://chatgpt.com/c/conversation-old');

    await act(async () => root.render(<CloudConversationLink threadId="thread-new" />));
    await flushEffects();
    expect(container.textContent).toContain('conversation-new');
    expect(container.textContent).toContain('复制链接');

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await act(async () => resolveOldCopy());
    await flushEffects();

    expect(container.textContent).toContain('conversation-new');
    expect(container.textContent).toContain('复制链接');
    expect(container.textContent).not.toContain('已复制');
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('does not let a delayed prior-thread copy failure update the current thread', async () => {
    let rejectOldCopy!: (error: Error) => void;
    const oldCopy = new Promise<void>((_resolve, reject) => {
      rejectOldCopy = reject;
    });
    const writeText = vi.fn().mockReturnValueOnce(oldCopy);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse({ bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-old' } }))
      .mockResolvedValueOnce(jsonResponse({ bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-new' } }));

    await act(async () => root.render(<CloudConversationLink threadId="thread-old" />));
    await flushEffects();
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="复制 ChatGPT 会话链接"]')?.click();
    });

    await act(async () => root.render(<CloudConversationLink threadId="thread-new" />));
    await flushEffects();
    expect(container.textContent).toContain('conversation-new');

    await act(async () => rejectOldCopy(new Error('old clipboard failed')));
    await flushEffects();

    expect(container.textContent).toContain('conversation-new');
    expect(container.textContent).toContain('复制链接');
    expect(container.textContent).not.toContain('复制失败');
  });

  it('does not leak owner-only binding truth to an unauthorized viewer', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));

    await act(async () => root.render(<CloudConversationLink threadId="thread-foreign" />));
    await flushEffects();

    expect(container.textContent).toContain('仅 thread owner 可见');
    expect(container.querySelector('a')).toBeNull();
  });

  it('refuses to turn a non-canonical binding value into a clickable link', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ bindings: { 'gpt-pro': 'https://example.com/not-chatgpt' } }));

    await act(async () => root.render(<CloudConversationLink threadId="thread-invalid" />));
    await flushEffects();

    expect(container.textContent).toContain('绑定记录无效');
    expect(container.querySelector('a[aria-label="在 ChatGPT 中打开当前会话"]')).toBeNull();
    expect(container.querySelector('a[href="/settings?s=plugins#personal-chatgpt-pro"]')).not.toBeNull();
  });
});
