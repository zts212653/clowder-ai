import type { ContextAttachment } from '@cat-cafe/shared';
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

const quote = (id: string): ContextAttachment =>
  ({
    v: 1,
    id,
    kind: 'quote',
    text: `words ${id}`,
    selectionStart: 0,
    selectionEnd: 5,
    source: {
      kind: 'workspace_file',
      path: 'docs/plans/launch-plan.md',
      worktreeId: 'w1',
      revision: `sha256:${'a'.repeat(64)}`,
    },
  }) as ContextAttachment;
const blocks = [
  { type: 'text', text: '请改这一处' },
  { type: 'context_attachment', attachment: quote('1') },
] as ChatMessageData['contentBlocks'];

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const taken = (messageId: string) => ({
  record: {
    requestId: 'f309-text-req',
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

describe('ChatMessage: request status under a sent message that quotes places of a file', () => {
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
    useChatStore.setState({ currentThreadId: 'thread-text', messages: [], threads: [], isLoadingThreads: false });
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async (url: string) => {
      const byMessage = /by-message\/([^/]+)$/.exec(String(url));
      if (byMessage)
        return decodeURIComponent(byMessage[1]) === 'human-text' ? reply(taken('human-text')) : reply({}, 404);
      return reply(taken('human-text'));
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (message: ChatMessageData) => {
    await act(async () => {
      root.render(<ChatMessage message={message} threadId="thread-text" getCatById={() => undefined} />);
    });
  };

  it('puts the live request line inside the Human message that was taken over', async () => {
    await render({
      id: 'human-text',
      type: 'user',
      from: { kind: 'user', userId: 'operator' },
      content: '请改这一处',
      timestamp: 1,
      contentBlocks: blocks,
    });
    const status = container.querySelector('[data-testid="text-message-request"]');
    expect(status?.textContent).toContain('修改中 · launch-plan.md 1 处');
    expect(status?.closest('[data-message-id="human-text"]')).not.toBeNull();
  });

  it('shows nothing for a message that was not taken over by any request', async () => {
    await render({
      id: 'human-untouched',
      type: 'user',
      from: { kind: 'user', userId: 'operator' },
      content: '请改这一处',
      timestamp: 1,
      contentBlocks: blocks,
    });
    expect(container.querySelector('[data-testid="text-message-request"]')).toBeNull();
  });

  it('shows nothing, and reads nothing, for a message that was recalled after a cat had read it', async () => {
    await render({
      id: 'human-text',
      type: 'user',
      from: { kind: 'user', userId: 'operator' },
      content: '请改这一处',
      timestamp: 1,
      contentBlocks: blocks,
      extra: { recall: { version: 1, exposure: 'seen', recalledAt: 2, exposures: [] } },
    });
    expect(container.querySelector('[data-recalled-message="seen"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="text-message-request"]')).toBeNull();
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
