import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginManagerBindings } from '../plugin-manager/PluginManagerBindings';

const { confirm, fetch } = vi.hoisted(() => ({ confirm: vi.fn(), fetch: vi.fn() }));
vi.mock('@/components/useConfirm', () => ({ useOptionalConfirm: () => confirm }));
vi.mock('@/utils/api-client', () => ({ apiFetch: fetch }));
(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

it('lists external bindings, keeps cancellation inert, and refreshes a stale disconnect', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const refresh = vi.fn();
  const binding = { key: 'chat/1', threadId: 'thread-1', threadTitle: 'Work', createdAt: 10 };
  try {
    await act(async () =>
      root.render(<PluginManagerBindings pluginId="any.plugin" bindings={[binding]} onChange={refresh} />),
    );
    expect(container.textContent).toContain('Work');
    expect(container.textContent).toContain('chat/1');
    confirm.mockResolvedValueOnce(false);
    await act(async () => container.querySelector('button')?.click());
    expect(fetch).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'STALE_BINDING' }), { status: 409 }));
    await act(async () => container.querySelector('button')?.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('绑定已变化');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      key: binding.key,
      threadId: binding.threadId,
      createdAt: 10,
      confirmed: true,
    });
    await act(async () =>
      root.render(<PluginManagerBindings pluginId="any.plugin" bindings={[]} onChange={refresh} />),
    );
    expect(container.textContent).toContain('暂无会话绑定');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
