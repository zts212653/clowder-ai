import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageData, ToolEvent } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';
import { resetMessageDisclosureStateForTest } from '../message-disclosure-state';
import { ReplyRecallProjectionProvider } from '../reply-layers/ReplyRecallContext';
import type { ReplyRecallProjection } from '../reply-layers/reply-recall';
import { SHELL_PRESENTATION_STORAGE_KEY } from '../shell/shell-presentation';

const registry = vi.hoisted(() => ({ cats: [] as Array<{ id: string }> }));

vi.mock('@/hooks/useCatData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useCatData')>();
  return {
    ...actual,
    useCatData: () => ({
      getCatById: (id: string) => registry.cats.find((cat) => cat.id === id),
      cats: registry.cats,
      refresh: () => {},
    }),
  };
});

const OPUS = {
  id: 'opus',
  displayName: '布偶猫',
  nickname: '宪宪',
  breedId: 'ragdoll',
  avatar: '/avatars/opus.png',
  color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
  mentionPatterns: ['@opus'],
  clientId: 'anthropic',
  defaultModel: 'claude',
} as unknown as CatData;

const ASTRA = {
  id: 'codex-astra',
  displayName: '缅因猫 Astra',
  nickname: 'Astra',
  breedId: 'maine-coon',
  avatar: '/avatars/codex-astra.png',
  color: { primary: '#5B8C5A', secondary: '#E0EBDD' },
  mentionPatterns: ['@codex-astra'],
  clientId: 'openai',
  defaultModel: 'gpt-6-astra',
} as unknown as CatData;

export const tool = (id: string, label: string, detail?: string): ToolEvent => ({
  id,
  type: 'tool_use',
  label,
  detail,
  timestamp: 1_000,
});

export const toolResult = (id: string, detail: string, status: 'completed' | 'error' = 'completed'): ToolEvent => ({
  id: `${id}-result`,
  type: 'tool_result',
  label: `${id} result`,
  detail,
  status,
  timestamp: 1_001,
});

/** A streamed reply: provider text is content and its tool calls are toolEvents. */
export function streamReply(overrides: Partial<ChatMessageData> = {}): ChatMessageData {
  return {
    id: 'reply-1',
    type: 'assistant',
    catId: 'opus',
    from: { kind: 'agent', catId: overrides.catId ?? 'opus' },
    origin: 'stream',
    content: '改好了登录页，截图见下。',
    timestamp: Date.UTC(2026, 9, 5, 3, 0),
    toolEvents: [
      tool('t1', 'Bash', JSON.stringify({ command: 'pnpm test' })),
      toolResult('t1', 'exit 0'),
      tool('t2', 'Edit', JSON.stringify({ file_path: '/app/login.tsx' })),
      toolResult('t2', 'edited'),
    ],
    metadata: {
      provider: 'anthropic',
      model: 'claude-opus',
      usage: { inputTokens: 1200, outputTokens: 300, durationMs: 402_000 },
    },
    extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
    ...overrides,
  };
}

export function installReplyLayersActEnvironment(): void {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

export function uninstallReplyLayersActEnvironment(): void {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
}

export class ReplyLayersHarness {
  readonly container = document.createElement('div');
  readonly root: Root;

  constructor() {
    registry.cats = [OPUS, ASTRA];
    window.localStorage.clear();
    resetMessageDisclosureStateForTest();
    document.body.appendChild(this.container);
    this.root = createRoot(this.container);
    useChatStore.setState({
      currentThreadId: 'thread-1',
      messages: [],
      threads: [],
      isLoadingThreads: false,
      catStatuses: {},
      catInvocations: {},
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
    });
  }

  enableV2(): void {
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
  }

  setCatCatalogLoaded(loaded: boolean): void {
    registry.cats = loaded ? [OPUS, ASTRA] : [];
  }

  render(message: ChatMessageData): void {
    this.renderTimeline([message]);
  }

  renderTimeline(
    messages: readonly ChatMessageData[],
    recall: ReadonlyMap<string, ReplyRecallProjection> = new Map(),
    options: { compact?: boolean } = {},
  ): void {
    act(() => {
      this.root.render(
        <ReplyRecallProjectionProvider value={recall}>
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              compact={options.compact}
              threadId="thread-1"
              timelineMessages={messages}
              getCatById={(id) => registry.cats.find((cat) => cat.id === id) as CatData | undefined}
            />
          ))}
        </ReplyRecallProjectionProvider>,
      );
    });
  }

  q(testId: string): HTMLElement | null {
    return this.container.querySelector(`[data-testid="${testId}"]`);
  }

  run(action: () => void): void {
    act(action);
  }

  click(testId: string): void {
    this.run(() => this.q(testId)?.click());
  }

  dispose(): void {
    this.run(() => this.root.unmount());
    this.container.remove();
    window.localStorage.clear();
  }
}
