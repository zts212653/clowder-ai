/**
 * F264 UX: true recall and Queue custody withdrawal are different actions.
 */
import type { MessageContent } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const NOW = Date.now();

const QUEUED_ENTRY: QueueEntry = {
  id: 'q1',
  threadId: 'thread-1',
  userId: 'u1',
  content: 'queued to withdraw',
  messageId: 'm1',
  mergedMessageIds: [],
  source: 'user',
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: NOW,
};

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function recallAck(
  options: {
    messageId?: string;
    text?: string;
    contentBlocks?: MessageContent[];
    replyTo?: string;
    verdict?: 'zero_exposure' | 'exposed';
  } = {},
) {
  const text = options.text ?? 'queued to withdraw';
  return {
    verdict: options.verdict ?? 'zero_exposure',
    message: {
      id: options.messageId ?? 'm1',
      threadId: 'thread-1',
      recall: { version: 1, exposure: options.verdict === 'exposed' ? 'seen' : 'none', recalledAt: NOW },
    },
    draft: {
      version: 1,
      ownerUserId: 'u1',
      threadId: 'thread-1',
      revision: 1,
      text,
      ...(options.contentBlocks ? { contentBlocks: options.contentBlocks } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      updatedAt: NOW,
    },
    insertedRange: { start: 0, end: text.length },
    queue: [],
  };
}

describe('QueuePanel withdraw UX (F39)', () => {
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

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useChatStore.setState({
      messages: [],
      queue: [],
      queuePaused: false,
      currentThreadId: 'thread-1',
    });
    useToastStore.setState({ toasts: [] });
    const { apiFetch } = await import('@/utils/api-client');
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-1/composer-draft') return response({ draft: null, revision: 0 }) as Response;
      if (url === '/api/messages/m1/recall' && init?.method === 'POST') return response(recallAck()) as Response;
      return response({}) as Response;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('removes entry from QueuePanel immediately after successful withdraw and shows toast', async () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY] });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.innerHTML).toContain('queued to withdraw');

    const removeBtn = container.querySelector('button[aria-label="停止后续处理"]') as HTMLButtonElement | null;
    expect(removeBtn).not.toBeNull();

    await act(async () => {
      removeBtn?.click();
    });

    expect(useChatStore.getState().queue).toHaveLength(0);
    expect(container.innerHTML).toBe('');

    const toasts = useToastStore.getState().toasts;
    expect(
      toasts.some((t) => t.title === '已停止后续处理' && t.message === '原消息与已经发生的读取事实仍保留在历史中'),
    ).toBe(true);
  });

  it('withdraws entry and queues its text for composer recall-edit', async () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY], pendingChatInsert: null });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const recallBtn = container.querySelector('button[aria-label="撤回并重新编辑"]') as HTMLButtonElement | null;
    expect(recallBtn).not.toBeNull();

    await act(async () => {
      recallBtn?.click();
    });

    expect(useChatStore.getState().queue).toHaveLength(0);
    expect(useChatStore.getState().pendingChatInsert).toEqual({
      threadId: 'thread-1',
      text: 'queued to withdraw',
      authoritative: true,
      serverRevision: 1,
      selectionRange: { start: 0, end: 18 },
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.title === '已撤回并回填输入框')).toBe(true);
  });

  it('recall-edit includes imageUrls from messagePreview (#706 server-enriched)', async () => {
    // #706: Image URLs come from entry.messagePreview.contentBlocks,
    // enriched by server at queue_updated SSE emit time — available
    // in queue state before the DELETE request is even sent.
    const entryWithImage: QueueEntry = {
      ...QUEUED_ENTRY,
      id: 'q-img',
      messageId: 'm-img',
      messagePreview: {
        contentBlocks: [
          { type: 'text', text: 'queued to withdraw' },
          { type: 'image', url: '/uploads/img.png' },
        ],
      },
    };
    useChatStore.setState({
      queue: [entryWithImage],
      pendingChatInsert: null,
      messages: [], // deliberately empty — simulates F117 skip-optimistic-insert
    });
    const { apiFetch } = await import('@/utils/api-client');
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-1/composer-draft') return response({ draft: null, revision: 0 }) as Response;
      if (url === '/api/messages/m-img/recall' && init?.method === 'POST') {
        return response(
          recallAck({
            messageId: 'm-img',
            contentBlocks: [{ type: 'image', url: '/uploads/img.png' }],
          }),
        ) as Response;
      }
      return response({}) as Response;
    });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    // #706: Recall-edit button should appear even for messages with images
    const recallBtn = container.querySelector('button[aria-label="撤回并重新编辑"]') as HTMLButtonElement | null;
    expect(recallBtn).not.toBeNull();

    await act(async () => {
      recallBtn?.click();
    });

    expect(useChatStore.getState().queue).toHaveLength(0);
    expect(useChatStore.getState().pendingChatInsert).toEqual({
      threadId: 'thread-1',
      text: 'queued to withdraw',
      authoritative: true,
      serverRevision: 1,
      selectionRange: { start: 0, end: 18 },
      imageUrls: ['/uploads/img.png'],
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.title === '已撤回并回填输入框')).toBe(true);
  });

  it('recall-edit preserves replyTo from messagePreview (#706 + #833)', async () => {
    // #706 Phase 2: recall-edit passes replyToId through ComposerDraftInsert
    // so ChatInput can restore quote composing state via setReplyTo.
    const entryWithReply: QueueEntry = {
      ...QUEUED_ENTRY,
      id: 'q-reply',
      messageId: 'm-reply',
      messagePreview: {
        contentBlocks: [{ type: 'text', text: 'replying' }],
        replyTo: 'msg-original-123',
      },
    };
    useChatStore.setState({
      queue: [entryWithReply],
      pendingChatInsert: null,
      messages: [],
    });
    const { apiFetch } = await import('@/utils/api-client');
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-1/composer-draft') return response({ draft: null, revision: 0 }) as Response;
      if (url === '/api/messages/m-reply/recall' && init?.method === 'POST') {
        return response(recallAck({ messageId: 'm-reply', replyTo: 'msg-original-123' })) as Response;
      }
      return response({}) as Response;
    });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const recallBtn = container.querySelector('button[aria-label="撤回并重新编辑"]') as HTMLButtonElement | null;
    expect(recallBtn).not.toBeNull();

    await act(async () => {
      recallBtn?.click();
    });

    expect(useChatStore.getState().pendingChatInsert).toEqual({
      threadId: 'thread-1',
      text: 'queued to withdraw',
      authoritative: true,
      serverRevision: 1,
      selectionRange: { start: 0, end: 18 },
      replyToId: 'msg-original-123',
    });
  });

  it('recall-edit restores structured context attachments from the authoritative draft ACK', async () => {
    const attachment = {
      v: 1 as const,
      id: 'ctx-queue-thread',
      kind: 'thread' as const,
      threadId: 'thread-source',
      title: 'Source Thread',
    };
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          id: 'q-context',
          messagePreview: {
            contentBlocks: [{ type: 'context_attachment', attachment }],
          },
        },
      ],
      pendingChatInsert: null,
    });
    const { apiFetch } = await import('@/utils/api-client');
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/threads/thread-1/composer-draft') return response({ draft: null, revision: 0 }) as Response;
      if (url === '/api/messages/m1/recall' && init?.method === 'POST') {
        return response(recallAck({ contentBlocks: [{ type: 'context_attachment', attachment }] })) as Response;
      }
      return response({}) as Response;
    });
    act(() => root.render(React.createElement(QueuePanel, { threadId: 'thread-1' })));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="撤回并重新编辑"]')?.click();
    });

    expect(useChatStore.getState().pendingChatInsert).toEqual({
      threadId: 'thread-1',
      text: 'queued to withdraw',
      authoritative: true,
      serverRevision: 1,
      selectionRange: { start: 0, end: 18 },
      contextAttachments: [attachment],
    });
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe('已撤回并回填输入框');
  });

  it('recall-edit with replyToId triggers setReplyTo when parent message exists (#706 Phase 2)', () => {
    // #706 Phase 2: parent in store → full preview content
    const parentMessage = {
      id: 'msg-original-123',
      content: 'I am the quoted parent',
      catId: 'opus',
      userId: null,
      threadId: 'thread-1',
      timestamp: NOW - 1000,
      type: 'assistant' as const,
    };
    useChatStore.setState({
      messages: [parentMessage],
      replyToMessage: null,
    });

    // Simulate ChatInput's useEffect logic
    const replyToId = 'msg-original-123';
    const { messages: storeMessages, setReplyTo } = useChatStore.getState();
    const parentMsg = storeMessages.find((m) => m.id === replyToId);

    setReplyTo({
      id: replyToId,
      content: parentMsg?.content ?? '(原消息未加载)',
      senderCatId: parentMsg?.catId ?? null,
      threadId: 'thread-1',
    });

    expect(useChatStore.getState().replyToMessage).toEqual({
      id: 'msg-original-123',
      content: 'I am the quoted parent',
      senderCatId: 'opus',
      threadId: 'thread-1',
    });
  });

  it('recall-edit with replyToId still sets replyTo when parent not in store (#706 Phase 2 fallback)', () => {
    // #706 Phase 2 edge case: parent message not loaded (e.g. page reload
    // with partial history). replyTo ID must still be preserved so the
    // re-sent message keeps its quote relationship on the server.
    useChatStore.setState({
      messages: [], // parent not in store
      replyToMessage: null,
    });

    const replyToId = 'msg-not-loaded-456';
    const { messages: storeMessages, setReplyTo } = useChatStore.getState();
    const parentMsg = storeMessages.find((m) => m.id === replyToId);

    setReplyTo({
      id: replyToId,
      content: parentMsg?.content ?? '(原消息未加载)',
      senderCatId: parentMsg?.catId ?? null,
      threadId: 'thread-1',
    });

    const replyState = useChatStore.getState().replyToMessage;
    expect(replyState).toEqual({
      id: 'msg-not-loaded-456',
      content: '(原消息未加载)',
      senderCatId: null,
      threadId: 'thread-1',
    });
    // Key: replyState.id is set → onSend will pass it as replyTo
    expect(replyState?.id).toBe('msg-not-loaded-456');
  });

  it('rolls back queue state and does not queue composer insert when recall-edit fails', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    (apiFetch as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(async () => ({
      ok: false,
      json: async () => ({ error: 'nope' }),
    }));

    useChatStore.setState({ queue: [QUEUED_ENTRY], pendingChatInsert: null });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const recallBtn = container.querySelector('button[aria-label="撤回并重新编辑"]') as HTMLButtonElement | null;
    expect(recallBtn).not.toBeNull();

    await act(async () => {
      recallBtn?.click();
    });

    expect(useChatStore.getState().queue).toHaveLength(1);
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    expect(container.innerHTML).toContain('queued to withdraw');

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'error' && t.title === '撤回并重新编辑失败')).toBe(true);
  });

  it('rolls back queue state and does not queue composer insert when recall-edit throws', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    (apiFetch as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(async () => {
      throw new Error('network down');
    });

    useChatStore.setState({ queue: [QUEUED_ENTRY], pendingChatInsert: null });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const recallBtn = container.querySelector('button[aria-label="撤回并重新编辑"]') as HTMLButtonElement | null;
    expect(recallBtn).not.toBeNull();

    await act(async () => {
      recallBtn?.click();
    });

    expect(useChatStore.getState().queue).toHaveLength(1);
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    expect(container.innerHTML).toContain('queued to withdraw');

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'error' && t.title === '撤回并重新编辑失败')).toBe(true);
  });

  it('rolls back queue state and shows error toast when withdraw fails', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    (apiFetch as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(async () => ({
      ok: false,
      json: async () => ({ error: 'nope' }),
    }));

    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const removeBtn = container.querySelector('button[aria-label="停止后续处理"]') as HTMLButtonElement | null;
    expect(removeBtn).not.toBeNull();

    await act(async () => {
      removeBtn?.click();
    });

    // Should rollback, still visible
    expect(useChatStore.getState().queue).toHaveLength(1);
    expect(container.innerHTML).toContain('queued to withdraw');

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'error' && t.title === '停止失败')).toBe(true);
  });

  it('hydrates the authoritative remaining queue when clearing only partially succeeds', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    const remaining = { ...QUEUED_ENTRY, id: 'q-remaining', content: 'still actionable' };
    (apiFetch as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(async () => ({
      ok: false,
      json: async () => ({
        error: '只撤出了部分消息；其余消息仍保留在待处理队列中',
        code: 'QUEUE_WITHDRAWAL_PARTIAL',
        queue: [remaining],
      }),
    }));
    useChatStore.setState({ queue: [QUEUED_ENTRY, remaining] });

    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });
    const clearBtn = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('全部停止'),
    );
    expect(clearBtn).toBeDefined();

    await act(async () => {
      clearBtn?.click();
    });

    expect(useChatStore.getState().queue.map((entry) => entry.id)).toEqual(['q-remaining']);
    expect(useToastStore.getState().toasts.some((toast) => toast.title === '已停止部分消息')).toBe(true);
  });
});
