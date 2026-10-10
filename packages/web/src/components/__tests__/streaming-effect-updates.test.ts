/**
 * F117 baseline B (2026-09-28): while replies stream, `messages` changes on nearly every commit. An effect keyed on
 * it that calls setState even when nothing changed leaves the "no change" check to React, and React cannot skip the
 * call while the component has other work pending, so each call becomes a real update scheduled from the commit
 * phase. The React build Next ships counts those as nested updates and throws "Maximum update depth exceeded" once a
 * chain passes 50 (reproduced in alpha with two live streams, see the baseline record).
 *
 * These tests count the state updates scheduled while a component's passive effects run, through the profiling
 * hooks React DevTools uses. The hook must exist before react-dom loads, so react-dom is imported dynamically.
 */
import type { RefObject } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';

type Fiber = { type?: unknown };
type ReactModule = typeof import('react');
type Root = import('react-dom/client').Root;
type ReactInternals = { injectProfilingHooks?: (hooks: Record<string, (...args: never[]) => void>) => void };

const effectUpdates = new Map<string, number>();
let effectOwner: Fiber | null = null;
let React: ReactModule;
let createRoot: typeof import('react-dom/client').createRoot;
let root: Root;
let container: HTMLDivElement;

function fiberName(fiber: Fiber): string {
  const type = fiber.type as { displayName?: string; name?: string } | string | undefined;
  if (!type) return '?';
  if (typeof type === 'string') return type;
  return type.displayName ?? type.name ?? 'anonymous';
}

function scheduledFromEffects(name: string): number {
  return effectUpdates.get(name) ?? 0;
}

function createSource<T>(initial: T) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next: T) {
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

beforeAll(async () => {
  // A holder object, not a `let`: TypeScript does not see the assignment inside `inject` and would narrow a local to `null`.
  const captured: { internals: ReactInternals | null } = { internals: null };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      renderers: new Map(),
      inject(value: ReactInternals) {
        captured.internals = value;
        return 1;
      },
      onScheduleFiberRoot() {},
      onCommitFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
    },
  });
  React = await import('react');
  ({ createRoot } = await import('react-dom/client'));
  captured.internals?.injectProfilingHooks?.({
    markComponentPassiveEffectMountStarted(fiber: Fiber) {
      effectOwner = fiber;
    },
    markComponentPassiveEffectMountStopped() {
      effectOwner = null;
    },
    markStateUpdateScheduled(fiber: Fiber) {
      if (!effectOwner) return;
      const name = fiberName(fiber);
      effectUpdates.set(name, scheduledFromEffects(name) + 1);
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  React.act(() => root.unmount());
  container.remove();
});

function message(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, type: 'assistant', catId: 'opus', content, timestamp: 1, ...extra } as ChatMessage;
}

/** A settled message followed by a reply whose text grows chunk by chunk, as the chat store delivers it. */
function streamingTimeline(chunks: number): ChatMessage[] {
  return [message('settled', 'done'), message('live', 'x'.repeat(chunks), { isStreaming: true })];
}

describe('F117 B: effects do not schedule an update on every streaming change', () => {
  it('counts an update scheduled from an effect (so the zero counts below cannot pass by the hooks missing)', () => {
    function ControlHarness() {
      const [, setMounted] = React.useState(false);
      React.useEffect(() => setMounted(true), []);
      return null;
    }
    effectUpdates.clear();

    React.act(() => root.render(React.createElement(ControlHarness)));

    expect(scheduledFromEffects('ControlHarness')).toBe(1);
  });

  it('message selection: with nothing selected, a streaming reply schedules no update from its effect', async () => {
    const { useThreadChatSelection } = await import('@/components/thread-chat/useThreadChatSelection');
    const source = createSource(streamingTimeline(1));
    function SelectionHarness() {
      useThreadChatSelection(React.useSyncExternalStore(source.subscribe, source.get));
      return null;
    }
    React.act(() => root.render(React.createElement(SelectionHarness)));
    effectUpdates.clear();

    for (let chunk = 2; chunk <= 12; chunk += 1) React.act(() => source.set(streamingTimeline(chunk)));

    expect(scheduledFromEffects('SelectionHarness')).toBe(0);
  });

  it('message selection: a selected message that goes away is still dropped from the selection', async () => {
    const { useThreadChatSelection } = await import('@/components/thread-chat/useThreadChatSelection');
    const source = createSource([message('keep', 'a'), message('gone', 'b')]);
    let selection: ReturnType<typeof useThreadChatSelection> | undefined;
    function SelectionHarness() {
      selection = useThreadChatSelection(React.useSyncExternalStore(source.subscribe, source.get));
      return null;
    }
    React.act(() => root.render(React.createElement(SelectionHarness)));
    React.act(() => selection?.enterMessageSelection('gone'));
    React.act(() => selection?.toggleMessageSelection('keep'));
    expect([...(selection?.selectedMessageIds ?? [])].sort()).toEqual(['gone', 'keep']);

    React.act(() => source.set([message('keep', 'a')]));

    expect([...(selection?.selectedMessageIds ?? [])]).toEqual(['keep']);
  });

  it('scroll-to-bottom button: at the bottom, a streaming reply schedules no update from its effects', async () => {
    const { ScrollToBottomButton } = await import('@/components/ScrollToBottomButton');
    const scrollEl = document.createElement('div');
    const endEl = document.createElement('div');
    scrollEl.appendChild(endEl);
    const setScroll = (top: number) => Object.defineProperty(scrollEl, 'scrollTop', { value: top, configurable: true });
    Object.defineProperty(scrollEl, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(scrollEl, 'scrollHeight', { value: 300, configurable: true });
    setScroll(0);
    const source = createSource('chunk-0');
    function ButtonHarness() {
      return React.createElement(ScrollToBottomButton, {
        scrollContainerRef: { current: scrollEl } as RefObject<HTMLElement>,
        messagesEndRef: { current: endEl } as RefObject<HTMLElement>,
        onJumpToLatest: () => {},
        recomputeSignal: React.useSyncExternalStore(source.subscribe, source.get),
      });
    }
    React.act(() => root.render(React.createElement(ButtonHarness)));
    expect(container.querySelector('button[aria-label="到最新"]')).toBeTruthy();
    // The reader catches up with the bottom: a real change of visibility.
    setScroll(200);
    React.act(() => scrollEl.dispatchEvent(new Event('scroll')));
    expect(container.querySelector('button[aria-label="到最新"]')).toBeNull();
    effectUpdates.clear();

    for (let chunk = 1; chunk <= 12; chunk += 1) React.act(() => source.set(`chunk-${chunk}`));

    expect(scheduledFromEffects('ScrollToBottomButton')).toBe(0);
    expect(container.querySelector('button[aria-label="到最新"]')).toBeNull();
  });
});
