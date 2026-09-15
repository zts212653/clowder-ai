import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoutingPreflightActions } from '../RoutingPreflightActions';

const { apiFetch, openTeamSubject } = vi.hoisted(() => ({ apiFetch: vi.fn(), openTeamSubject: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ openTeamSubject }),
}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const payload = {
  type: 'routing_preflight',
  retryInvocationId: 'parent/1',
  target: { targetCatId: 'codex-astra', disposition: 'rejected' },
};
beforeEach(() => {
  (globalThis as Record<string, unknown>).React = React;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  apiFetch.mockReset();
  openTeamSubject.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it('refreshes an early running receipt until the retryable failure is durable', async () => {
  vi.useFakeTimers();
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'running' }) });
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'failed' }) });
  await act(async () => root.render(<RoutingPreflightActions payload={payload} />));
  expect(container.textContent).not.toContain('重试这条');
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(container.textContent).toContain('重试这条');
  expect(apiFetch.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
});

it('reads current terminal truth and retries the exact original invocation only after a click', async () => {
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'failed' }) });
  await act(async () => {
    root.render(<RoutingPreflightActions payload={payload} />);
  });
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(apiFetch.mock.calls[0][0]).toBe('/api/invocations/parent%2F1');
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'retrying' }) });
  await act(async () => {
    (
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === '重试这条',
      ) as HTMLButtonElement
    ).click();
  });
  expect(apiFetch.mock.calls[1]).toEqual(['/api/invocations/parent%2F1/retry', { method: 'POST' }]);
  expect(container.textContent).toContain('已提交重试');
  expect(openTeamSubject).not.toHaveBeenCalled();
});

it('does not replay completed history and opens the existing Team list only on explicit navigation', async () => {
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'succeeded' }) });
  await act(async () => {
    root.render(<RoutingPreflightActions payload={payload} />);
  });
  expect(container.textContent).toContain('这条已执行');
  expect(container.textContent).not.toContain('重试这条');
  act(() => {
    (container.querySelector('button') as HTMLButtonElement).click();
  });
  expect(openTeamSubject).toHaveBeenCalledWith(null);
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('shows an actionable error without declaring a rejected retry successful', async () => {
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'failed' }) });
  await act(async () => {
    root.render(<RoutingPreflightActions payload={payload} />);
  });
  apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: '已有一次重试正在执行' }) });
  await act(async () => {
    (
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === '重试这条',
      ) as HTMLButtonElement
    ).click();
  });
  expect(container.textContent).toContain('已有一次重试正在执行');
  expect(container.textContent).not.toContain('已提交重试');
});
