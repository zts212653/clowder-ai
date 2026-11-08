import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { SettingsReadingBridge } from '@/components/shell/settings-reading-bridge';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import {
  type RegisterChatReadingPort,
  useThreadChatReadingPort,
} from '@/components/thread-chat/useThreadChatReadingPort';
import { getThreadDraft, syncDraftToStorage } from '@/components/thread-drafts';
import { useChatHistory } from '@/hooks/useChatHistory';
import { type ChatMessage, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { __resetChatScrollMemoryForTest, captureChatReadingRef } from '@/utils/chat-scroll-memory';

export let hook: ReturnType<typeof useChatHistory>;
export let mounts = 0,
  unmounts = 0;
function Probe({
  tick = 0,
  register,
  threadId = 'origin',
}: {
  tick?: number;
  register?: RegisterChatReadingPort;
  threadId?: string;
}) {
  hook = useChatHistory(threadId);
  useThreadChatReadingPort(threadId, 'conversation', register, hook);
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return <div ref={hook.scrollContainerRef} data-tick={tick} />;
}
export function Host({
  tick = 0,
  visible = true,
  register,
  threadId = 'origin',
}: {
  tick?: number;
  visible?: boolean;
  register?: RegisterChatReadingPort;
  threadId?: string;
}) {
  return (
    <ThreadChatHistoryAdmissionProvider>
      {visible && <Probe tick={tick} register={register} threadId={threadId} />}
    </ThreadChatHistoryAdmissionProvider>
  );
}
const messages: ChatMessage[] = [
  { id: 'reading', timestamp: 100, type: 'assistant', catId: 'opus', content: 'original reading' },
  { id: 'latest', timestamp: 200, type: 'assistant', catId: 'opus', content: 'latest' },
];
export let root: Root;
let container: HTMLDivElement;
export let release: () => void;
const frames = new Map<number, FrameRequestCallback>();
let seq = 0;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
  localStorage.clear();
  __resetChatScrollMemoryForTest();
  frames.clear();
  mounts = 0;
  unmounts = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++seq, cb);
    return seq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  useChatStore.setState({
    currentThreadId: 'origin',
    messages: [],
    threadStates: {},
    isLoadingHistory: false,
    hasMore: false,
    isOfflineSnapshot: false,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  release?.();
  await Promise.resolve();
  container.remove();
  vi.unstubAllGlobals();
  vi.mocked(apiFetch).mockReset();
});
export async function flush(n = 6) {
  for (let i = 0; i < n; i++)
    await act(async () => {
      const work = [...frames.values()];
      frames.clear();
      work.forEach((cb) => {
        cb(i * 16);
      });
      await Promise.resolve();
    });
}
export async function open(cold: boolean) {
  const gate = new Promise<void>((r) => (release = r));
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.startsWith('/api/messages')) await gate;
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.startsWith('/api/messages')
          ? { messages, hasMore: false }
          : url.includes('navigation-source')
            ? { status: 'available', updated: false, target: { threadId: 'origin' } }
            : { tasks: [], queue: [], activeInvocations: [] },
    } as Response;
  });
  if (!cold) useChatStore.getState().replaceThreadMessages('origin', messages, false);
  await act(async () => root.render(<Host />));
  const el = hook.scrollContainerRef.current;
  if (!el) throw new Error('Missing original viewport');
  let top = 0;
  Object.defineProperties(el, {
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    },
    scrollHeight: { configurable: true, value: 1600 },
    clientHeight: { configurable: true, value: 600 },
  });
  el.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
  const boundary = document.createElement('div');
  boundary.dataset.messageViewportId = 'reading';
  boundary.getBoundingClientRect = () => ({ top: 480 - top, bottom: 680 - top }) as DOMRect;
  const body = document.createElement('div');
  body.dataset.messageId = 'reading';
  boundary.append(body);
  el.append(boundary);
  const ref = captureChatReadingRef({
    threadId: 'origin',
    position: {
      top: 400,
      anchor: 'offset',
      messageAnchor: { messageId: 'reading', viewportOffsetPx: -20, timelineOrderAt: 100 },
    },
  });
  if (!ref) throw new Error('Failed to capture fixture reading ref');
  let receipt!: ReturnType<typeof hook.restoreReadingRef>;
  let result: unknown = 'pending';
  act(() => {
    receipt = hook.restoreReadingRef(ref.ref, new AbortController().signal, { refresh: true });
    void receipt.then((value) => (result = value));
  });
  await flush(2);
  return { el, receipt, result: () => result, top: () => top };
}
export async function beginBridge() {
  syncDraftToStorage('origin', 'unsent original draft');
  syncDraftToStorage('other', 'a different thread draft');
  const draftMirror = sessionStorage.getItem('cat-cafe:thread-drafts');
  const checkDrafts = () => {
    expect(getThreadDraft('origin')).toBe('unsent original draft');
    expect(getThreadDraft('other')).toBe('a different thread draft');
    expect(sessionStorage.getItem('cat-cafe:thread-drafts')).toBe(draftMirror);
  };
  const state = await open(false);
  const pushes: string[] = [];
  const bridge = new SettingsReadingBridge((path) => pushes.push(path), 'boot76-probe', true);
  bridge.setRoute('/thread/origin', true);
  const seed = { threadId: 'origin', ownerId: 'pre-settings-owner', ...hook };
  const releaseSeed = bridge.registerReadingPort(seed, () => 'Original source');
  state.el.scrollTop = 400;
  bridge.captureBeforeSettings();
  const source = bridge.getSnapshot().source;
  if (!source) throw new Error('Missing captured source');
  expect(source).not.toBeNull();
  bridge.setRoute('/settings', true);
  releaseSeed();
  state.el.scrollTop = 0;
  await bridge.returnToSource(source.id);
  expect(pushes).toEqual(['/thread/origin']);
  bridge.setRoute('/thread/origin', true);
  const register: RegisterChatReadingPort = (port) => bridge.registerReadingPort(port, () => 'Original source');
  await act(async () => root.render(<Host register={register} />));
  expect(bridge.getSnapshot().returning).toBe(true);
  const allDiagnostics = () => JSON.parse(localStorage.getItem('cat-cafe:connection-diagnostics:v1') ?? '[]');
  const bridgeId = allDiagnostics().findLast(
    (r: { kind: string; phase: string }) => r.kind === 'settings_return' && r.phase === 'created',
  ).bridgeId;
  const diagnostics = () =>
    allDiagnostics().filter(
      (r: { kind: string; bridgeId: string }) => r.kind === 'settings_return' && r.bridgeId === bridgeId,
    );
  const readingDiagnostics = () =>
    allDiagnostics().filter(
      (r: { kind: string; bridgeId: string }) => r.kind === 'reading_restore' && r.bridgeId === bridgeId,
    );
  return { ...state, bridge, source, register, diagnostics, readingDiagnostics, checkDrafts };
}
