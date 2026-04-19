/**
 * F097: Thinking UI behavior — updated for CliOutputBlock architecture
 * - 🧠 Thinking: independent collapsible (ThinkingContent)
 * - CLI output (stream content + tools): rendered via CliOutputBlock
 * - Default is COLLAPSED (reduce fatigue)
 * - `Thread.thinkingMode` is cross-cat visibility semantics, NOT UI expansion state
 * - Bubble display: global defaults (Config Hub) + thread-level overrides (three-state)
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBubbleExpanded, useChatStore } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

// Stub TTS hook (ChatMessage uses it)
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

// Stub heavy sub-components
vi.mock('../RichBlocks', () => ({ RichBlocks: () => null }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

const { ChatMessage } = await import('../ChatMessage');

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
  // Stable default for each test (independent of localStorage)
  useChatStore.getState().setLoadingThreads(false);
  useChatStore.getState().setUiThinkingExpandedByDefault(false);
  useChatStore.getState().setGlobalBubbleDefaults({ thinking: 'collapsed', cliOutput: 'collapsed' });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const thinkingMessage = {
  id: 'msg-1',
  type: 'assistant' as const,
  catId: 'opus',
  content: 'CLI stream output text',
  thinking: 'Extended reasoning content here',
  origin: 'stream' as const,
  timestamp: Date.now(),
  isStreaming: false,
};

const getCatById = () => undefined;

describe('ThinkingContent default collapse', () => {
  it('default: thinking is collapsed, CLI output block is collapsed', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: thinkingMessage,
          getCatById,
        }),
      );
    });

    const buttons = container.querySelectorAll('button');
    const thinkingButton = Array.from(buttons).find((b) => b.textContent?.includes('Thinking'));
    const cliButton = Array.from(buttons).find((b) => b.textContent?.includes('CLI Output'));

    expect(thinkingButton).toBeTruthy();
    expect(cliButton).toBeTruthy();

    // Thinking expanded content should NOT be visible (collapsed)
    const markdownDivs = container.querySelectorAll('.cli-output-md');
    expect(markdownDivs.length).toBe(0);
  });

  it('global toggle: enabling expands thinking block', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: thinkingMessage,
          getCatById,
        }),
      );
    });

    expect(container.querySelectorAll('.cli-output-md').length).toBe(0);

    // Flip global bubble default → should expand thinking (ThinkingContent uses border-l-2)
    act(() => {
      useChatStore.getState().setGlobalBubbleDefaults({ thinking: 'expanded', cliOutput: 'collapsed' });
    });

    // Only 🧠 Thinking uses the border-l-2 style (CliOutputBlock uses terminal substrate)
    const markdownDivs = container.querySelectorAll('.cli-output-md');
    expect(markdownDivs.length).toBe(1); // only 🧠 Thinking
  });
});

describe('resolveBubbleExpanded', () => {
  it('thread override takes precedence over global default', () => {
    expect(resolveBubbleExpanded('expanded', 'collapsed')).toBe(true);
    expect(resolveBubbleExpanded('collapsed', 'expanded')).toBe(false);
  });

  it('global default is used when thread override is "global" or undefined', () => {
    expect(resolveBubbleExpanded('global', 'expanded')).toBe(true);
    expect(resolveBubbleExpanded('global', 'collapsed')).toBe(false);
    expect(resolveBubbleExpanded(undefined, 'expanded')).toBe(true);
    expect(resolveBubbleExpanded(undefined, 'collapsed')).toBe(false);
  });
});
