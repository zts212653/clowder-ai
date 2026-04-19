import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const { HubListModal } = await import('../HubListModal');

describe('HubListModal error state', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows an explicit error state instead of empty-state copy when hub thread loading fails', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 401 });

    await act(async () => {
      root.render(React.createElement(HubListModal, { open: true, onClose: vi.fn(), currentThreadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('加载 IM Hub 失败');
    expect(container.textContent).not.toContain('还没有 IM Hub');
  });
});
