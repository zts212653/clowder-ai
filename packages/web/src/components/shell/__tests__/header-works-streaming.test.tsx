import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { touchStreamActivity } from '@/hooks/agent-messages/named-target';
import { writeStreamText } from '@/hooks/named-message-writer';
import { useChatStore } from '@/stores/chatStore';
import { ThreadWorksButton } from '../HeaderCounts';

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () =>
    Response.json({ artifacts: [], total: 3, complete: true, workLineage: 'resolved', view: 'works' }),
  ),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch }));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const target = { threadId: 'stream-a', messageId: 'response-a', catId: 'codex' };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiFetch.mockClear();
  useChatStore.setState({
    currentThreadId: target.threadId,
    messages: [],
    threadStates: {},
    hasActiveInvocation: false,
    activeInvocations: {},
    catInvocations: {},
  });
  useChatStore.getState().addMessageToThread(target.threadId, {
    id: target.messageId,
    type: 'assistant',
    catId: target.catId,
    origin: 'stream',
    content: '',
    isStreaming: true,
    timestamp: 1000,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('keeps the header work read settled while text and activity cursors advance', async () => {
  await act(async () => root.render(<ThreadWorksButton threadId={target.threadId} />));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('3');

  for (const index of Array.from({ length: 20 }, (_, value) => value + 1)) {
    await act(async () => {
      writeStreamText(target, { content: `token-${index} ` });
      touchStreamActivity(useChatStore.getState(), target.threadId, target.messageId, 1000 + index);
    });
  }
  const message = useChatStore.getState().messages.find((item) => item.id === target.messageId);
  expect(message?.content).toBe(Array.from({ length: 20 }, (_, index) => `token-${index + 1} `).join(''));
  expect(message?.timestamp).toBe(1020);
  expect(message?.timelineOrderAt).toBe(1020);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(apiFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  expect(host.textContent).toContain('3');
});

it('still refreshes for published material, completion and explicit invalidation', async () => {
  await act(async () => root.render(<ThreadWorksButton threadId={target.threadId} />));
  await act(async () => {
    useChatStore.getState().appendRichBlockToThread(target.threadId, target.messageId, {
      id: 'work-card',
      kind: 'file',
      v: 1,
      fileName: 'Published-work.md',
      url: '/uploads/Published-work.md',
    });
  });
  expect(apiFetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    useChatStore.getState().setThreadMessageStreaming(target.threadId, target.messageId, false);
  });
  expect(apiFetch).toHaveBeenCalledTimes(2);
  await act(async () => useChatStore.getState().setThreadHasActiveInvocation(target.threadId, true));
  expect(apiFetch).toHaveBeenCalledTimes(2);
  await act(async () => useChatStore.getState().setThreadHasActiveInvocation(target.threadId, false));
  expect(apiFetch).toHaveBeenCalledTimes(3);
  await act(async () => {
    useChatStore.getState().addMessageToThread(target.threadId, {
      id: 'next-message',
      type: 'assistant',
      catId: 'codex',
      content: 'Another work',
      timestamp: 2000,
    });
  });
  expect(apiFetch).toHaveBeenCalledTimes(3);
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  expect(apiFetch).toHaveBeenCalledTimes(4);
});

it('re-reads the new thread and ignores streamed activity from the previous thread', async () => {
  await act(async () => root.render(<ThreadWorksButton threadId={target.threadId} />));
  await act(async () => root.render(<ThreadWorksButton threadId="stream-b" />));
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(apiFetch.mock.calls.at(-1)?.[0]).toBe('/api/threads/stream-b/artifacts?view=works');
  await act(async () => {
    writeStreamText(target, { content: 'background token' });
    touchStreamActivity(useChatStore.getState(), target.threadId, target.messageId, 2000);
  });
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('refreshes for non-text material and invocation completion, without reading on activation', async () => {
  await act(async () => root.render(<ThreadWorksButton threadId={target.threadId} />));
  await act(async () => {
    useChatStore.getState().patchThreadMessage(target.threadId, target.messageId, {
      contentBlocks: [{ type: 'image', url: '/uploads/fixture.png' }],
    });
  });
  expect(apiFetch).toHaveBeenCalledTimes(2);
  await act(async () => useChatStore.getState().setThreadHasActiveInvocation(target.threadId, true));
  expect(apiFetch).toHaveBeenCalledTimes(2);
  await act(async () => useChatStore.getState().setThreadHasActiveInvocation(target.threadId, false));
  expect(apiFetch).toHaveBeenCalledTimes(3);
});

it('ignores activity-driven display reordering of concurrent replies without lifecycle snapshots', async () => {
  const other = { ...target, messageId: 'response-b', catId: 'opus' };
  useChatStore.getState().addMessageToThread(target.threadId, {
    id: other.messageId,
    type: 'assistant',
    catId: other.catId,
    origin: 'stream',
    content: '',
    isStreaming: true,
    timestamp: 1001,
  });
  await act(async () => root.render(<ThreadWorksButton threadId={target.threadId} />));
  for (const index of Array.from({ length: 20 }, (_, value) => value + 1)) {
    await act(async () => {
      const reply = index % 2 ? target : other;
      writeStreamText(reply, { content: `token-${index} ` });
      touchStreamActivity(useChatStore.getState(), reply.threadId, reply.messageId, 2000 + index);
    });
  }
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
