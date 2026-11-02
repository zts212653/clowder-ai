import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const { apiFetch, confirm, addMessage } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  confirm: vi.fn(),
  addMessage: vi.fn(),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('@/components/useConfirm', () => ({ useOptionalConfirm: () => confirm }));
vi.mock('@/hooks/useChatCommands', () => ({ useChatCommands: () => ({ processCommand: async () => false }) }));
vi.mock('@/hooks/queue-reconciliation', () => ({ reconcileThreadWithServer: vi.fn() }));
vi.mock('@/stores/chatStore', () => {
  const state = { currentThreadId: 'thread', addMessageToThread: addMessage };
  return {
    useChatStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }),
  };
});

import { useSendMessage } from '@/hooks/useSendMessage';

const redirect = {
  code: 'ROUTING_CONFIRMATION_REQUIRED',
  error: '指定角色当前不可用',
  unavailable: [{ catId: 'dsh', displayName: '小鲸鱼/鲸鲸' }],
  targets: [{ catId: 'kimi', displayName: '梵花猫/墨墨' }],
};
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let send: ReturnType<typeof useSendMessage>['handleSend'];
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
function Probe() {
  send = useSendMessage('thread').handleSend;
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(async () => {
  apiFetch.mockReset();
  confirm.mockReset();
  addMessage.mockReset();
  apiFetch.mockResolvedValueOnce(response(409, redirect)).mockResolvedValue(response(202, { status: 'queued' }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(React.createElement(Probe)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('waits for approval of the server-proposed recipient, then freezes it with the same message key', async () => {
  let approve: (accepted: boolean) => void = () => {};
  confirm.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        approve = resolve;
      }),
  );
  let pending = Promise.resolve(false);
  await act(async () => {
    pending = send('@dsh 你怎么没有回复');
  });
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringMatching(/小鲸鱼[\s\S]*梵花猫/) }),
  );
  await act(async () => {
    approve(true);
    expect(await pending).toBe(true);
  });
  const bodies = apiFetch.mock.calls.map((call) => JSON.parse(call[1].body));
  expect(bodies[1]).toEqual({ ...bodies[0], confirmedTargetCats: ['kimi'] });
  expect(bodies[1].content).toBe('@dsh 你怎么没有回复');
  expect(addMessage).not.toHaveBeenCalled();
});

it('declining restores the caller draft path without sending or publishing an error', async () => {
  confirm.mockResolvedValue(false);
  await act(async () => {
    expect(await send('@dsh hello')).toBe(false);
  });
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(addMessage).not.toHaveBeenCalled();
});

it('multipart confirmation retains images, reply context and the original idempotency key', async () => {
  confirm.mockResolvedValue(true);
  const image = new File(['fixture'], 'cat.png', { type: 'image/png' });
  await act(async () => {
    expect(await send('@dsh hello', [image], undefined, undefined, 'reply-id')).toBe(true);
  });
  const first = apiFetch.mock.calls[0][1].body as FormData;
  const confirmed = apiFetch.mock.calls[1][1].body as FormData;
  expect(confirmed.getAll('confirmedTargetCats')).toEqual(['kimi']);
  expect(confirmed.get('idempotencyKey')).toBe(first.get('idempotencyKey'));
  expect(confirmed.get('replyTo')).toBe('reply-id');
  expect(confirmed.getAll('images')).toEqual([image]);
});

it('a second refusal cannot silently approve or send to a different replacement', async () => {
  confirm.mockResolvedValue(true);
  apiFetch
    .mockReset()
    .mockResolvedValue(response(409, { ...redirect, targets: [{ catId: 'codex', displayName: '缅因猫/砚砚' }] }));
  await act(async () => {
    expect(await send('@dsh hello')).toBe(false);
  });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(apiFetch).toHaveBeenCalledTimes(2);
});
