/** Stop remains an exact icon action; execution status is not repeated in a composer banner. */
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
  it('classic, empty draft, a cat running: stop is available without another voice input', () => {
    renderButton({ presentation: 'classic' });
    expect(stopIndex()).toBe(0);
    expect(micIndex()).toBe(-1);
  });

  it('classic, text in the draft, a cat running: the stop is still there beside queue-send (unchanged)', () => {
    renderButton({ presentation: 'classic', hasText: true });
    expect(labels()).toContain('Stop generation');
    expect(labels()).toContain('Send message');
  });

  it('no presentation given renders exactly what classic renders', () => {
    for (const hasText of [false, true]) {
      renderButton({ hasText });
      const byDefault = container.innerHTML;
      renderButton({ hasText, presentation: 'classic' });
      expect(container.innerHTML).toBe(byDefault);
    }
  });

  it('v2, empty draft, a cat running: stop is the last control without another voice input', () => {
    renderButton({ presentation: 'v2' });
    expect(micIndex()).toBe(-1);
    expect(stopIndex()).toBe(0);
    expect(stopIndex()).toBe(labels().length - 1);
  });

  it('v2, text in the draft: no stop button; queue-send is the way forward', () => {
    renderButton({ presentation: 'v2', hasText: true });
    expect(labels()).not.toContain('Stop generation');
    expect(labels()).toContain('Send message');
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

describe('ChatInput: execution status stays outside the composer', () => {
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

  it('classic: no duplicate banner; an accessible stop icon stays in the input controls', () => {
    renderRunning();
    expect(banner()).toBeNull();
    const stop = container.querySelector('button[aria-label="Stop generation"]');
    expect(stop).not.toBeNull();
    expect(stop?.querySelector('svg rect')).not.toBeNull();
    expect(stop?.textContent).not.toContain('取消');
  });

  it('split view: the redundant banner is removed regardless of shell preference', () => {
    act(() => writeShellPresentation('v2'));
    renderRunning();
    expect(banner()).toBeNull();
    expect(container.querySelector('button[aria-label="Stop generation"]')).not.toBeNull();
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

  it('classic host: the member execution bar remains alongside one composer stop', () => {
    renderCoveredSurface('classic');
    expect(banner()).toBeNull();
    expect(container.textContent).toContain('执行中');
    expect(container.querySelectorAll('button[aria-label="Stop generation"]')).toHaveLength(1);
  });

  it('v2 host (row mounted): the bar is gone and the row says the run could not be re-read', () => {
    renderCoveredSurface('v2');
    expect(banner()).toBeNull();
    const row = container.querySelector('[data-testid="execution-row"]');
    expect(row).not.toBeNull();
    // Both shells preserve the stale qualifier on the execution row.
    expect(row?.textContent).toContain('状态暂不可核对');
  });
});
