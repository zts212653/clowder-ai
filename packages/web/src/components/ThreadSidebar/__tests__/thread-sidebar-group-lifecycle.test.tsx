import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useLabelStore } from '@/stores/label-store';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { SIDEBAR_TAB_STORAGE_KEY } from '../sidebar-tab-state';
import {
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
} from './thread-sidebar-test-helpers';

const a = {
  id: 'member-a',
  title: 'Member A',
  projectPath: '/project',
  participants: [],
  createdBy: 'owner',
  createdAt: 1,
  lastActiveAt: 1,
  pinned: true,
  presence: { status: 'idle' },
};
const b = { ...a, id: 'member-b', title: 'Member B' };
const group = { id: 'attention_a', name: 'Our group', threadIds: [a.id, b.id] };
let restored: boolean;
let failRestore: boolean;
let loseRestoreResponse: boolean;
let harness: ReturnType<typeof createThreadSidebarHarness>;
beforeEach(() => {
  installThreadSidebarGlobals();
  resetThreadSidebarMocks();
  writeShellPresentation('classic');
  window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'pinned');
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
  observeApiSessionOwner('owner');
  restored = false;
  failRestore = false;
  loseRestoreResponse = false;
  Object.assign(mockStore, { threads: [a], currentThreadId: a.id, threadStates: {}, isLoadingThreads: false });
  useLabelStore.setState({ labels: [], isLoading: false });
  mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/api/config/thread-attention')
      return jsonOk({ aliases: {}, open: {}, groups: restored ? [group] : [] });
    if (path === '/api/threads?deleted=true') return jsonOk({ threads: restored ? [] : [b] });
    if (path === '/api/threads/member-b/restore') {
      if (failRestore) return Promise.resolve(new Response('{}', { status: 403 }));
      restored = true;
      mockStore.threads = [a, b];
      if (loseRestoreResponse) return Promise.reject(new TypeError('Restore response lost'));
      return jsonOk(b);
    }
    if (path === '/api/threads/member-b' && init?.method === 'DELETE') {
      restored = false;
      mockStore.threads = [a];
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return defaultSidebarApiMock(path);
  });
  harness = createThreadSidebarHarness();
});
afterEach(() => {
  harness.cleanup();
  resetThreadSidebarGlobals();
  vi.restoreAllMocks();
});
async function restore() {
  await harness.render();
  await harness.flush();
  await act(async () =>
    harness.container.querySelector<HTMLButtonElement>('[data-testid="trash-bin-toggle"]')!.click(),
  );
  await harness.flush();
  await act(async () =>
    harness.container.querySelector<HTMLButtonElement>('[data-testid="restore-btn-member-b"]')!.click(),
  );
  await harness.flush();
}

it('rebuilds the saved Group on the same page after restoring its second member', async () => {
  await restore();
  expect(harness.container.textContent).toContain('Member B');
  expect(harness.container.textContent).toContain('Our group');
  expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/config/thread-attention/groups')).toHaveLength(0);
});
it('keeps the Group snapshot unchanged when restoring is refused', async () => {
  failRestore = true;
  await restore();
  expect(restored).toBe(false);
  expect(harness.container.textContent).not.toContain('Our group');
  expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/config/thread-attention')).toHaveLength(1);
});
it('reads back an uncertain restore instead of repeating its membership operation', async () => {
  loseRestoreResponse = true;
  await restore();
  expect(harness.container.textContent).toContain('Our group');
  expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/threads/member-b/restore')).toHaveLength(1);
  expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/config/thread-attention/groups')).toHaveLength(0);
});
it('refreshes the canonical Group snapshot after soft deletion without rewriting membership', async () => {
  restored = true;
  mockStore.threads = [a, b];
  await harness.render();
  await harness.flush();
  const header = harness.container.querySelector<HTMLButtonElement>('[data-attention-cluster] button[aria-expanded]');
  if (header?.getAttribute('aria-expanded') === 'false') await act(async () => header.click());
  const row = harness.container.querySelector<HTMLElement>('[data-thread-id="member-b"]');
  await act(async () => row!.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
  const click = async (label: string) =>
    act(async () =>
      [...harness.container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!.click(),
    );
  await click('删除对话');
  const readsBefore = mockApiFetch.mock.calls.filter(([path]) => path === '/api/config/thread-attention').length;
  await click('移入回收站');
  await harness.flush();
  expect(restored).toBe(false);
  expect(harness.container.querySelector('[data-thread-id="member-b"]')).toBeNull();
  expect(harness.container.textContent).not.toContain('Our group');
  expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/config/thread-attention')).toHaveLength(
    readsBefore + 1,
  );
  expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/config/thread-attention/groups')).toHaveLength(0);
});
