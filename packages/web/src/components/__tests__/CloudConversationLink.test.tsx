import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { CloudConversationLink } from '@/components/CloudConversationLink';
import { apiFetch } from '@/utils/api-client';
import {
  buttonByText,
  candidate,
  FakeHost,
  flush,
  gate,
  jsonResponse,
  REVIEW,
  STARS,
} from './cloud-route-test-fixtures';

const mockApiFetch = vi.mocked(apiFetch);

/**
 * Two threads, each connected to its own conversation. Both conversations are authorized — the list is
 * the extension's, the same for every thread — and have no title, so the panel shows their ids.
 */
function connectedThreads(): [FakeHost, FakeHost] {
  const conversations = [candidate('conversation-old'), candidate('conversation-new')];
  return conversations.map((conversation) => {
    const host = new FakeHost(conversation.conversationId.replace('conversation', 'thread'));
    host.bindings = { 'gpt-pro': conversation.chatUrl };
    host.candidates = conversations;
    return host;
  }) as [FakeHost, FakeHost];
}

function serve(...hosts: FakeHost[]) {
  mockApiFetch.mockImplementation(async (path, init, options) => {
    for (const host of hosts) {
      const answer = host.handle(path, init, options);
      if (answer) return answer;
    }
    return jsonResponse({ error: 'not found' }, 404);
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

  async function render(threadId: string) {
    await act(async () => root.render(<CloudConversationLink threadId={threadId} />));
    await flush();
  }

  it('folds to the connected conversation with open, copy and change', async () => {
    const host = new FakeHost('thread-owner');
    host.bindings = { 'gpt-pro': STARS.chatUrl };
    serve(host);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await render('thread-owner');

    expect(container.textContent).toContain('ChatGPT 会话 @gpt-pro');
    expect(container.textContent).toContain('已连接');
    expect(container.textContent).toContain(STARS.displayTitle);
    const open = [...container.querySelectorAll<HTMLAnchorElement>('a')].find((a) => a.textContent === '打开会话');
    expect(open?.getAttribute('href')).toBe(STARS.chatUrl);
    expect(open?.getAttribute('target')).toBe('_blank');
    expect(open?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(buttonByText(container, '更换')).toBeDefined();
    expect(container.querySelector('input[type="radio"]')).toBeNull();

    await act(async () => buttonByText(container, '复制链接')?.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith(STARS.chatUrl);
    expect(container.textContent).toContain('已复制');
  });

  it('offers the authorized conversations right away when the thread has none', async () => {
    serve(new FakeHost('thread-empty'));

    await render('thread-empty');

    expect(container.textContent).toContain('未连接');
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(buttonByText(container, '连接这个会话')?.disabled).toBe(true);
    expect(buttonByText(container, '断开连接')).toBeUndefined();
  });

  it('guides the owner to authorize a conversation when there is none', async () => {
    const host = new FakeHost('thread-empty');
    host.candidates = [];
    serve(host);

    await render('thread-empty');

    expect(container.textContent).toContain('未连接');
    expect(container.textContent).toContain('还没有已授权的会话');
    expect(container.querySelector('a[href="https://chatgpt.com/"]')).not.toBeNull();
    expect(container.querySelector('input[type="radio"]')).toBeNull();
  });

  it('no longer sends the owner to the settings page for anything', async () => {
    for (const binding of [undefined, STARS.chatUrl, 'https://example.com/not-chatgpt']) {
      const host = new FakeHost(`thread-${binding ?? 'none'}`);
      if (binding) host.bindings = { 'gpt-pro': binding };
      serve(host);
      await render(host.threadId);
      expect(container.querySelector('a[href^="/settings"]')).toBeNull();
    }
  });

  it('does not let a delayed prior-thread binding overwrite the current thread', async () => {
    const oldHost = new FakeHost('thread-old');
    oldHost.bindings = { 'gpt-pro': 'https://chatgpt.com/c/conversation-old' };
    const held = gate();
    oldHost.readPlan = [{ gate: held.promise }];
    const newHost = new FakeHost('thread-new');
    newHost.bindings = { 'gpt-pro': 'https://chatgpt.com/c/conversation-new' };
    serve(oldHost, newHost);

    await render('thread-old');
    await render('thread-new');
    expect(container.textContent).toContain('conversation-new');

    held.open();
    await flush();

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
    const [oldHost, newHost] = connectedThreads();
    serve(oldHost, newHost);

    await render('thread-old');
    act(() => buttonByText(container, '复制链接')?.click());
    expect(writeText).toHaveBeenCalledWith('https://chatgpt.com/c/conversation-old');

    await render('thread-new');
    expect(container.textContent).toContain('conversation-new');

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await act(async () => resolveOldCopy());
    await flush();

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
    const [oldHost, newHost] = connectedThreads();
    serve(oldHost, newHost);

    await render('thread-old');
    act(() => buttonByText(container, '复制链接')?.click());
    await render('thread-new');

    await act(async () => rejectOldCopy(new Error('old clipboard failed')));
    await flush();

    expect(container.textContent).toContain('conversation-new');
    expect(container.textContent).toContain('复制链接');
    expect(container.textContent).not.toContain('复制失败');
  });

  it('shows only that the conversation is the owner’s to see, with no actions', async () => {
    mockApiFetch.mockImplementation(async (path) =>
      String(path).endsWith('/cloud-bindings') ? jsonResponse({ error: 'forbidden' }, 403) : jsonResponse({}, 403),
    );

    await render('thread-foreign');

    expect(container.textContent).toContain('仅对话所有者可见');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('refuses to turn a non-canonical binding value into a link, and offers a new choice', async () => {
    const host = new FakeHost('thread-invalid');
    host.bindings = { 'gpt-pro': 'https://example.com/not-chatgpt' };
    serve(host);

    await render('thread-invalid');

    expect(container.textContent).toContain('连接记录无效');
    expect(container.querySelector('a[href="https://example.com/not-chatgpt"]')).toBeNull();
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(buttonByText(container, '连接这个会话')).toBeDefined();
  });

  // F202 h3c-2 — the panel shows the binding of the cat the Host resolves as the cloud cat.
  it('reads the binding of the configured cloud cat, whatever its id', async () => {
    const host = new FakeHost('thread-alt');
    host.cloudCat = { status: 'resolved', catId: 'cloud-alt' };
    host.bindings = { 'cloud-alt': REVIEW.chatUrl, 'gpt-pro': STARS.chatUrl };
    serve(host);

    await render('thread-alt');

    expect(container.textContent).toContain('@cloud-alt');
    expect(container.textContent).toContain(REVIEW.displayTitle);
    expect(container.textContent).not.toContain(STARS.displayTitle);
  });

  it.each([
    ['no cloud cat is configured', { status: 'unavailable' }],
    ['several cats share the cloud provider', { status: 'ambiguous', catIds: ['cloud-alt', 'cloud-beta'] }],
  ])('shows nothing when %s', async (_case, cloudCat) => {
    const host = new FakeHost('thread-none');
    host.cloudCat = cloudCat;
    host.bindings = { 'cloud-alt': STARS.chatUrl };
    serve(host);

    await render('thread-none');

    expect(container.querySelector('[data-testid="cloud-conversation-link"]')).toBeNull();
  });
});
