import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@/stores/chat-types';
import { useLabelStore } from '@/stores/label-store';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import {
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

const labels = Array.from({ length: 7 }, (_, index) => ({
  id: `label-${index}`,
  name: `Category ${index}`,
  color: '#5B8C5A',
  sortOrder: index,
  createdBy: 'user',
  createdAt: 1,
}));

function thread(id: string, threadLabels?: string[]): Thread {
  return {
    id,
    title: id,
    labels: threadLabels,
    projectPath: 'default',
    createdBy: 'user',
    participants: [],
    createdAt: 1,
    lastActiveAt: 1,
  };
}

describe('ThreadSidebar label totals', () => {
  let harness: ThreadSidebarHarness;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Unexpected network access in isolated test');
      }),
    );
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    mockStore.threads = [
      thread('default', ['label-0']),
      thread('multi', ['label-0', 'label-5']),
      thread('second', ['label-0']),
      thread('unlabeled'),
    ];
    mockStore.currentThreadId = 'multi';
    useLabelStore.setState({ labels, isLoading: false });
    mockApiFetch.mockImplementation((path: string) =>
      path === '/api/labels' ? jsonOk(labels) : defaultSidebarApiMock(path),
    );
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    resetThreadSidebarGlobals();
    vi.unstubAllGlobals();
  });

  async function openMenu() {
    await act(async () => {
      (harness.container.querySelector('[data-testid="sidebar-label-filter-trigger"]') as HTMLButtonElement).click();
    });
    await harness.flush();
  }

  function menuItem(name: string): HTMLButtonElement {
    const item = Array.from(harness.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) =>
      button.textContent?.includes(name),
    );
    if (!item) throw new Error(`missing menu item: ${name}`);
    return item;
  }

  function expectCount(name: string, count: number) {
    const spans = menuItem(name).querySelectorAll('span');
    expect(spans[1]?.textContent).toBe(name);
    expect(spans[2]?.textContent ?? '').toBe(count > 0 ? String(count) : '');
  }

  it('shows deduplicated totals in both menu sections, excludes default, and retains totals when selected', async () => {
    await harness.render();
    await openMenu();
    expectCount('Category 0', 2);
    expectCount('Category 5', 1);
    expectCount('Category 6', 0);
    expectCount('未分类', 1);
    await act(async () => menuItem('Category 5').click());
    await harness.flush();
    expect(harness.container.querySelector('[data-testid="sidebar-label-filter-trigger"]')?.textContent).toBe(
      'Category 5',
    );
    await openMenu();
    expectCount('Category 5', 1);
    expectCount('Category 0', 2);
  });

  it('keeps totals independent of search results', async () => {
    await harness.render();
    const input = harness.container.querySelector<HTMLInputElement>('input[placeholder="搜索对话、项目或 ID..."]');
    if (!input) throw new Error('missing search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('missing input setter');
    await act(async () => {
      setter.call(input, 'no matching thread');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await harness.flush();
    await openMenu();
    expectCount('Category 0', 2);
    expectCount('Category 5', 1);
    expectCount('未分类', 1);
  });

  it('recounts the real projection command overlay and its failed-command rollback', async () => {
    const { executeSidebarFieldCommand } = await import('@/utils/sidebar-commands');
    await harness.render();
    await openMenu();
    let resolveRequest!: (response: { ok: boolean }) => void;
    let command!: Promise<boolean>;
    await act(async () => {
      command = executeSidebarFieldCommand({
        threadId: 'second',
        field: 'labels',
        value: ['label-5'],
        request: () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      });
    });
    try {
      expectCount('Category 0', 1);
      expectCount('Category 5', 2);
    } finally {
      await act(async () => {
        resolveRequest({ ok: false });
        expect(await command).toBe(false);
      });
    }
    expectCount('Category 0', 2);
    expectCount('Category 5', 1);
    expect(useSidebarProjectionStore.getState().pendingThreadCommands).toEqual({});
  });

  it('retains the changed totals after a successful command is reconciled with the server', async () => {
    const { executeSidebarFieldCommand } = await import('@/utils/sidebar-commands');
    await harness.render();
    await openMenu();
    await act(async () => {
      const ok = await executeSidebarFieldCommand({
        threadId: 'second',
        field: 'labels',
        value: ['label-5'],
        request: async () => {
          mockStore.threads = (mockStore.threads as Thread[]).map((t) =>
            t.id === 'second' ? { ...t, labels: ['label-5'] } : t,
          );
          return { ok: true };
        },
      });
      expect(ok).toBe(true);
    });
    expectCount('Category 0', 1);
    expectCount('Category 5', 2);
    expect(useSidebarProjectionStore.getState().pendingThreadCommands).toEqual({});
  });

  it('updates totals after deleting a label and refreshing the canonical snapshot', async () => {
    await harness.render();
    await openMenu();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels/label-0') {
        mockStore.threads = (mockStore.threads as Thread[]).map((t) => ({
          ...t,
          labels: t.labels?.filter((id) => id !== 'label-0'),
        }));
        return jsonOk({});
      }
      return defaultSidebarApiMock(path);
    });
    await act(async () => {
      await useLabelStore.getState().deleteLabel('label-0');
    });
    await harness.flush();
    expect(harness.container.querySelector('[role="menu"]')?.textContent).not.toContain('Category 0');
    expectCount('Category 5', 1);
    expectCount('未分类', 2);
  });
});
