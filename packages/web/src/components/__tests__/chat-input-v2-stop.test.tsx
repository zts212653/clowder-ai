/**
 * F322 original-B, composer side. In the new shell (v2) the stop button is the LAST control when the draft is empty
 * (the design's "send key becomes ■") and is gone while the draft has something to send (stopping lives on the one
 * execution row); the old "猫猫正在回复中… 取消" bar is not rendered. The classic interface is frozen: its stop button
 * stays beside the send controls, the bar stays, and rendering with no preference is identical to choosing classic.
 *
 * Who decides is the HOST: a composer only drops the bar / moves the stop when it is told `presentation="v2"`, which
 * ThreadChatSurface (the one host that also mounts the execution row) does. A composer mounted anywhere else — the split
 * view mounts a bare ChatInput — keeps the classic bar even while the new shell is chosen, because nothing there says
 * "the row will tell you" in its place.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { Thread } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../shell/shell-presentation';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => new Response('{}', { status: 200 })),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));
vi.mock('@/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    transcript: '',
    partialTranscript: '',
    error: null,
    duration: 0,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

import { ChatInput } from '../ChatInput';
import { ChatInputActionButton } from '../ChatInputActionButton';
import { SplitPaneView } from '../SplitPaneView';
import { ThreadExecutionLayer } from '../thread-chat/ThreadExecutionLayer';

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
  window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
});

type ButtonProps = React.ComponentProps<typeof ChatInputActionButton>;
function renderButton(props: Partial<ButtonProps>) {
  act(() =>
    root.render(
      React.createElement(ChatInputActionButton, {
        onTranscript: vi.fn(),
        onSend: vi.fn(),
        onQueueSend: vi.fn(),
        onStop: vi.fn(),
        stopState: 'available',
        hasActiveInvocation: true,
        activeExecutionKey: 'exec-1',
        hasText: false,
        ...props,
      }),
    ),
  );
}
const labels = () =>
  [...container.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.title);
const stopIndex = () => labels().indexOf('Stop generation');
const micIndex = () => labels().findIndex((label) => label.startsWith('Start voice input'));

describe('ChatInputActionButton: where the stop button sits', () => {
  it('classic, empty draft, a cat running: the stop comes first, then the mic (unchanged)', () => {
    renderButton({ presentation: 'classic' });
    expect(stopIndex()).toBe(0);
    expect(micIndex()).toBe(1);
  });

  it('classic, text in the draft, a cat running: the stop is still there beside queue-send (unchanged)', () => {
    renderButton({ presentation: 'classic', hasText: true });
    expect(labels()).toContain('Stop generation');
    expect(labels()).toContain('排队发送');
  });

  it('no presentation given renders exactly what classic renders', () => {
    for (const hasText of [false, true]) {
      renderButton({ hasText });
      const byDefault = container.innerHTML;
      renderButton({ hasText, presentation: 'classic' });
      expect(container.innerHTML).toBe(byDefault);
    }
  });

  it('v2, empty draft, a cat running: the mic then the stop — the stop is the last control', () => {
    renderButton({ presentation: 'v2' });
    expect(micIndex()).toBe(0);
    expect(stopIndex()).toBe(1);
    expect(stopIndex()).toBe(labels().length - 1);
  });

  it('v2, text in the draft: no stop button; queue-send is the way forward', () => {
    renderButton({ presentation: 'v2', hasText: true });
    expect(labels()).not.toContain('Stop generation');
    expect(labels()).toContain('排队发送');
  });

  it('v2, no cat running: no stop button at all', () => {
    renderButton({ presentation: 'v2', hasActiveInvocation: false, stopState: 'hidden' });
    expect(labels()).not.toContain('Stop generation');
    expect(micIndex()).toBe(0);
  });

  it('v2, the stop still follows the stop state: pending is disabled, and a press stops once', () => {
    const onStop = vi.fn();
    renderButton({ presentation: 'v2', onStop, stopState: 'available' });
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]');
    expect(stop?.disabled).toBe(false);
    act(() => stop?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    renderButton({ presentation: 'v2', onStop, stopState: 'pending' });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]')?.disabled).toBe(true);
  });

  it('v2, the composer disabled while a cat runs: the big primary stop is still the only action (unchanged)', () => {
    renderButton({ presentation: 'v2', disabled: true });
    expect(labels()).toEqual(['Stop generation']);
  });
});

describe('ChatInput: the "猫猫正在回复中… 取消" bar', () => {
  const ROUTE = 'v2-route-thread';
  const SELECTED = 'v2-selected-thread';
  const originalState = useChatStore.getState();

  function thread(id: string): Thread {
    return { id, title: id, projectPath: '/p', createdBy: 'u', participants: [], lastActiveAt: 1, createdAt: 1 };
  }

  function renderRunning() {
    const selectedState = useChatStore.getState().getThreadState(SELECTED);
    useActiveExecutionStore.getState().reset();
    useActiveExecutionStore.setState({
      anchorThreadId: ROUTE,
      projectPath: '/p',
      executionsByKey: {},
      hydration: 'error',
      hydrationError: 'offline',
    });
    useChatStore.setState({
      currentThreadId: ROUTE,
      threads: [thread(ROUTE), thread(SELECTED)],
      splitPaneThreadIds: [ROUTE, SELECTED],
      splitPaneTargetId: SELECTED,
      threadStates: {
        [SELECTED]: {
          ...selectedState,
          hasActiveInvocation: true,
          activeInvocations: { stale: { catId: 'codex-sol', mode: 'execute' } },
        },
      },
    });
    act(() => root.render(React.createElement(SplitPaneView, { onSend: vi.fn(), onZoomToThread: vi.fn() })));
  }

  afterEach(() => {
    useChatStore.setState({
      currentThreadId: originalState.currentThreadId,
      threads: originalState.threads,
      splitPaneThreadIds: originalState.splitPaneThreadIds,
      splitPaneTargetId: originalState.splitPaneTargetId,
      threadStates: originalState.threadStates,
    });
    useActiveExecutionStore.getState().reset();
  });

  const banner = () => container.querySelector('[data-testid="active-invocation-banner"]');

  it('classic: the bar is rendered, with its words (unchanged)', () => {
    renderRunning();
    expect(banner()?.textContent).toContain('运行状态暂不可核对');
  });

  it('new shell chosen, but this composer has no row above it (split view): the bar and its words stay', () => {
    act(() => writeShellPresentation('v2'));
    renderRunning();
    // The split view mounts a bare ChatInput. Dropping the bar there would leave the unverifiable run unsaid anywhere.
    expect(banner()?.textContent).toContain('运行状态暂不可核对');
  });

  // The selected thread is B; the project snapshot is anchored at A and covers B's run; the re-read then fails.
  function renderCoveredSurface(presentation: 'classic' | 'v2') {
    const selectedState = useChatStore.getState().getThreadState(SELECTED);
    const store = useActiveExecutionStore.getState();
    store.reset();
    const version = store.beginHydration(ROUTE, '/p');
    useActiveExecutionStore.getState().applySnapshot(ROUTE, version, {
      projectPath: '/p',
      executions: [
        {
          executionId: 'selected-exec',
          threadId: SELECTED,
          threadTitle: SELECTED,
          catId: 'opus',
          kind: 'live_invocation',
          startedAt: Date.now() - 3_000,
          cancelability: {
            state: 'cancelable',
            target: { kind: 'live_invocation', threadId: SELECTED, catId: 'opus', executionId: 'selected-exec' },
          },
        },
      ],
    });
    useActiveExecutionStore.getState().failHydration(ROUTE, version, new Error('offline'));
    useChatStore.setState({
      currentThreadId: ROUTE,
      threads: [thread(ROUTE), thread(SELECTED)],
      queue: [],
      queuePaused: false,
      hasActiveInvocation: false,
      activeInvocations: {},
      catStatuses: {},
      catInvocations: {},
      threadStates: {
        [SELECTED]: {
          ...selectedState,
          hasActiveInvocation: true,
          activeInvocations: { 'selected-exec': { catId: 'opus', mode: 'execute' } },
          catInvocations: {},
          catStatuses: {},
          queue: [],
          queuePaused: false,
        },
      },
    });
    act(() => writeShellPresentation(presentation));
    // ThreadChatSurface's footer: the layer, then the composer told which presentation it is hosted in.
    act(() =>
      root.render(
        <>
          <ThreadExecutionLayer threadId={SELECTED} />
          <ChatInput threadId={SELECTED} onSend={vi.fn()} presentation={presentation} />
        </>,
      ),
    );
  }

  it('classic host: a same-project run whose snapshot could not be re-read is qualified by the bar', () => {
    renderCoveredSurface('classic');
    expect(banner()?.textContent).toContain('状态暂不可核对');
  });

  it('v2 host (row mounted): the bar is gone and the row says the run could not be re-read', () => {
    renderCoveredSurface('v2');
    expect(banner()).toBeNull();
    const row = container.querySelector('[data-testid="execution-row"]');
    expect(row).not.toBeNull();
    // Not just "opus 正在工作": the stale qualifier the classic composer shows for the same state.
    expect(row?.textContent).toContain('状态暂不可核对');
  });
});
