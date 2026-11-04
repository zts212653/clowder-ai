import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { apiFetch, addMessage } = vi.hoisted(() => ({ apiFetch: vi.fn(), addMessage: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('@/hooks/useChatCommands', () => ({ useChatCommands: () => ({ processCommand: async () => false }) }));
vi.mock('@/stores/chatStore', () => {
  const state = { currentThreadId: 'other-thread', addMessageToThread: addMessage };
  return {
    useChatStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }),
  };
});

import { useSendMessage } from '@/hooks/useSendMessage';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let send: ReturnType<typeof useSendMessage>['handleSend'];
function Probe() {
  send = useSendMessage('active-thread').handleSend;
  return null;
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
async function mount() {
  apiFetch.mockReset();
  addMessage.mockReset();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ status: 'queued' }) });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(React.createElement(Probe)));
}
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
});

describe('recoverable first-message admission preserves canonical send', () => {
  it('retries the same first message with the owner key and explicit intent, without optimistic History', async () => {
    await mount();
    apiFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ detail: 'lost admission response' }),
    });
    const options = { idempotencyKey: 'first-message-key', messageDisposition: 'next_work' as const };
    await act(async () => {
      await send('hello', undefined, 'created-thread', undefined, 'reply-1', undefined, ['codex'], options);
    });
    await act(async () => {
      expect(
        await send('hello', undefined, 'created-thread', undefined, 'reply-1', undefined, ['codex'], options),
      ).toBe(true);
    });
    const bodies = apiFetch.mock.calls
      .filter((call) => call[0] === '/api/messages')
      .map((call) => JSON.parse(call[1].body));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({
      threadId: 'created-thread',
      idempotencyKey: 'first-message-key',
      messageDisposition: 'next_work',
      replyTo: 'reply-1',
      mentions: ['codex'],
    });
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(addMessage.mock.calls[0][1].type).toBe('system');
  });

  it('multipart first-message admission preserves retry key, private recipients, intent and attachment context', async () => {
    await mount();
    const image = new File(['image'], 'cat.png', { type: 'image/png' });
    await act(async () => {
      await send(
        'private',
        [image],
        'created-thread',
        { visibility: 'whisper', whisperTo: ['codex'] },
        'reply-1',
        undefined,
        ['codex'],
        { idempotencyKey: 'file-key', messageDisposition: 'continue_current' },
      );
    });
    const form = apiFetch.mock.calls[0][1].body as FormData;
    expect(form.get('idempotencyKey')).toBe('file-key');
    expect(form.get('messageDisposition')).toBe('continue_current');
    expect(form.getAll('whisperTo')).toEqual(['codex']);
    expect(form.getAll('mentions')).toEqual(['codex']);
    expect(form.get('replyTo')).toBe('reply-1');
    expect(form.getAll('images')).toHaveLength(1);
    expect(addMessage).not.toHaveBeenCalled();
  });
});
