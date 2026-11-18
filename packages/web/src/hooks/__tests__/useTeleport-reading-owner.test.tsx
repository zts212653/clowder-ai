import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useChatStore } from '@/stores/chatStore';
import { withHubSocket } from '@/test-utils/fake-hub-socket';
import { apiFetch } from '@/utils/api-client';
import { CHAT_LAYOUT_CHANGED_EVENT } from '@/utils/chat-layout-change';
import { __resetChatScrollMemoryForTest, readChatScrollState } from '@/utils/chat-scroll-memory';
import { __resetMessageSourceForTest } from '@/utils/entrusted-message-source';
import { __resetPendingTeleportForTest, peekPendingTeleport } from '@/utils/teleport';
import { useChatHistory } from '../useChatHistory';
import { useTeleport } from '../useTeleport';
import { navigateToEntrustedWorkAction, useWorkspaceNavigate } from '../useWorkspaceNavigate';

vi.unmock('next/navigation');
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/offline-store', () => ({
  loadThreadMessages: vi.fn().mockResolvedValue(null),
  saveThreadMessages: vi.fn().mockResolvedValue(undefined),
  loadThreadActiveState: vi.fn().mockResolvedValue(null),
  saveThreadActiveState: vi.fn().mockResolvedValue(undefined),
  loadThreadWorkspaceState: vi.fn().mockResolvedValue(null),
}));

const THREAD = 'cold-source-thread';
const SOURCE = 'source-message';
const messages = [
  { id: SOURCE, type: 'assistant' as const, catId: 'codex61-sol', timestamp: 1, content: 'Source' },
  { id: 'latest', type: 'assistant' as const, catId: 'codex61-sol', timestamp: 2, content: 'Latest' },
];
let history: ReturnType<typeof useChatHistory>;
let top = 0;
let richShift = 0;
let richHidden = false;
let richAbsent = false;
let viewport: HTMLElement;
let root: Root;
let host: HTMLElement;
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Reading fixture node is missing');
  return value;
}

function Reader() {
  history = useChatHistory(THREAD);
  useLayoutEffect(() => {
    const el = required(history.scrollContainerRef.current);
    viewport = el;
    Object.defineProperties(el, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
        },
      },
    });
    el.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
    const boundary = required(el.querySelector<HTMLElement>('[data-message-viewport-id]'));
    boundary.getBoundingClientRect = () => ({ top: 600 - top, bottom: 800 - top, height: 200 }) as DOMRect;
    const source = required(el.querySelector<HTMLElement>('[data-message-id]'));
    source.getBoundingClientRect = boundary.getBoundingClientRect;
    required(source.querySelector('p')).getBoundingClientRect = () =>
      ({ top: 610 - top, bottom: 615 - top, height: 5 }) as DOMRect;
    source.scrollIntoView = vi.fn(() => {
      top = 400;
    });
    const card = el.querySelector<HTMLElement>('[data-rich-block-id]');
    if (card) {
      card.getBoundingClientRect = () =>
        (richHidden
          ? { top: 0, bottom: 0, height: 0 }
          : { top: 620 + richShift - top, bottom: 660 + richShift - top, height: 40 }) as DOMRect;
      card.scrollIntoView = vi.fn(() => {
        top = 420 + richShift;
      });
    }
    required(history.messagesEndRef.current).scrollIntoView = vi.fn(() => {
      top = 1400;
    });
  }, []);
  return (
    <div ref={history.scrollContainerRef} onScroll={history.handleScroll} data-chat-container>
      <div data-message-viewport-id={SOURCE}>
        <div data-message-id={SOURCE}>
          <p>Source paragraph before the card</p>
          {!richAbsent && (
            <button type="button" data-rich-block-id="source-card">
              Original card
            </button>
          )}
        </div>
      </div>
      <div ref={history.messagesEndRef} />
    </div>
  );
}

function Intake() {
  useTeleport();
  return null;
}
function Host() {
  useWorkspaceNavigate(THREAD, { isChatRoute: true, enabled: true });
  return (
    <ThreadChatHistoryAdmissionProvider>
      <Reader />
      <Intake />
    </ThreadChatHistoryAdmissionProvider>
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  __resetChatScrollMemoryForTest();
  __resetPendingTeleportForTest();
  __resetMessageSourceForTest();
  frames.clear();
  top = 0;
  richShift = 0;
  richHidden = false;
  richAbsent = false;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++frameId, cb);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ messages, hasMore: false }) } as Response);
  useChatStore.setState({
    currentThreadId: 'default',
    messages: [],
    threadStates: {},
    isLoadingHistory: false,
    hasMore: false,
  });
  useChatStore.getState().replaceThreadMessages(THREAD, messages, false);
  window.history.replaceState({}, '', `/thread/${THREAD}?message=${SOURCE}`);
  host = document.createElement('div');
  document.body.append(host);
  root = withHubSocket(createRoot(host));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetPendingTeleportForTest();
});

async function flushFrames(count = 20) {
  for (let i = 0; i < count; i++) {
    await act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((cb) => {
        cb(performance.now());
      });
    });
  }
}

it('wakes the actual reading owner when the initial source precedes current-thread synchronization', async () => {
  await act(async () => root.render(<Host />));
  expect(window.location.search).toBe('');
  expect(peekPendingTeleport(THREAD)?.messageId).toBe(SOURCE);
  expect(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1')).not.toBeNull();
  expect(document.activeElement).not.toBe(viewport.querySelector('[data-message-id]'));
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await flushFrames();
  expect(peekPendingTeleport(THREAD)).toBeNull();
  expect(readChatScrollState(THREAD)).toMatchObject({ anchor: 'offset', messageAnchor: { messageId: SOURCE } });
  expect(top).toBe(400);
  expect(viewport.querySelector('[data-message-id]')).toBe(document.activeElement);
});

it('uses that same owner for a rich block and focuses only after its exact arrival', async () => {
  window.history.replaceState({}, '', `/thread/${THREAD}?message=${SOURCE}&block=source-card`);
  await act(async () => root.render(<Host />));
  expect(document.activeElement).not.toBe(viewport.querySelector('[data-rich-block-id]'));
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await flushFrames();
  expect(top).toBe(420);
  expect(readChatScrollState(THREAD)).toMatchObject({ anchor: 'offset', messageAnchor: { messageId: SOURCE } });
  expect(document.activeElement).toBe(viewport.querySelector('[data-rich-block-id]'));
  expect(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1')).toBeNull();
});

it('waits for the source card itself to stop moving inside a stationary message', async () => {
  window.history.replaceState({}, '', `/thread/${THREAD}?message=${SOURCE}&block=source-card`);
  await act(async () => root.render(<Host />));
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await flushFrames(1);
  for (const shift of [40, 80, 120, 160, 200]) {
    richShift = shift;
    await flushFrames(1);
  }
  expect(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1')).not.toBeNull();
  expect(document.activeElement).not.toBe(viewport.querySelector('[data-rich-block-id]'));
  await flushFrames();
  expect(document.activeElement).toBe(viewport.querySelector('[data-rich-block-id]'));
});

it('keeps the exact card visible when earlier content in that same message grows after settlement', async () => {
  window.history.replaceState({}, '', `/thread/${THREAD}?message=${SOURCE}&block=source-card`);
  await act(async () => root.render(<Host />));
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await flushFrames();
  const card = required(viewport.querySelector<HTMLElement>('[data-rich-block-id]'));
  const originalTop = card.getBoundingClientRect().top;
  richShift = 400;
  await act(async () => window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT)));
  await flushFrames();
  expect(card.getBoundingClientRect().top).toBe(originalTop);
  expect(top).toBe(820);
});

it('does not consume a mounted source card before it has visible geometry', async () => {
  richHidden = true;
  window.history.replaceState({}, '', `/thread/${THREAD}?message=${SOURCE}&block=source-card`);
  await act(async () => root.render(<Host />));
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await flushFrames();
  expect(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1')).not.toBeNull();
  expect(document.activeElement).not.toBe(viewport.querySelector('[data-rich-block-id]'));
  richHidden = false;
  await flushFrames();
  expect(document.activeElement).toBe(viewport.querySelector('[data-rich-block-id]'));
});

it('restores an ordinary revisit to the surviving message after its completed source card was removed', async () => {
  window.history.replaceState({}, '', `/thread/${THREAD}?message=${SOURCE}&block=source-card`);
  await act(async () => root.render(<Host />));
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await flushFrames();
  expect(top).toBe(420);
  expect(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1')).toBeNull();
  await act(async () => root.render(null));
  __resetChatScrollMemoryForTest();
  expect(readChatScrollState(THREAD)).toMatchObject({ messageAnchor: { richBlockId: 'source-card' } });
  richAbsent = true;
  top = 0;
  await act(async () => root.render(<Host />));
  await flushFrames(110);
  expect(viewport.querySelector('[data-message-id]')).not.toBeNull();
  expect(top).toBe(420);
  expect(peekPendingTeleport(THREAD)).toBeNull();
});

it('keeps an explicit return receipt unavailable when its source card is gone', async () => {
  window.history.replaceState({}, '', `/thread/${THREAD}?message=${SOURCE}&block=source-card`);
  await act(async () => root.render(<Host />));
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await flushFrames();
  const position = readChatScrollState(THREAD);
  if (!position) throw new Error('Expected the completed source position');
  required(viewport.querySelector('[data-rich-block-id]')).remove();
  let receipt: ReturnType<typeof history.restoreReadingPosition> | undefined;
  await act(async () => {
    receipt = history.restoreReadingPosition({ threadId: THREAD, position });
  });
  await flushFrames(110);
  await expect(receipt).resolves.toMatchObject({ status: 'unavailable' });
});

it.each([false, true])('retires a source that stays outside its clamped reader, block=%s', async (block) => {
  await act(async () => root.render(<Host />));
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await flushFrames();
  const source = required(viewport.querySelector<HTMLElement>('[data-message-id]'));
  const boundary = required(viewport.querySelector<HTMLElement>('[data-message-viewport-id]'));
  const card = required(source.querySelector<HTMLElement>('[data-rich-block-id]'));
  source.blur();
  top = 0;
  Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => 0, set: () => {} });
  boundary.getBoundingClientRect = source.getBoundingClientRect = () =>
    ({ top: 700, bottom: 900, height: 200 }) as DOMRect;
  card.getBoundingClientRect = () => ({ top: 720, bottom: 760, height: 40 }) as DOMRect;
  source.scrollIntoView = card.scrollIntoView = vi.fn();
  await act(async () => {
    expect(navigateToEntrustedWorkAction(`message:${THREAD}:${SOURCE}${block ? '#source-card' : ''}`)).toBe(true);
  });
  await flushFrames();
  expect(document.activeElement).not.toBe(block ? card : source);
  expect(JSON.parse(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1') ?? '{}').retired).toBe(true);
});

it('does not finish or consume the source when native input interrupts arrival', async () => {
  await act(async () => root.render(<Host />));
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })));
  top = 900;
  await flushFrames();
  expect(top).toBe(900);
  expect(document.activeElement).not.toBe(viewport.querySelector('[data-message-id]'));
  expect(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1')).not.toBeNull();
});

it('retires a cancelled request through route exit/remount, while an explicit same-source retry still works', async () => {
  await act(async () => root.render(<Host />));
  const original = JSON.parse(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1') ?? '{}');
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await act(async () => {
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    top = 900;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await flushFrames();
  await act(async () => {
    root.render(null);
    useChatStore.getState().setCurrentThread('another-route');
  });
  top = 0;
  await act(async () => {
    useChatStore.getState().setCurrentThread(THREAD);
    root.render(<Host />);
  });
  await flushFrames();
  expect(top).toBe(900);
  expect(document.activeElement).not.toBe(viewport.querySelector('[data-message-id]'));
  expect(peekPendingTeleport(THREAD)).toBeNull();
  const retained = JSON.parse(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1') ?? '{}');
  expect(retained.requestId).toBe(original.requestId);
  expect(retained.retired).toBe(true);
  await act(async () => {
    expect(navigateToEntrustedWorkAction(`message:${THREAD}:${SOURCE}`)).toBe(true);
  });
  const retry = JSON.parse(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1') ?? '{}');
  expect(retry.requestId).not.toBe(original.requestId);
  await flushFrames();
  expect(top).toBe(400);
  expect(document.activeElement).toBe(viewport.querySelector('[data-message-id]'));
  expect(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1')).toBeNull();
});

it('retires an exhausted source receipt once, leaving later route mounts at their normal opening position', async () => {
  const ghost = { ...messages[0], id: 'ghost-message' };
  useChatStore.getState().replaceThreadMessages(THREAD, [...messages, ghost], false);
  useChatStore.getState().setCurrentThread(THREAD);
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [...messages, ghost], hasMore: false }),
  } as Response);
  window.history.replaceState({}, '', `/thread/${THREAD}`);
  await act(async () => root.render(<Host />));
  await flushFrames();
  expect(top).toBe(1400);
  await act(async () => {
    navigateToEntrustedWorkAction(`message:${THREAD}:${ghost.id}`);
  });
  await flushFrames(110);
  const source = JSON.parse(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1') ?? '{}');
  expect(source.retired).toBe(true);
  for (let visit = 0; visit < 3; visit++) {
    await act(async () => {
      root.render(null);
      useChatStore.getState().setCurrentThread('another-route');
    });
    top = 0;
    await act(async () => {
      useChatStore.getState().setCurrentThread(THREAD);
      root.render(<Host />);
    });
    await flushFrames(110);
    expect(top).toBe(1400);
    expect(peekPendingTeleport(THREAD)).toBeNull();
  }
  await act(async () => {
    expect(navigateToEntrustedWorkAction(`message:${THREAD}:${ghost.id}`)).toBe(true);
  });
  const retry = JSON.parse(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1') ?? '{}');
  expect(retry.requestId).not.toBe(source.requestId);
  expect(retry.retired).not.toBe(true);
});

it.each([
  '',
  '&block=source-card',
])('registers and settles a native source without secure-context randomUUID: %s', async (suffix) => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal('crypto', { getRandomValues });
  window.history.replaceState({}, '', `/thread/${THREAD}?message=${SOURCE}${suffix}`);
  await act(async () => root.render(<Host />));
  const firstId = peekPendingTeleport(THREAD)?.sourceAction?.requestId;
  expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
  await act(async () => useChatStore.getState().setCurrentThread(THREAD));
  await flushFrames();
  expect(document.activeElement).toBe(viewport.querySelector(suffix ? '[data-rich-block-id]' : '[data-message-id]'));
  await act(async () => {
    navigateToEntrustedWorkAction(`message:${THREAD}:${SOURCE}${suffix ? '#source-card' : ''}`);
  });
  const retry = JSON.parse(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1') ?? '{}');
  expect(retry.requestId).not.toBe(firstId);
  await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })));
  await flushFrames();
  expect(JSON.parse(sessionStorage.getItem('cat-cafe:f310:pending-source-action:v1') ?? '{}').retired).toBe(true);
});
