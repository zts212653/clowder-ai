import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  updateThreadPin: vi.fn(),
  updateThreadBacklogItem: vi.fn(),
  invalidateSidebarProjection: vi.fn(async () => true),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: mocks.invalidateSidebarProjection }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      updateThreadPin: mocks.updateThreadPin,
      updateThreadBacklogItem: mocks.updateThreadBacklogItem,
    }),
}));
vi.mock('../../AppTooltip', () => ({ AppTooltip: ({ children }: { children: React.ReactNode }) => children }));

import { ThreadFeatureSettingsContent } from '../../ThreadSidebar/ThreadFeatureSettings';

function reply(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

const backlogItems = [
  { id: 'feature-a', title: 'Feature A', status: 'done' },
  { id: 'feature-b', title: 'Feature B', status: 'open' },
  { id: 'feature-c', title: 'Feature C', status: 'cancelled' },
];

interface Detail {
  id: string;
  pinned: boolean;
  backlogItemId?: string;
}

function applyDetailPatch(detail: Detail, body: { pinned?: boolean; backlogItemId?: string | null }): Detail {
  const next = { ...detail };
  if (body.pinned !== undefined) next.pinned = body.pinned;
  if (body.backlogItemId === null) delete next.backlogItemId;
  else if (body.backlogItemId !== undefined) next.backlogItemId = body.backlogItemId;
  return next;
}

describe('F322 linked Feature settings', () => {
  let host: HTMLDivElement;
  let root: Root;
  const requests: Array<{ path: string; body?: unknown }> = [];
  let detail: Detail = { id: 'thread-1', pinned: false, backlogItemId: 'feature-a' };

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    requests.length = 0;
    detail = { id: 'thread-1', pinned: false, backlogItemId: 'feature-a' };
    mocks.updateThreadPin.mockReset();
    mocks.updateThreadBacklogItem.mockReset();
    mocks.invalidateSidebarProjection.mockClear();
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/backlog/items') return reply({ items: backlogItems });
      if (path === '/api/threads/thread-1' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { pinned?: boolean; backlogItemId?: string | null };
        requests.push({ path, body });
        detail = applyDetailPatch(detail, body);
        return reply(detail);
      }
      if (path === '/api/threads/thread-1') return reply(detail);
      throw new Error(`unexpected request ${path}`);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function openMenu() {
    await act(async () => root.render(<ThreadFeatureSettingsContent threadId="thread-1" />));
  }

  it('keeps the current completed Feature selectable, then saves replacement and clear through the canonical PATCH', async () => {
    await openMenu();
    const select = host.querySelector<HTMLSelectElement>('[data-testid="thread-feature-select"]');
    expect(select?.value).toBe('feature-a');
    expect(select ? [...select.options].map((option) => option.value) : []).toEqual(['', 'feature-a', 'feature-b']);

    await act(async () => {
      if (select) {
        select.value = 'feature-b';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.updateThreadBacklogItem).toHaveBeenCalledWith('thread-1', 'feature-b');

    await act(async () => {
      if (select) {
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.updateThreadBacklogItem).toHaveBeenLastCalledWith('thread-1', null);
    expect(requests.map((request) => request.body)).toEqual([{ backlogItemId: 'feature-b' }, { backlogItemId: null }]);
  });

  it('rolls back a rejected save and exposes the error without losing the prior association', async () => {
    await openMenu();
    mocks.apiFetch.mockImplementationOnce(() => reply({}, false));
    const select = host.querySelector<HTMLSelectElement>('select');
    await act(async () => {
      if (select) {
        select.value = 'feature-b';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(select?.value).toBe('feature-a');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('保存失败');
    expect(mocks.updateThreadBacklogItem).not.toHaveBeenCalled();
  });

  it('retries a failed load without treating a missing response as an empty association', async () => {
    mocks.apiFetch.mockImplementationOnce(() => reply({}, false));
    await openMenu();
    expect(host.querySelector('select')).toBeNull();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
    expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('feature-a');
  });
});
