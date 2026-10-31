import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
      threads: [],
      currentThreadId: 'default',
    }),
  resolveBubbleExpanded: (override: string | undefined, globalDefault: string) => {
    if (override && override !== 'global') return override === 'expanded';
    return globalDefault === 'expanded';
  },
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ChatMessage layout-change event timing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('dispatches chat-layout-changed after thinking collapse state commits (cloud P2)', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');

    const message = {
      id: 'm1',
      type: 'assistant',
      catId: 'codex',
      timestamp: Date.now(),
      visibility: 'public',
      revealedAt: null,
      whisperTo: null,
      origin: 'assistant',
      variant: null,
      isStreaming: false,
      content: '',
      thinking: 'hello thinking',
      contentBlocks: null,
      toolEvents: null,
      metadata: null,
      summary: null,
      evidence: null,
      extra: null,
      source: null,
    } as const;

    let expandedPresentAtEvent: boolean | null = null;
    const handler = () => {
      expandedPresentAtEvent = Boolean(container.querySelector('div.cli-output-md'));
    };
    window.addEventListener('catcafe:chat-layout-changed', handler);

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: message as unknown as ChatMessageType,
          getCatById: () => undefined,
        }),
      );
    });

    const thinkingToggle = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Thinking'),
    );
    expect(thinkingToggle).toBeTruthy();

    act(() => {
      (thinkingToggle as HTMLButtonElement).click();
    });

    expect(container.querySelector('div.cli-output-md')).toBeTruthy();
    expect(expandedPresentAtEvent).toBe(true);

    window.removeEventListener('catcafe:chat-layout-changed', handler);
  });

  it('dispatches chat-layout-changed after CLI output block collapse state commits (cloud P2)', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');

    const message = {
      id: 'm2',
      type: 'assistant',
      catId: 'codex',
      timestamp: Date.now(),
      visibility: 'public',
      revealedAt: null,
      whisperTo: null,
      origin: 'assistant',
      variant: null,
      isStreaming: false,
      content: '',
      thinking: '',
      contentBlocks: null,
      toolEvents: [{ id: 't1', type: 'tool_use', label: 'tool 1', detail: 'detail-1', timestamp: 1000 }],
      metadata: null,
      summary: null,
      evidence: null,
      extra: null,
      source: null,
    } as const;

    let expandedPresentAtEvent: boolean | null = null;
    const handler = () => {
      // CliOutputBlock uses data-testid="cli-output-body" when expanded
      expandedPresentAtEvent = Boolean(container.querySelector('[data-testid="cli-output-body"]'));
    };
    window.addEventListener('catcafe:chat-layout-changed', handler);

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: message as unknown as ChatMessageType,
          getCatById: () => undefined,
        }),
      );
    });

    // F097: now uses CliOutputBlock summary line instead of ToolEventsPanel
    const cliToggle = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('CLI Output'),
    );
    expect(cliToggle).toBeTruthy();

    act(() => {
      (cliToggle as HTMLButtonElement).click();
    });

    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeTruthy();
    expect(expandedPresentAtEvent).toBe(true);

    window.removeEventListener('catcafe:chat-layout-changed', handler);
  });

  it('dispatches chat-layout-changed after tools and tool-detail disclosure commits', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const message = {
      id: 'm3',
      type: 'assistant',
      catId: 'codex',
      timestamp: Date.now(),
      visibility: 'public',
      revealedAt: null,
      whisperTo: null,
      origin: 'assistant',
      variant: null,
      isStreaming: false,
      content: '',
      thinking: '',
      contentBlocks: null,
      toolEvents: [
        { id: 'tool-1', type: 'tool_use', label: 'Read file', detail: '{"file_path":"README.md"}', timestamp: 1000 },
        { id: 'result-1', type: 'tool_result', label: 'Read result', detail: 'target detail', timestamp: 1001 },
      ],
      metadata: null,
      summary: null,
      evidence: null,
      extra: null,
      source: null,
    } as const;
    const snapshots: Array<{ tools: boolean; detail: boolean }> = [];
    const handler = () => {
      snapshots.push({
        tools: Boolean(container.querySelector('[data-testid="tool-row-tool-1"]')),
        detail: container.textContent?.includes('target detail') ?? false,
      });
    };
    window.addEventListener('catcafe:chat-layout-changed', handler);

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: message as unknown as ChatMessageType,
          getCatById: () => undefined,
        }),
      );
    });
    const cliToggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('CLI Output'),
    );
    act(() => (cliToggle as HTMLButtonElement).click());
    const toolsToggle = container.querySelector<HTMLButtonElement>('[data-testid="tools-section-toggle"]');
    act(() => toolsToggle?.click());
    const toolRow = container.querySelector<HTMLButtonElement>('[data-testid="tool-row-tool-1"]');
    act(() => toolRow?.click());

    expect(snapshots).toContainEqual({ tools: true, detail: false });
    expect(snapshots.at(-1)).toEqual({ tools: true, detail: true });

    window.removeEventListener('catcafe:chat-layout-changed', handler);
  });
});
