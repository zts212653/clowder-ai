import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { DotConnectionDetail } from '../plugin-manager/DotConnectionDetail';

const mockApiFetch = vi.mocked(apiFetch);
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
describe('dot family collaboration settings', () => {
  let container: HTMLDivElement, root: Root;
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it('shows connected collaboration without a second housecat permission step or roster dependency', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/chatgpt-dot/connection')
        return json({
          installed: true,
          paired: true,
          subscription: 'active',
          revoked: false,
          replyAt: Date.now(),
          imageAt: null,
          endpointUrl: null,
          allowedCatIds: [],
        });
      if (url === '/api/plugins/chatgpt-dot/test') return json({ tests: [] });
      return json({}, 503);
    });
    await act(async () => root.render(<DotConnectionDetail installed />));
    await flushEffects();
    expect(container.textContent).toContain('收到过真实回复');
    expect(container.textContent).not.toContain('获准召唤的家猫');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(container.querySelector('[role="group"][aria-label="dot 连接操作"]')).toBeNull();
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/cats')).toBe(false);
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('groups compact actions while preserving prepare, test, confirmation and result semantics', async () => {
    const state = {
      installed: true,
      paired: true,
      subscription: 'active',
      endpointUrl: 'https://mcp.example/mcp',
      revoked: false,
      replyAt: 1,
      imageAt: null,
    };
    const changed = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/chatgpt-dot/connection') return json(state);
      if (url === '/api/plugins/chatgpt-dot/prepare')
        return json({ ...state, instructions: 'Original dot subscription' });
      if (url === '/api/plugins/chatgpt-dot/test')
        return json({
          tests: [{ eventId: 'a', threadId: 'original-a', receivedAt: 1, readAt: 1, replyMessageId: 'reply-a' }],
        });
      if (url === '/api/plugins/chatgpt-dot/disconnect') return json({});
      return json({}, 404);
    });
    await act(async () =>
      root.render(<DotConnectionDetail installed compact secondaryAction onStateChanged={changed} />),
    );
    await flushEffects();
    const group = container.querySelector('[role="group"][aria-label="dot 连接操作"]');
    expect(group, 'the three existing actions share one responsive group').not.toBeNull();
    if (!group) throw new Error('Missing dot action group');
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['查看订阅说明', '重新检查往返', '断开这只 dot']);
    expect(container.querySelector('table a')?.getAttribute('href')).toBe('/thread/original-a');
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    await act(async () => buttons[0]?.click());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugins/chatgpt-dot/prepare',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ reconnect: false }) }),
    );
    expect(container.textContent).toContain('Original dot subscription');
    await act(async () => buttons[1]?.click());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugins/chatgpt-dot/test',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => buttons[2]?.click());
    expect(
      mockApiFetch.mock.calls.some(
        ([url, init]) => url === '/api/plugins/chatgpt-dot/disconnect' && init?.method === 'POST',
      ),
    ).toBe(false);
    confirm.mockReturnValue(true);
    await act(async () => buttons[2]?.click());
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/chatgpt-dot/disconnect', { method: 'POST' });
    confirm.mockRestore();
  });

  it.each([
    {
      paired: false,
      subscription: 'absent',
      endpointUrl: null,
      revoked: false,
      count: 1,
      prepareDisabled: true,
      testDisabled: undefined,
    },
    {
      paired: true,
      subscription: 'expired',
      endpointUrl: 'https://mcp.example/mcp',
      revoked: false,
      count: 3,
      prepareDisabled: false,
      testDisabled: true,
    },
    {
      paired: true,
      subscription: 'absent',
      endpointUrl: 'https://mcp.example/mcp',
      revoked: true,
      count: 3,
      prepareDisabled: false,
      testDisabled: true,
    },
  ])('retains compact controls for $subscription / paired=$paired / revoked=$revoked', async (state) => {
    mockApiFetch.mockImplementation(async (url) =>
      url === '/api/plugins/chatgpt-dot/test'
        ? json({ tests: [] })
        : json({ ...state, installed: true, replyAt: null, imageAt: null }),
    );
    await act(async () => root.render(<DotConnectionDetail installed compact secondaryAction />));
    await flushEffects();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    expect(buttons).toHaveLength(state.count);
    expect(buttons[0]?.disabled).toBe(state.prepareDisabled);
    if (state.testDisabled !== undefined) expect(buttons[1]?.disabled).toBe(state.testDisabled);
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('keeps every compact action disabled during prepare and restores the retained state on failure', async () => {
    const state = {
      installed: true,
      paired: true,
      subscription: 'active',
      endpointUrl: 'https://mcp.example/mcp',
      revoked: false,
      replyAt: 1,
      imageAt: null,
    };
    let finish: ((response: Response) => void) | undefined;
    const prepared = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/chatgpt-dot/prepare') return prepared;
      return url === '/api/plugins/chatgpt-dot/test' ? json({ tests: [] }) : json(state);
    });
    await act(async () => root.render(<DotConnectionDetail installed compact secondaryAction />));
    await flushEffects();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    await act(async () => buttons[0]?.click());
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await act(async () => finish?.(json({ error: 'Prepare failed' }, 503)));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Prepare failed');
    expect(container.textContent).toContain('已验证');
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  });
});
