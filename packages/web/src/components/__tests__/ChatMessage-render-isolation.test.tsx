import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';

describe('ChatMessage render isolation', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      currentThreadId: 'thread-render',
      messages: [],
      threads: [],
      isLoadingThreads: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not rerender an ordinary historical bubble when an unrelated message changes', () => {
    const message: ChatMessageData = {
      id: 'message-stable',
      type: 'assistant',
      catId: 'codex-sol',
      content: 'stable historical reply',
      timestamp: 1,
    };
    useChatStore.setState({ messages: [message] });
    const getCatById = vi.fn(() => undefined);

    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-render" getCatById={getCatById} />);
    });
    const callsAfterInitialRender = getCatById.mock.calls.length;

    act(() => {
      useChatStore.setState({
        messages: [
          message,
          {
            id: 'message-streaming',
            type: 'assistant',
            catId: 'opus',
            content: 'new streaming delta',
            isStreaming: true,
            timestamp: 2,
          },
        ],
      });
    });

    expect(getCatById).toHaveBeenCalledTimes(callsAfterInitialRender);
  });

  it('presents a human modification source by work title and named cat while preserving the actual human wording', () => {
    const message: ChatMessageData = {
      id: 'human-modification-source',
      type: 'user',
      content: '请移除画面右上角的标志。',
      timestamp: 1,
      extra: {
        contentModificationRequestV1: {
          v: 1,
          requestId: 'f309-modification-' + 'a'.repeat(64),
          requestFingerprint: 'sha256:' + 'b'.repeat(64),
          contentTitle: '晨光封面',
          targetCatId: 'codex-astra',
          targetName: '小星星',
          executionThreadTitle: '封面共创',
          completionRule: 'file-writeback-applied',
        },
      },
    };
    act(() => root.render(<ChatMessage message={message} threadId="thread-render" getCatById={() => undefined} />));
    expect(container.textContent).toContain('请小星星修改《晨光封面》');
    expect(container.textContent).toContain(message.content);
    expect(container.textContent).not.toContain('sha256:');
    expect(container.querySelector('details')?.textContent).toContain('封面共创');
  });

  it('shows the saved companion face and keeps the actual Live carrier attributable', () => {
    const message: ChatMessageData = {
      id: 'live-history-1',
      type: 'assistant',
      catId: 'codex6-sol',
      content: '我找到了上次说的那一段。',
      timestamp: 1,
      extra: {
        liveCompanion: {
          modality: 'voice',
          identity: {
            v: 1,
            name: '猫猫球',
            partner: { catId: 'fable-5', displayName: '宪宪', skin: 'xianxian-codex' },
            live: { catId: 'codex6-sol', displayName: '砚砚', transport: 'gpt_live_v3', verifiedModel: null },
            deep: { catId: 'fable-5', displayName: '宪宪', verifiedModel: null },
          },
        },
      },
    };
    act(() => root.render(<ChatMessage message={message} threadId="thread-render" getCatById={() => undefined} />));
    expect(container.querySelector('[data-testid="companion-avatar"]')?.getAttribute('data-companion-cat-id')).toBe(
      'fable-5',
    );
    expect(container.querySelector('[data-testid="companion-avatar"] img')?.getAttribute('src')).toBe(
      '/avatars/claude-fable-5.png',
    );
    expect(container.querySelector('[data-testid="message-header"]')?.textContent).toContain('猫猫球 · 宪宪');
    expect(container.textContent).toContain('当时由宪宪陪伴');
    expect(container.textContent).toContain('实际发言：砚砚');
    expect(container.textContent).toContain('Live 快端：砚砚 · 型号未核实');
    expect(message.catId).toBe('codex6-sol');

    act(() =>
      root.render(
        <ChatMessage
          message={{ ...message, catId: 'other-cat' }}
          threadId="thread-render"
          getCatById={() => undefined}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="companion-avatar"]')).toBeNull();
  });

  it('keeps a legacy Live message on its real author when no identity snapshot exists', () => {
    const message: ChatMessageData = {
      id: 'legacy-live-history',
      type: 'assistant',
      catId: 'codex6-sol',
      content: '旧语音消息',
      timestamp: 2,
      extra: { liveCompanion: { modality: 'voice' } },
    };
    act(() =>
      root.render(<ChatMessage compact message={message} threadId="thread-render" getCatById={() => undefined} />),
    );
    expect(container.querySelector('[data-testid="companion-avatar"]')).toBeNull();
    expect(container.textContent).toContain('codex6-sol');
    expect(container.textContent).not.toContain('猫猫球 ·');
  });

  it('attributes a saved deep reply to the selected partner rather than the Live carrier', () => {
    const message: ChatMessageData = {
      id: 'deep-history-1',
      type: 'assistant',
      catId: 'fable-5',
      content: '这是我想清楚后的回答。',
      timestamp: 3,
      extra: {
        liveCompanion: {
          modality: 'result',
          identity: {
            v: 1,
            name: '猫猫球',
            partner: { catId: 'fable-5', displayName: '宪宪', skin: 'xianxian-codex' },
            live: { catId: 'codex6-sol', displayName: '砚砚', transport: 'gpt_live_v3', verifiedModel: null },
            deep: { catId: 'fable-5', displayName: '宪宪', verifiedModel: 'Claude Fable 5' },
          },
        },
      },
    };
    act(() => root.render(<ChatMessage message={message} threadId="thread-render" getCatById={() => undefined} />));
    expect(container.querySelector('[data-testid="companion-avatar"]')?.getAttribute('data-companion-cat-id')).toBe(
      'fable-5',
    );
    expect(container.textContent).toContain('当时由宪宪陪伴 · 实际发言：宪宪');
    expect(container.textContent).toContain('深思端：宪宪 · Claude Fable 5');
    expect(container.textContent).not.toContain('实际发言：砚砚');
    expect(message.catId).toBe('fable-5');
  });
});
