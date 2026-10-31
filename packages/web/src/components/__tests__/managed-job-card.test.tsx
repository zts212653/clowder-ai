import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ConnectorBubble } from '../ConnectorBubble';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
const card: ChatMessage = {
  id: 'queued-job',
  type: 'connector',
  content: '旧的待启动说明',
  timestamp: 1000,
  source: {
    connector: 'hold-ball',
    label: '持球通知',
    icon: 'hold-ball',
    meta: {
      taskId: 'hold-ball-job',
      jobId: 'managed-job-one',
      catId: 'gemini38',
      managedJobCard: true,
      reason: '运行回归测试',
    },
  },
};
const response = (state: string, extra = {}) =>
  new Response(
    JSON.stringify({
      taskId: 'hold-ball-job',
      catId: 'gemini38',
      cancelable: state === 'running',
      access: { lifecycleVisibility: 'full' },
      job: {
        jobId: 'managed-job-one',
        originTaskId: 'hold-ball-job',
        state,
        command: 'pnpm test',
        createdAt: 1000,
        ...extra,
      },
    }),
  );

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(apiFetch).mockReset();
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

it('updates the original job entity from running to terminal and expands its persistent output without starting work', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(response('running'))
    .mockResolvedValueOnce(response('succeeded', { result: { exitCode: 0 } }))
    .mockResolvedValueOnce(response('succeeded', { tail: '42 tests passed', transitions: [] }));
  act(() => root.render(<ConnectorBubble message={card} threadId="thread-1" timelineMessages={[card]} />));
  await flush();
  expect(container.querySelectorAll('[data-testid="managed-job-card"]').length).toBe(1);
  expect(container.textContent).toContain('正在运行');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(container.textContent).toContain('已完成');
  const details = container.querySelector('details')!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  await flush();
  expect(container.textContent).toContain('42 tests passed');
  expect(vi.mocked(apiFetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(
    true,
  );
});

it('renders one entity for admission and completion receipts, and shows unreadable state instead of success after disconnect', async () => {
  const terminal: ChatMessage = {
    ...card,
    id: 'terminal-receipt',
    timestamp: 2000,
    source: { ...card.source!, meta: { ...card.source!.meta, managedJobCard: false, managedJobReceipt: 'terminal' } },
  };
  vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
  act(() =>
    root.render(
      <>
        <ConnectorBubble message={card} threadId="thread-1" timelineMessages={[card, terminal]} />
        <ConnectorBubble message={terminal} threadId="thread-1" timelineMessages={[card, terminal]} />
      </>,
    ),
  );
  await flush();
  expect(container.querySelectorAll('[data-testid="managed-job-card"]').length).toBe(1);
  expect(container.textContent).toContain('暂时读不到任务状态');
  expect(container.textContent).not.toContain('已完成');
});
