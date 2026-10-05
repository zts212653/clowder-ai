/**
 * F322 original-B, header side: the new shell's header carries the thread title's ⌄ menu (the normal force-reset lives
 * there and only appears while something runs). The classic header is frozen and never renders it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../shell/shell-presentation';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('../icons/CatCafeLogo', () => ({ CatCafeLogo: () => null }));
vi.mock('../ThreadCatPill', () => ({ ThreadCatPill: () => null }));
vi.mock('../ThreadIndicator', () => ({ ThreadIndicator: () => null, tailTruncate: (value: string) => value }));
vi.mock('../shell/HeaderCounts', () => ({ ThreadTasksButton: () => null, ThreadWorksButton: () => null }));
vi.mock('../shell/HeaderParticipants', () => ({ HeaderParticipants: () => null }));

import { ChatContainerHeader } from '../ChatContainerHeader';

const THREAD = 'thread-title-menu';
const toggle = (container: HTMLElement) => container.querySelector('[data-testid="thread-title-menu-toggle"]');

function seedRunning(running: boolean) {
  const store = useActiveExecutionStore.getState();
  store.reset();
  if (!running) return;
  const version = store.beginHydration(THREAD, '/p');
  useActiveExecutionStore.getState().applySnapshot(THREAD, version, {
    projectPath: '/p',
    executions: [
      {
        executionId: 'exec-1',
        threadId: THREAD,
        threadTitle: 't',
        catId: 'opus',
        kind: 'live_invocation',
        startedAt: Date.now() - 5_000,
        cancelability: {
          state: 'cancelable',
          target: { kind: 'live_invocation', threadId: THREAD, catId: 'opus', executionId: 'exec-1' },
        },
      },
    ],
  });
}

describe('ChatContainerHeader: the title ⌄ menu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ queue: [], paused: false, activeInvocations: [] }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    useActiveExecutionStore.getState().reset();
  });

  function renderHeader(threadId: string = THREAD) {
    act(() =>
      root.render(
        <ChatContainerHeader
          sidebarOpen
          onToggleSidebar={vi.fn()}
          threadId={threadId}
          viewMode="single"
          onToggleViewMode={vi.fn()}
          statusPanelOpen={false}
          onToggleStatusPanel={vi.fn()}
        />,
      ),
    );
  }

  it('classic header, something running: no ⌄ menu — the classic header is unchanged', () => {
    seedRunning(true);
    renderHeader();
    expect(container.querySelector('[data-shell-header="v2"]')).toBeNull();
    expect(toggle(container)).toBeNull();
  });

  it('v2 header, something running: the ⌄ is next to the title', () => {
    act(() => writeShellPresentation('v2'));
    seedRunning(true);
    renderHeader();
    expect(container.querySelector('[data-shell-header="v2"]')).not.toBeNull();
    expect(toggle(container)).not.toBeNull();
  });

  it('v2 header, nothing running: no ⌄ — the menu only exists while there is something to reset', () => {
    act(() => writeShellPresentation('v2'));
    seedRunning(false);
    renderHeader();
    expect(toggle(container)).toBeNull();
  });
  const click = (el: Element | null) => act(async () => (el as HTMLElement | null)?.click());
  const confirmButton = () =>
    Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.trim() === '强制重置');
  const calls = () => mocks.apiFetch.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0]}`);
  const OTHER = 'thread-b';

  function seedOtherThreadRunning() {
    const store = useActiveExecutionStore.getState();
    const version = store.beginHydration(OTHER, '/p');
    useActiveExecutionStore.getState().applySnapshot(OTHER, version, {
      projectPath: '/p',
      executions: [
        {
          executionId: 'exec-b',
          threadId: OTHER,
          threadTitle: 'b',
          catId: 'opus',
          kind: 'live_invocation',
          startedAt: Date.now() - 5_000,
          cancelability: {
            state: 'cancelable',
            target: { kind: 'live_invocation', threadId: OTHER, catId: 'opus', executionId: 'exec-b' },
          },
        },
      ],
    });
  }

  it('the question asked for this thread resets this thread (control)', async () => {
    act(() => writeShellPresentation('v2'));
    seedRunning(true);
    renderHeader();
    await click(toggle(container));
    await click(container.querySelector('[data-testid="thread-title-menu-force-reset"]'));
    await click(confirmButton() ?? null);
    expect(calls()).toContain(`POST /api/threads/${THREAD}/force-reset`);
  });

  it('switching the header to another thread drops the open question: confirming never resets the OTHER thread', async () => {
    act(() => writeShellPresentation('v2'));
    seedRunning(true);
    renderHeader();
    await click(toggle(container));
    await click(container.querySelector('[data-testid="thread-title-menu-force-reset"]'));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => seedOtherThreadRunning());
    renderHeader(OTHER);
    // The question was about THREAD; it is gone with it, and there is nothing left to confirm for OTHER.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(confirmButton() ?? null);
    expect(calls().filter((c) => c.includes('/force-reset'))).toEqual([]);
  });
});
