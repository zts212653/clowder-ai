import type { QueueRecoveryAction } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { GenerationMessagesNotice } from '../GenerationMessagesNotice';
import { QueueTargetRetryButton } from '../QueueTargetRetryButton';

const mocks = vi.hoisted(() => ({ api: vi.fn(), reconcile: vi.fn(), focus: vi.fn(), pending: vi.fn(), kick: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.api }));
vi.mock('@/hooks/queue-reconciliation', () => ({ reconcileThreadWithServer: mocks.reconcile }));
vi.mock('@/utils/focusLineageMessage', () => ({ focusLineageMessage: mocks.focus }));
vi.mock('@/utils/teleport', () => ({ setPendingTeleport: mocks.pending, kickTeleportResolve: mocks.kick }));
Object.assign(globalThis, { React });
let container: HTMLDivElement;
let root: Root;
const response: ChatMessage = {
  id: 'response',
  type: 'assistant',
  from: { kind: 'agent', catId: 'opus' },
  content: 'Done',
  timestamp: 100,
  lifecycle: {
    kind: 'response',
    orderKey: '100',
    invocationId: 'inv',
    targetId: 'opus',
    inputEntryIds: ['entry'],
    inputMessageIds: ['initial'],
    startedAt: 100,
    completedAt: 200,
    status: 'completed',
  },
};
const entry: QueueEntry = {
  id: 'entry',
  threadId: 'thread',
  userId: 'owner',
  from: { kind: 'user', userId: 'owner' },
  content: 'retry',
  messageId: 'source',
  mergedMessageIds: [],
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: 100,
};
const retry: Extract<QueueRecoveryAction, { kind: 'retry_target' }> = {
  id: 'retry-opus',
  entryId: 'entry',
  kind: 'retry_target',
  targetCatId: 'opus',
  request: { method: 'POST', path: '/api/threads/thread/messages/source/routing-targets/opus/retry' },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
async function renderNotice() {
  await act(async () =>
    root.render(<GenerationMessagesNotice response={response} threadId="thread" timelineMessages={[]} />),
  );
  await act(async () => vi.advanceTimersByTimeAsync(250));
}
it('shows only the authoritative count, cycles exact links and loads a paged-out target', async () => {
  mocks.api.mockResolvedValue({
    ok: true,
    json: async () => ({ messageIds: ['first', 'paged-out'], hasAppendedInputs: true, complete: true }),
  });
  mocks.focus.mockReturnValueOnce(true).mockReturnValueOnce(false);
  await renderNotice();
  expect(container.textContent).toContain('生成期间另有 2 条新消息没并进这一轮 · 读没读查不到');
  await act(async () => container.querySelector('button')!.click());
  expect(mocks.focus).toHaveBeenLastCalledWith('first');
  await act(async () => container.querySelector('button')!.click());
  expect(mocks.pending).toHaveBeenCalledWith({ threadId: 'thread', messageId: 'paged-out' });
  expect(mocks.kick).toHaveBeenCalledTimes(1);
});
it.each([
  { messageIds: [], complete: true, hasAppendedInputs: false },
  { messageIds: ['partial'], complete: false, hasAppendedInputs: false },
])('does not label an empty or incomplete scan as new messages', async (body) => {
  mocks.api.mockResolvedValue({ ok: true, json: async () => body });
  await renderNotice();
  expect(container.textContent).toBe('');
});
it('refreshes a running response when an existing empty placeholder acquires visible content', async () => {
  const running = { ...response, lifecycle: { ...response.lifecycle, status: 'processing' } } as ChatMessage;
  const placeholder: ChatMessage = { id: 'other', type: 'assistant', content: '', timestamp: 150 };
  mocks.api.mockResolvedValue({
    ok: true,
    json: async () => ({ messageIds: [], hasAppendedInputs: false, complete: true }),
  });
  await act(async () =>
    root.render(<GenerationMessagesNotice response={running} threadId="thread" timelineMessages={[placeholder]} />),
  );
  await act(async () => vi.advanceTimersByTimeAsync(250));
  mocks.api.mockResolvedValue({
    ok: true,
    json: async () => ({ messageIds: ['other'], hasAppendedInputs: false, complete: true }),
  });
  await act(async () =>
    root.render(
      <GenerationMessagesNotice
        response={running}
        threadId="thread"
        timelineMessages={[{ ...placeholder, content: 'New answer' }]}
      />,
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(container.textContent).toContain('生成期间有 1 条新消息没并进这一轮');
});
it('retries only the server-projected source and target and refreshes the queue after success', async () => {
  mocks.api.mockResolvedValue({ ok: true, json: async () => ({ status: 'retrying' }) });
  await act(async () => root.render(<QueueTargetRetryButton entry={entry} action={retry} />));
  await act(async () => container.querySelector('button')!.click());
  expect(mocks.api).toHaveBeenCalledWith(retry.request.path, { method: 'POST' });
  expect(mocks.reconcile).toHaveBeenCalledWith('thread', expect.any(Function), 'QueueTargetRetry');
  expect(container.textContent).toContain('已提交重试');
  expect(container.querySelector('button')!.disabled).toBe(true);
  // A fresh server snapshot can offer another attempt after the first was held again.
  await act(async () => root.render(<QueueTargetRetryButton entry={{ ...entry }} action={{ ...retry }} />));
  expect(container.querySelector('button')!.disabled).toBe(false);
});
it('keeps a failed retry actionable and rejects an action for a different source', async () => {
  mocks.api.mockResolvedValue({ ok: false, json: async () => ({ error: '目标暂不可用' }) });
  await act(async () => root.render(<QueueTargetRetryButton entry={entry} action={retry} />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('目标暂不可用');
  expect(container.querySelector('button')!.disabled).toBe(false);
  await act(async () =>
    root.render(
      <QueueTargetRetryButton
        entry={entry}
        action={{ ...retry, request: { ...retry.request, path: '/api/unrelated' } }}
      />,
    ),
  );
  expect(container.querySelector('button')).toBeNull();
});
