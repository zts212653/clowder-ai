/**
 * F252 Story Player — ReplayMessageList empty-state copy
 *
 * Regression coverage for zero-event replay states: callers can distinguish
 * "not started yet" from "there are no replayable events".
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayChatMessage } from '@/lib/story-player/replay-chat-bridge';
import { ReplayMessageList } from '../ReplayMessageList';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ReplayMessageList empty state', () => {
  it('uses the default play prompt when no custom empty state is provided', () => {
    const html = renderToStaticMarkup(<ReplayMessageList messages={[]} />);

    expect(html).toContain('Press play to start replay');
  });

  it('uses custom empty-state copy for zero-event replay contexts', () => {
    const html = renderToStaticMarkup(<ReplayMessageList messages={[]} emptyStateLabel="No replayable events yet" />);

    expect(html).toContain('No replayable events yet');
    expect(html).not.toContain('Press play to start replay');
  });
});

describe('ReplayMessageList visual parity', () => {
  it('uses the same cat bubble color contract as live Hub messages', () => {
    const message: ReplayChatMessage = {
      id: 'replay_assistant_1',
      type: 'assistant',
      catId: 'opus',
      content: '这个想法太好了。',
      timestamp: 1000,
      isStreaming: false,
    };

    const html = renderToStaticMarkup(<ReplayMessageList messages={[message]} />);

    expect(html).toContain('background-color:var(--cat-msg-surface)');
    expect(html).toContain('color:var(--cat-msg-text)');
    expect(html).not.toContain('--cat-msg-bg');
    expect(html).not.toContain('--cat-msg-bubble');
  });

  it('uses the same co-creator bubble color contract as live Hub messages', () => {
    const message: ReplayChatMessage = {
      id: 'replay_user_1',
      type: 'user',
      content: '这里还是有点问题？',
      timestamp: 1000,
      isStreaming: false,
    };

    const html = renderToStaticMarkup(<ReplayMessageList messages={[message]} />);

    expect(html).toContain('background-color:var(--color-cocreator-surface)');
    expect(html).toContain('color:var(--cat-msg-text)');
    expect(html).not.toContain('--co-creator-bubble-bg');
    expect(html).not.toContain('--co-creator-text');
  });
});

describe('ReplayMessageList auto-scroll', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollIntoView: ReturnType<typeof vi.fn<typeof HTMLElement.prototype.scrollIntoView>>;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    scrollIntoView = vi.fn<typeof HTMLElement.prototype.scrollIntoView>();
    HTMLElement.prototype.scrollIntoView = (arg?: boolean | ScrollIntoViewOptions) => {
      scrollIntoView(arg);
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    container.remove();
  });

  it('scrolls when a merged assistant turn grows without changing message count', () => {
    const baseMessage: ReplayChatMessage = {
      id: 'replay_1',
      type: 'assistant',
      content: 'First chunk',
      timestamp: 1000,
      isStreaming: false,
    };
    const expandedMessage: ReplayChatMessage = {
      ...baseMessage,
      content: 'First chunk\n\nSecond chunk from the same assistant turn',
    };

    act(() => {
      root.render(<ReplayMessageList messages={[baseMessage]} />);
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(<ReplayMessageList messages={[expandedMessage]} />);
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
