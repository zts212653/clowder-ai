import type { MediaContextAttachment } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/api-client')>()),
  apiFetch: (...args: unknown[]) => mocks.fetch(...args),
}));

const media = {
  v: 1,
  id: 'media-1',
  kind: 'media',
  title: '窄屏设计稿.png',
  mediaType: 'image/png',
  source: { kind: 'workspace', locator: { worktreeId: 'w', path: 'art/cover.png' }, reviewId: 'r' },
  selections: [{ id: '1', selection: { kind: 'image-region', x: 1, y: 2, width: 3, height: 4 } }],
} as unknown as MediaContextAttachment;
const blocks = [
  { type: 'text', text: '请处理这一处' },
  { type: 'context_attachment', attachment: media },
] as ChatMessageData['contentBlocks'];

const reply = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const taken = (messageId: string) => ({
  record: {
    requestId: 'f309-modification-req',
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    progress: { sourceMessageId: messageId, sourceKind: 'human_message' },
    payload: { targetCatId: 'cat-a', threadId: 'execution-thread' },
  },
  stage: 'queued',
  candidates: [],
  acceptances: [],
  execution: { state: 'running', messageId: 'carrier', targetCatId: 'cat-a', observedAt: 1, evidenceRef: 'e' },
});

describe('ChatMessage: request status under a sent image message', () => {
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
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'thread-media', messages: [], threads: [], isLoadingThreads: false });
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async (url: string) =>
      String(url) === '/api/content-modifications/context'
        ? reply({
            requests: [taken('human-media')],
            contexts: [{ requestIds: ['f309-modification-req'], targetName: '烁烁' }],
          })
        : reply(taken('human-media')),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (message: ChatMessageData) => {
    await act(async () => {
      root.render(<ChatMessage message={message} threadId="thread-media" getCatById={() => undefined} />);
    });
  };

  it('puts the live request line inside the Human message that was taken over', async () => {
    await render({
      id: 'human-media',
      type: 'user',
      from: { kind: 'user', userId: 'operator' },
      content: '请处理这一处',
      timestamp: 1,
      contentBlocks: blocks,
    });
    const status = container.querySelector('[data-testid="media-message-request"]');
    expect(status?.textContent).toContain('修改中 · 窄屏设计稿.png 1\u00A0处');
    expect(status?.closest('[data-message-id="human-media"]')).not.toBeNull();
  });

  it('shows nothing for a message that was not taken over by any request', async () => {
    await render({
      id: 'human-untouched',
      type: 'user',
      from: { kind: 'user', userId: 'operator' },
      content: '请处理这一处',
      timestamp: 1,
      contentBlocks: blocks,
    });
    expect(container.querySelector('[data-testid="media-message-request"]')).toBeNull();
  });

  it('shows nothing, and reads nothing, for a message that was recalled after a cat had read it', async () => {
    await render({
      id: 'human-media',
      type: 'user',
      from: { kind: 'user', userId: 'operator' },
      content: '请处理这一处',
      timestamp: 1,
      contentBlocks: blocks,
      extra: { recall: { version: 1, exposure: 'seen', recalledAt: 2, exposures: [] } },
    });
    expect(container.querySelector('[data-recalled-message="seen"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="media-message-request"]')).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('reads nothing for an ordinary Human message', async () => {
    await render({
      id: 'human-plain',
      type: 'user',
      from: { kind: 'user', userId: 'operator' },
      content: '你好',
      timestamp: 1,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
