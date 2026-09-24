import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { CloudBindingRecoveryCard } from '../CloudBindingRecoveryCard';

const container = document.createElement('div');
let root = createRoot(container);
const mockFetch = vi.mocked(apiFetch);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
const stamp = '2026-09-05T10:00:00.000Z';
const conversationId = 'conversation-7';
const url = `https://chatgpt.com/c/${conversationId}`;

afterEach(() => {
  act(() => root.unmount());
  root = createRoot(container);
  vi.resetAllMocks();
});
afterAll(() => {
  act(() => root.unmount());
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('lets an owner connect when an old message cannot retry, without resending or leaving an unbound heading', async () => {
  let bound = false;
  mockFetch.mockImplementation(async (path, init) => {
    if (path === '/api/plugins/personal-chrome')
      return json({
        authorization: {
          conversations: [{ conversationId, displayTitle: '云端小星星接回家', authorizedAt: stamp, updatedAt: stamp }],
        },
      });
    if (String(path).endsWith('/cloud-bindings')) {
      if (init?.method === 'PATCH') bound = true;
      return json({ bindings: bound ? { 'gpt-pro': url } : {} });
    }
    throw new Error(`unexpected request ${String(path)}`);
  });
  await act(async () => {
    root.render(<CloudBindingRecoveryCard threadId="thread-7" sourceMessageId="source-7" targetCatId="gpt-pro" />);
  });
  await vi.waitFor(() => expect(container.textContent).toContain('云端小星星接回家'));
  const primary = container.querySelector<HTMLButtonElement>('[data-recovery-primary]');
  expect(primary?.textContent).toBe('连接此会话');
  expect(primary?.disabled).toBe(false);
  await act(async () => {
    primary?.click();
  });
  await vi.waitFor(() => expect(container.textContent).toContain('已连接'));
  expect(container.textContent).not.toContain('尚未绑定');
  expect(container.textContent).not.toContain('这条消息还没有发送');
  expect(mockFetch.mock.calls.some(([path]) => String(path).endsWith('/retry'))).toBe(false);
});

it('renders a verified sent receipt as the result, with no connection chooser or resend button', async () => {
  await act(async () => {
    root.render(
      <CloudBindingRecoveryCard
        threadId="thread-7"
        sourceMessageId="source-7"
        targetCatId="gpt-pro"
        deliveryStatus="sent"
      />,
    );
  });
  expect(container.textContent).toContain('已发送到 ChatGPT');
  expect(container.textContent).not.toContain('还没有发送');
  expect(container.querySelector('[data-recovery-primary]')).toBeNull();
});

it('retries only the immutable attempt carried by the recovery notice', async () => {
  mockFetch.mockImplementation(async (path) => {
    if (path.endsWith('/cloud-bindings')) return json({ bindings: { 'gpt-pro': url } });
    if (path.endsWith('/personal-chrome'))
      return json({
        authorization: {
          conversations: [{ conversationId, displayTitle: '小星星', authorizedAt: stamp, updatedAt: stamp }],
        },
      });
    return json({ status: 'retry_queued' }, 202);
  });
  await act(async () => {
    root.render(
      <CloudBindingRecoveryCard
        threadId="thread-7"
        sourceMessageId="source-7"
        targetCatId="gpt-pro"
        attemptId="attempt-stale"
        deliveryStatus="sending"
      />,
    );
  });
  const primary = container.querySelector<HTMLButtonElement>('[data-recovery-primary]');
  expect(primary?.textContent).toBe('继续发送');
  expect(primary?.disabled).toBe(false);
  await act(async () => {
    primary?.click();
  });
  expect(mockFetch).toHaveBeenCalledWith(
    '/api/messages/source-7/delivery-targets/gpt-pro/retry',
    expect.objectContaining({ body: JSON.stringify({ attemptId: 'attempt-stale' }) }),
  );
});
