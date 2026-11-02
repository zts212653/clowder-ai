import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YouSettingsPage } from '@/components/settings/YouSettingsPage';
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

describe('thread quick deletion and confirmation preference', () => {
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
  const quickDelete = (id: string) => {
    const found = row(id)?.querySelector<HTMLButtonElement>('[data-testid="thread-quick-delete"]');
    expect(found, `quick delete ${id}`).toBeTruthy();
    return found!;
  };
  const remember = () => {
    const found = Array.from(harness.container.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('后续不再提醒'))
      ?.querySelector<HTMLInputElement>('input');
    expect(found, 'remember confirmation checkbox').toBeTruthy();
    return found!;
  };
  const preferenceSwitch = () => {
    const found = settingsContainer.querySelector<HTMLInputElement>('[role="switch"][aria-label="删除普通会话前确认"]');
    expect(found, 'confirmation setting in You').toBeTruthy();
    return found!;
  };

  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
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
    vi.restoreAllMocks();
  });

  async function renderSettings() {
    settingsRoot = createRoot(settingsContainer);
    await act(async () => {
      settingsRoot?.render(<YouSettingsPage coCreator={null} loadError={false} reload={async () => {}} />);
    });
  }

  it('places quick deletion after More and keeps confirmation when a checked dialog is cancelled', async () => {
    await harness.render();
    const actions = Array.from(row('first')!.querySelectorAll<HTMLButtonElement>('button'));
    expect(actions.indexOf(quickDelete('first'))).toBeGreaterThan(
      actions.findIndex((action) => action.getAttribute('aria-label') === '更多操作'),
    );
    act(() => quickDelete('first').click());
    expect(harness.container.textContent).toContain('确认删除对话');
    expect(remember().checked).toBe(false);
    act(() => remember().click());
    act(() => button('取消').click());
    act(() => quickDelete('first').click());
    expect(remember().checked).toBe(false);
    expect(deleted.size).toBe(0);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('remembers only successful confirmation, survives remount and restores the exact trashed thread', async () => {
    await harness.render();
    act(() => quickDelete('first').click());
    act(() => remember().click());
    await act(async () => button('移入回收站').click());
    await harness.flush();
    expect(row('first')).toBeNull();
    harness.cleanup();
    harness = createThreadSidebarHarness();
    await harness.render();
    await act(async () => quickDelete('second').click());
    await harness.flush();
    expect(harness.container.textContent).not.toContain('确认删除对话');
    expect(deleted).toEqual(new Set(['first', 'second']));
    expect(mockPush).not.toHaveBeenCalled();
    act(() => harness.container.querySelector<HTMLButtonElement>('[data-testid="trash-bin-toggle"]')!.click());
    await harness.flush();
    const restore = Array.from(harness.container.querySelectorAll('button')).find(
      (candidate) =>
        candidate.textContent?.trim() === '恢复' && candidate.parentElement?.textContent?.includes('清理对话 first'),
    );
    expect(restore).toBeTruthy();
    await act(async () => restore!.click());
    await harness.flush();
    expect(deleted).toEqual(new Set(['second']));
    expect(row('first')).not.toBeNull();
  });

  it.each([409, 500])('retains the thread and confirmation preference after HTTP %i', async (status) => {
    failureStatus = status;
    await harness.render();
    act(() => quickDelete('first').click());
    act(() => remember().click());
    await act(async () => button('移入回收站').click());
    await harness.flush();
    expect(row('first')).not.toBeNull();
    expect(deleted.size).toBe(0);
    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    act(() => quickDelete('first').click());
    expect(harness.container.textContent).toContain('确认删除对话');
    expect(remember().checked).toBe(false);
  });

  it('shares the setting with the sidebar and keeps another user on the default confirmation', async () => {
    await harness.render();
    await renderSettings();
    expect(preferenceSwitch().checked).toBe(true);
    act(() => preferenceSwitch().click());
    await act(async () => quickDelete('first').click());
    await harness.flush();
    expect(deleted.has('first')).toBe(true);
    act(() => observeApiSessionOwner('another-user'));
    expect(preferenceSwitch().checked).toBe(true);
    act(() => quickDelete('second').click());
    expect(harness.container.textContent).toContain('确认删除对话');
    act(() => button('取消').click());
    act(() => observeApiSessionOwner('owner'));
    expect(preferenceSwitch().checked).toBe(false);
    act(() => preferenceSwitch().click());
    act(() => quickDelete('second').click());
    expect(harness.container.textContent).toContain('确认删除对话');
  });

  it('uses the same saved preference for the existing menu delete action', async () => {
    await harness.render();
    await renderSettings();
    act(() => preferenceSwitch().click());
    act(() => row('first')!.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
    await act(async () => button('删除对话').click());
    await harness.flush();
    expect(deleted.has('first')).toBe(true);
    expect(harness.container.textContent).not.toContain('确认删除对话');
  });

  it('does not silently disable confirmation when preference storage is unavailable', async () => {
    await harness.render();
    await renderSettings();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    act(() => preferenceSwitch().click());
    expect(preferenceSwitch().checked).toBe(true);
    expect(settingsContainer.querySelector('[role="alert"]')).not.toBeNull();
    act(() => quickDelete('first').click());
    expect(harness.container.textContent).toContain('确认删除对话');
  });

  it('still requires the system name when ordinary confirmation is disabled', async () => {
    await harness.render();
    await renderSettings();
    act(() => preferenceSwitch().click());
    act(() => harness.container.querySelector<HTMLButtonElement>('[data-testid="sidebar-tab-system"]')!.click());
    expect(row('system')?.querySelector('[data-testid="thread-quick-delete"]')).toBeNull();
    act(() => row('system')!.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
    act(() => button('删除对话').click());
    expect(harness.container.textContent).toContain('删除系统对话');
    expect(harness.container.textContent).not.toContain('后续不再提醒');
    expect(button('确认删除').disabled).toBe(true);
    const input = harness.container.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '清理对话 system');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('确认删除').disabled).toBe(false);
    await act(async () => button('确认删除').click());
    await harness.flush();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/system?force=true', { method: 'DELETE' });
  });

  it('reports a successful deletion separately from a failed remember write', async () => {
    await harness.render();
    act(() => quickDelete('first').click());
    act(() => remember().click());
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    await act(async () => button('移入回收站').click());
    await harness.flush();
    expect(row('first')).toBeNull();
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', message: expect.stringContaining('未能保存') }),
    );
    act(() => quickDelete('second').click());
    expect(harness.container.textContent).toContain('确认删除对话');
  });
});
