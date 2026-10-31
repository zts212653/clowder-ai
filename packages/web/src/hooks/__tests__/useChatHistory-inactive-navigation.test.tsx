import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { DEFAULT_THREAD_STATE, useChatStore } from '@/stores/chatStore';
import { readChatScrollState, saveChatScrollState } from '@/utils/chat-scroll-memory';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ messages: [], queue: [], tasks: [], hasMore: false }),
  })),
}));

describe('independent chat surface navigation', () => {
  let host: HTMLDivElement;
  let root: Root;
  const hooks = new Map<string, ReturnType<typeof useChatHistory>>();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const messages = [{ id: 'same-target', type: 'assistant' as const, content: 'Visible target', timestamp: 1 }];
  function Probe({ threadId }: { threadId: string }) {
    const hook = useChatHistory(threadId);
    hooks.set(threadId, hook);
    return (
      <div ref={hook.scrollContainerRef}>
        <div ref={hook.messagesEndRef} />
      </div>
    );
  }
  function flush() {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((frame) => frame(16));
  }
  beforeEach(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    hooks.clear();
    frames.clear();
    frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    useChatStore.setState({
      ...DEFAULT_THREAD_STATE,
      currentThreadId: 'main-reading',
      messages,
      threadStates: {
        'main-reading': { ...DEFAULT_THREAD_STATE, messages },
        'independent-ball': { ...DEFAULT_THREAD_STATE, messages },
      },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <ThreadChatHistoryAdmissionProvider>
          <Probe threadId="main-reading" />
          <Probe threadId="independent-ball" />
        </ThreadChatHistoryAdmissionProvider>,
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  function viewport(threadId: string) {
    const hook = hooks.get(threadId)!;
    const el = hook.scrollContainerRef.current!;
    Object.defineProperty(el, 'scrollTop', { writable: true, configurable: true, value: 600 });
    Object.defineProperty(el, 'scrollHeight', { value: 1200 });
    Object.defineProperty(el, 'clientHeight', { value: 600 });
    el.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    hook.messagesEndRef.current!.scrollIntoView = vi.fn();
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = 'same-target';
    boundary.getBoundingClientRect = () => ({ top: 700 - el.scrollTop, bottom: 1000 - el.scrollTop }) as DOMRect;
    const target = document.createElement('div');
    target.dataset.messageId = 'same-target';
    target.scrollIntoView = vi.fn(() => {
      el.scrollTop = 350;
    });
    boundary.appendChild(target);
    el.appendChild(boundary);
    return { hook, el, target };
  }
  it('scrolls the independent panel while the main message jump continues untouched', () => {
    const main = viewport('main-reading');
    const panel = viewport('independent-ball');
    saveChatScrollState('independent-ball', { top: 777, anchor: 'offset' });
    saveChatScrollState('main-reading', { top: 600, anchor: 'bottom' });
    act(() => expect(main.hook.jumpToMessage('same-target')).toBe(true));
    const gesture = panel.hook.beginUserScroll();
    expect(gesture).not.toBeNull();
    act(() => expect(gesture!.scrollTo(200)).toBe(true));
    expect(panel.el.scrollTop).toBe(200);
    expect(main.target.scrollIntoView).not.toHaveBeenCalled();
    act(() => expect(panel.hook.jumpToMessage('same-target')).toBe(true));
    expect(panel.target.scrollIntoView).toHaveBeenCalledOnce();
    expect(panel.el.scrollTop).toBe(350);
    expect(main.target.scrollIntoView).not.toHaveBeenCalled();
    expect(readChatScrollState('independent-ball')).toEqual({ top: 777, anchor: 'offset' });
    act(() => {
      for (let n = 0; n < 5; n++) flush();
    });
    expect(main.target.scrollIntoView).toHaveBeenCalledOnce();
    expect(main.el.scrollTop).toBe(350);
    expect(readChatScrollState('main-reading')).toMatchObject({
      top: 350,
      anchor: 'offset',
      messageAnchor: { messageId: 'same-target', viewportOffsetPx: 250 },
    });
    expect(readChatScrollState('independent-ball')).toEqual({ top: 777, anchor: 'offset' });
  });
  it('never upgrades an old local gesture into a reading-state writer when its thread becomes active', () => {
    const panel = viewport('independent-ball');
    const gesture = panel.hook.beginUserScroll();
    expect(gesture).not.toBeNull();
    saveChatScrollState('independent-ball', { top: 777, anchor: 'offset' });
    act(() => useChatStore.getState().setCurrentThread('independent-ball'));
    expect(gesture!.scrollTo(200)).toBe(false);
    expect(readChatScrollState('independent-ball')).toEqual({ top: 777, anchor: 'offset' });
  });
});
