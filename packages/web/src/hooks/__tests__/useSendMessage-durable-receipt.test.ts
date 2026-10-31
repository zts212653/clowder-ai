/**
 * F309 through the canonical Queue/History boundary: HTTP admission owns no bubble.
 * The message lifecycle snapshot supplies the durable media URL, id and revision.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { messagePublicationSource } from '@/components/content-review/usePublishedContent';
import { writeStoredSnapshot } from '@/hooks/named-message-writer';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
vi.mock('@/hooks/useChatCommands', () => ({ useChatCommands: () => ({ processCommand: vi.fn(async () => false) }) }));

import { registerComposerDraftConsumption } from '@/components/composer-draft-consumption';
import { registerComposerDraftObserver } from '@/components/composer-draft-flush-registry';
import { useSendMessage } from '@/hooks/useSendMessage';

type Send = ReturnType<typeof useSendMessage>['handleSend'];
const stored: ChatMessage = {
  id: 'stored-image',
  type: 'user',
  content: '看图',
  timestamp: 1790000000123,
  contentBlocks: [
    { type: 'text', text: '看图' },
    { type: 'image', url: '/uploads/1790000000000-abcd1234.png' },
  ],
};
const response = (body: unknown) => ({ ok: true, status: 202, json: async () => body });

describe('sent media is published only by the durable message owner', () => {
  let container: HTMLDivElement;
  let root: Root;
  let send: Send;
  function Harness() {
    send = useSendMessage('thread-1').handleSend;
    return null;
  }
  const image = () => new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    mockApiFetch.mockReset();
    useChatStore.setState({ currentThreadId: 'thread-1', messages: [], threadStates: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(React.createElement(Harness)));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps an admitted image out of History until its lifecycle snapshot, then opens its stored publication', async () => {
    mockApiFetch.mockResolvedValue(response({ status: 'queued', userMessageId: stored.id, userMessage: stored }));
    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await send('看图', [image()]);
    });
    expect(accepted).toBe(true);
    expect(useChatStore.getState().messages).toEqual([]);
    const body = mockApiFetch.mock.calls[0]![1].body as FormData;
    expect(body.get('images')).toBeInstanceOf(File);
    expect(body.get('idempotencyKey')).toBeTruthy();
    act(() => writeStoredSnapshot('thread-1', stored));
    const message = useChatStore.getState().messages[0]!;
    expect(message).toMatchObject(stored);
    expect(
      messagePublicationSource(
        {
          threadId: 'thread-1',
          messageId: message.id,
          messageRevision: String(message.timestamp),
        },
        { kind: 'content-block', index: 1 },
        '/uploads/1790000000000-abcd1234.png',
      ),
    ).toEqual({
      kind: 'message',
      threadId: 'thread-1',
      messageId: stored.id,
      messageRevision: String(stored.timestamp),
      item: { kind: 'content-block', index: 1 },
      expectedUrl: '/uploads/1790000000000-abcd1234.png',
    });
  });

  it('a late HTTP receipt cannot replace or rename a snapshot already published in the background thread', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    mockApiFetch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = send('看图', [image()]);
      await Promise.resolve();
    });
    expect(useChatStore.getState().messages).toEqual([]);
    act(() => {
      useChatStore.setState({ currentThreadId: 'thread-2', messages: [] });
      writeStoredSnapshot('thread-1', stored);
    });
    await act(async () => {
      finish(
        response({
          status: 'queued',
          userMessageId: 'wrong-id',
          userMessage: { ...stored, id: 'wrong-id', timestamp: 99 },
        }),
      );
      expect(await pending).toBe(true);
    });
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().getThreadState('thread-1').messages).toEqual([stored]);
  });

  it('does not manufacture a publication when Queue admission supplies no stored body', async () => {
    mockApiFetch.mockResolvedValue(response({ status: 'queued', entryId: 'input-entry' }));
    await act(async () => {
      expect(await send('看图', [image()])).toBe(true);
    });
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('publishes the server consumption to this mounted thread before returning its accepted admission', async () => {
    const consume = vi.fn();
    const release = registerComposerDraftConsumption('thread-1', consume);
    const receipt = { threadId: 'thread-1', expectedRevision: 69, revision: 70 };
    try {
      mockApiFetch.mockResolvedValue(
        response({ status: 'queued', userMessageId: 'msg-consumed', composerDraftConsumption: receipt }),
      );
      await act(async () => {
        expect(await send('已接受')).toBe(true);
        expect(consume).toHaveBeenCalledWith(receipt);
      });
      consume.mockClear();
      mockApiFetch.mockResolvedValue(
        response({
          status: 'queued',
          userMessageId: 'msg-foreign',
          composerDraftConsumption: { ...receipt, threadId: 'other-thread' },
        }),
      );
      await act(async () => {
        await send('同页再发送');
      });
      expect(consume).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('carries the mounted composer revision in a send with images', async () => {
    const release = registerComposerDraftObserver('thread-1', () => ({ text: '看图', revision: 3, ready: true }));
    try {
      mockApiFetch.mockResolvedValue(response({ status: 'queued', userMessageId: 'image-message' }));
      await act(async () => {
        await send('看图', [image()], undefined, undefined, undefined, undefined, undefined, {
          consumeComposerDraft: true,
        });
      });
      const form = mockApiFetch.mock.calls[0]?.[1]?.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('composerDraftRevision')).toBe('3');
      expect(form.get('threadId')).toBe('thread-1');
      expect(form.getAll('images')).toHaveLength(1);
    } finally {
      release();
    }
  });
});
