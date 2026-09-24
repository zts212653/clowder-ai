import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { getOrderedMessageTimeline } from '@/stores/message-timeline';
import { TIMELINE_ORDER_ROUND_INTERVAL_MS, useViewportMessageTimeline } from '../useViewportMessageTimeline';

function message(id: string, time: number): ChatMessage {
  return { id, type: 'assistant', catId: 'opus', content: id, timestamp: time, timelineOrderAt: time };
}

describe('useViewportMessageTimeline', () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T00:00:00Z'));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('updates content immediately but moves existing cards only at the next serial round', () => {
    let displayed: ChatMessage[] = [];
    const Probe = ({ messages }: { messages: ChatMessage[] }) => {
      displayed = useViewportMessageTimeline('thread-a', messages);
      return React.createElement('div', null, displayed.map((item) => `${item.id}:${item.content}`).join('|'));
    };
    const first: [ChatMessage, ChatMessage] = [message('a', 10), message('b', 20)];
    act(() => root.render(React.createElement(Probe, { messages: first })));

    const updated: [ChatMessage, ChatMessage] = [{ ...first[0], timelineOrderAt: 30, content: 'chunk 1' }, first[1]];
    act(() => root.render(React.createElement(Probe, { messages: updated })));
    expect(host.textContent).toBe('a:chunk 1|b:b');

    const later: [ChatMessage, ChatMessage] = [{ ...updated[0], timelineOrderAt: 40, content: 'chunk 2' }, first[1]];
    act(() => root.render(React.createElement(Probe, { messages: later })));
    expect(host.textContent).toBe('a:chunk 2|b:b');
    act(() => vi.advanceTimersByTime(TIMELINE_ORDER_ROUND_INTERVAL_MS - 1));
    expect(displayed.map((item) => item.id)).toEqual(['a', 'b']);
    act(() => vi.advanceTimersByTime(1));
    expect(displayed.map((item) => item.id)).toEqual(getOrderedMessageTimeline(later).map((item) => item.id));
    expect(host.textContent).toBe('b:b|a:chunk 2');

    const newest = [{ ...later[0], timelineOrderAt: 5, content: 'chunk 3' }, first[1]];
    act(() => root.render(React.createElement(Probe, { messages: newest })));
    expect(host.textContent).toBe('b:b|a:chunk 3');
    act(() => vi.advanceTimersByTime(TIMELINE_ORDER_ROUND_INTERVAL_MS));
    expect(displayed.map((item) => item.id)).toEqual(getOrderedMessageTimeline(newest).map((item) => item.id));
  });

  it('leaves a terminal transition in place until another round and shows new rows immediately', () => {
    let displayed: ChatMessage[] = [];
    const Probe = ({ messages }: { messages: ChatMessage[] }) => {
      displayed = useViewportMessageTimeline('thread-a', messages);
      return React.createElement('div', null, displayed.map((item) => item.id).join('|'));
    };
    const first: [ChatMessage, ChatMessage] = [{ ...message('a', 10), isStreaming: true }, message('b', 20)];
    act(() => root.render(React.createElement(Probe, { messages: first })));
    const next = [{ ...first[0], isStreaming: false, timelineOrderAt: 40 }, first[1], message('new', 25)];
    act(() => root.render(React.createElement(Probe, { messages: next })));
    expect(displayed.map((item) => item.id).filter((id) => id !== 'new')).toEqual(['a', 'b']);
    expect(displayed.some((item) => item.id === 'new')).toBe(true);
    act(() => vi.advanceTimersByTime(TIMELINE_ORDER_ROUND_INTERVAL_MS));
    expect(displayed.map((item) => item.id)).toEqual(getOrderedMessageTimeline(next).map((item) => item.id));
  });

  it('discards a pending old-thread round on route change', () => {
    let displayed: ChatMessage[] = [];
    const Probe = ({ threadId, messages }: { threadId: string; messages: ChatMessage[] }) => {
      displayed = useViewportMessageTimeline(threadId, messages);
      return React.createElement('div', null, displayed.map((item) => item.id).join('|'));
    };
    const first: [ChatMessage, ChatMessage] = [message('old-a', 10), message('old-b', 20)];
    act(() => root.render(React.createElement(Probe, { threadId: 'old', messages: first })));
    act(() =>
      root.render(
        React.createElement(Probe, { threadId: 'old', messages: [{ ...first[0], timelineOrderAt: 30 }, first[1]] }),
      ),
    );
    const next = [message('new-b', 20), message('new-a', 10)];
    act(() => root.render(React.createElement(Probe, { threadId: 'new', messages: next })));
    expect(displayed.map((item) => item.id)).toEqual(['new-a', 'new-b']);
    act(() => vi.advanceTimersByTime(TIMELINE_ORDER_ROUND_INTERVAL_MS));
    expect(displayed.map((item) => item.id)).toEqual(['new-a', 'new-b']);
  });
});
