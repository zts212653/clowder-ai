import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import {
  addToastMock,
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockPush,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

vi.mock('@/components/settings/YouProfileCard', () => ({ YouProfileCard: () => null }));
vi.mock('@/components/chat-background/ChatBackgroundPicker', () => ({ ChatBackgroundPicker: () => null }));

const threads = ['first', 'second', 'system'].map((id, index) => ({
  id,
  title: `清理对话 ${id}`,
  projectPath: '/project/quick-delete',
  createdBy: 'owner',
  participants: [],
  createdAt: 1000,
  lastActiveAt: 3000 - index,
  ...(id === 'system' ? { systemKind: 'eval_domain' as const } : {}),
}));

describe('menu-only thread deletion with mandatory confirmation', () => {
  let harness: ThreadSidebarHarness;
  let settingsRoot: Root | undefined;
  let settingsContainer: HTMLDivElement;
  let deleted: Set<string>;
  let failureStatus: number | undefined;
  const row = (id: string) => harness.container.querySelector<HTMLElement>(`[data-thread-id="${id}"]`);
  const button = (label: string) => {
    const found = Array.from(harness.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(found, `button ${label}`).toBeTruthy();
    return found!;
  };
  const menuDelete = (id: string) => {
    act(() => row(id)!.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
    act(() => button('删除对话').click());
  };
  const deleteRequests = () => mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE');

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected network from isolated test'))),
    );
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    localStorage.setItem('cat-cafe:shell-presentation', 'classic');
    observeApiSessionOwner('owner');
    deleted = new Set();
    failureStatus = undefined;
    Object.assign(mockStore, { threads, currentThreadId: 'default', threadStates: {}, isLoadingThreads: false });
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/session') return jsonOk({ userId: 'owner' });
      if (path === '/api/threads?view=sidebar')
        return jsonOk({ threads: threads.filter((thread) => !deleted.has(thread.id)) });
      if (path === '/api/threads?deleted=true')
        return jsonOk({ threads: threads.filter((thread) => deleted.has(thread.id)) });
      if (init?.method === 'DELETE') {
        if (failureStatus) return Promise.resolve(new Response('{}', { status: failureStatus }));
        deleted.add(path.split('/').at(-1)!.split('?')[0]!);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (path.endsWith('/restore')) {
        deleted.delete(path.split('/').at(-2)!);
        return jsonOk({});
      }
      return defaultSidebarApiMock(path);
    });
    harness = createThreadSidebarHarness();
    settingsContainer = document.createElement('div');
    document.body.appendChild(settingsContainer);
  });

  afterEach(() => {
    harness.cleanup();
    if (settingsRoot) act(() => settingsRoot?.unmount());
    settingsRoot = undefined;
    settingsContainer.remove();
    resetThreadSidebarGlobals();
    const networkCalls = vi.mocked(fetch).mock.calls;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(networkCalls, 'isolated component tests cannot call a live API').toEqual([]);
  });

  async function renderSettings() {
    // Load after the shared sidebar helper installs its API mock; an earlier static
    // import leaves the settings background read holding the real session client.
    const { YouSettingsPage } = await import('@/components/settings/YouSettingsPage');
    settingsRoot = createRoot(settingsContainer);
    await act(async () => {
      settingsRoot?.render(<YouSettingsPage coCreator={null} loadError={false} reload={async () => {}} />);
    });
  }

  it('keeps deletion inside More and cancellation never sends DELETE', async () => {
    await harness.render();
    expect(row('first')!.querySelector('[data-testid="thread-quick-delete"]')).toBeNull();
    menuDelete('first');
    expect(harness.container.textContent).toContain('确认删除对话');
    expect(harness.container.querySelector('[role="dialog"] input[type="checkbox"]')).toBeNull();
    act(() => button('取消').click());
    expect(deleteRequests()).toHaveLength(0);
    menuDelete('first');
    expect(harness.container.textContent).toContain('确认删除对话');
    expect(deleted.size).toBe(0);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('ignores an old off preference and confirms every deletion after remount', async () => {
    localStorage.setItem('clowder:thread-delete-confirm:v1:http%3A%2F%2Flocalhost%3A3102:owner', 'off');
    await harness.render();
    menuDelete('first');
    expect(harness.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(deleteRequests()).toHaveLength(0);
    await act(async () => button('移入回收站').click());
    await harness.flush();
    expect(row('first')).toBeNull();
    expect(deleteRequests()).toHaveLength(1);
    harness.cleanup();
    harness = createThreadSidebarHarness();
    await harness.render();
    menuDelete('second');
    expect(harness.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(deleteRequests()).toHaveLength(1);
    act(() => button('取消').click());
    act(() => harness.container.querySelector<HTMLButtonElement>('[data-testid="trash-bin-toggle"]')!.click());
    await harness.flush();
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="restore-btn-first"]')!.click(),
    );
    await harness.flush();
    expect(deleted.size).toBe(0);
    expect(row('first')).not.toBeNull();
  });

  it.each([409, 500])('retains the thread and requires confirmation again after HTTP %i', async (status) => {
    failureStatus = status;
    await harness.render();
    menuDelete('first');
    await act(async () => button('移入回收站').click());
    await harness.flush();
    expect(row('first')).not.toBeNull();
    expect(deleted.size).toBe(0);
    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    menuDelete('first');
    expect(harness.container.textContent).toContain('确认删除对话');
  });

  it('removes the confirmation preference from personal settings', async () => {
    await harness.render();
    await renderSettings();
    expect(settingsContainer.querySelector('[role="switch"][aria-label="删除普通会话前确认"]')).toBeNull();
    expect(settingsContainer.textContent).not.toContain('会话操作');
    menuDelete('first');
    expect(harness.container.textContent).toContain('确认删除对话');
  });

  it('still requires the system name before calling the protected delete route', async () => {
    await harness.render();
    act(() => harness.container.querySelector<HTMLButtonElement>('[data-testid="sidebar-tab-system"]')!.click());
    menuDelete('system');
    expect(harness.container.textContent).toContain('删除系统对话');
    expect(button('确认删除').disabled).toBe(true);
    const input = harness.container.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '清理对话 system');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('确认删除').disabled).toBe(false);
    await act(async () => button('确认删除').click());
    await harness.flush();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/system?force=true', {
      method: 'DELETE',
      signal: expect.any(AbortSignal),
    });
  });
});
