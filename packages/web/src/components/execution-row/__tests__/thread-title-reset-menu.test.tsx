/**
 * F322 original-B: the thread title's ⌄ menu, home of the NORMAL force-reset.
 *
 * The design keeps force-reset out of the row except for three abnormal classes; the ordinary "I want to reset this
 * conversation" lives here, and only while something runs. It shares the one request and the one dialog with the row
 * (`useRowForceReset` / `postThreadForceReset`), so a refusal can never be reported as done here either.
 */
import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { ThreadTitleResetMenu } from '../ThreadTitleResetMenu';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

const THREAD = 'thread-a';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function run(): ActiveExecutionProjection {
  return {
    executionId: 'exec-opus',
    threadId: THREAD,
    threadTitle: 'Alpha',
    catId: 'opus',
    kind: 'live_invocation',
    startedAt: Date.now() - 60_000,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId: THREAD, catId: 'opus', executionId: 'exec-opus' },
    },
  };
}

function seed(running: boolean) {
  const store = useActiveExecutionStore.getState();
  store.reset();
  const version = store.beginHydration(THREAD, '/project/cafe');
  useActiveExecutionStore
    .getState()
    .applySnapshot(THREAD, version, { projectPath: '/project/cafe', executions: running ? [run()] : [] });
  useChatStore.setState({
    currentThreadId: THREAD,
    queue: [],
    queuePaused: false,
    activeInvocations: {},
    catInvocations: {},
    catStatuses: {},
    threadStates: {},
  } as never);
}

describe('ThreadTitleResetMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation(async () => json({ ok: true }));
    useToastStore.setState({ toasts: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const $ = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const click = (el: Element | null) => act(async () => (el as HTMLElement | null)?.click());
  const render = () => act(async () => root.render(<ThreadTitleResetMenu threadId={THREAD} />));
  const calls = () => mocks.apiFetch.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0] as string}`);
  const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);
  const dialog = () => document.querySelector('[role="dialog"]');
  const dialogConfirm = () =>
    Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.trim() === '强制重置');

  it('is not there when nothing runs: the normal reset is for a running conversation', async () => {
    seed(false);
    await render();
    expect($('thread-title-menu-toggle')).toBeNull();
  });

  it('shows a closed ⌄ while something runs; opening it offers 强制重置 and nothing else yet', async () => {
    seed(true);
    await render();
    const toggle = $('thread-title-menu-toggle');
    expect(toggle?.getAttribute('aria-haspopup')).toBe('menu');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect($('thread-title-menu')).toBeNull();
    await click(toggle);
    expect($('thread-title-menu')?.getAttribute('role')).toBe('menu');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(container.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent?.trim())).toEqual([
      '强制重置…',
    ]);
  });

  it('Esc and an outside press close the menu', async () => {
    seed(true);
    await render();
    await click($('thread-title-menu-toggle'));
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect($('thread-title-menu')).toBeNull();
    await click($('thread-title-menu-toggle'));
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect($('thread-title-menu')).toBeNull();
  });

  it('choosing 强制重置… asks first (nothing is sent), then the confirmation posts the thread endpoint', async () => {
    seed(true);
    await render();
    await click($('thread-title-menu-toggle'));
    await click(container.querySelector('[role="menuitem"]'));
    expect($('thread-title-menu')).toBeNull();
    expect(dialog()?.textContent).toContain('会保留什么');
    expect(calls().filter((c) => c.endsWith('/force-reset'))).toEqual([]);
    await click(dialogConfirm() ?? null);
    expect(calls()).toContain(`POST /api/threads/${THREAD}/force-reset`);
    expect(toastTitles()).toEqual(['已重置']);
    expect(dialog()).toBeNull();
  });

  it('a reset the server refuses is not reported as done, and the dialog stays open', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path.endsWith('/force-reset') ? json({ error: 'PRESTART_STATE_CHANGED' }, 409) : json({ ok: true }),
    );
    seed(true);
    await render();
    await click($('thread-title-menu-toggle'));
    await click(container.querySelector('[role="menuitem"]'));
    await click(dialogConfirm() ?? null);
    expect(toastTitles()).toEqual(['恢复未成功']);
    expect(dialog()).not.toBeNull();
  });

  it('the dialog survives the run ending while the user is reading it', async () => {
    seed(true);
    await render();
    await click($('thread-title-menu-toggle'));
    await click(container.querySelector('[role="menuitem"]'));
    // The cat finishes meanwhile: the ⌄ goes away, the question the user is answering does not.
    await act(async () => {
      const store = useActiveExecutionStore.getState();
      const version = store.beginHydration(THREAD, '/project/cafe');
      useActiveExecutionStore
        .getState()
        .applySnapshot(THREAD, version, { projectPath: '/project/cafe', executions: [] });
    });
    expect($('thread-title-menu-toggle')).toBeNull();
    expect(dialog()).not.toBeNull();
  });
});
