// @vitest-environment jsdom
/**
 * F097: Integration — ChatMessage renders CliOutputBlock instead of ToolEventsPanel + 💭心里话
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../shell/shell-presentation';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], isLoading: false, getCatById: () => undefined, getCatsByBreed: () => new Map() }),
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
  // These assertions exercise the retained classic presentation explicitly.
  writeShellPresentation('classic');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useChatStore.getState().setUiThinkingExpandedByDefault(false);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
});

const getCatById = () => undefined;

describe('ChatMessage CLI Output integration', () => {
  it('renders "CLI Output" instead of "💭 心里话" for stream messages with tools', () => {
    const msg = {
      id: 'msg-1',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'stream stdout',
      origin: 'stream' as const,
      toolEvents: [{ id: 't1', type: 'tool_use' as const, label: 'Read foo.ts', timestamp: 1000 }],
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('CLI Output');
    expect(text).not.toContain('💭 心里话');
  });

  it('keeps 🧠 Thinking independent from CLI block', () => {
    const msg = {
      id: 'msg-2',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'final answer',
      thinking: 'reasoning here',
      origin: 'stream' as const,
      toolEvents: [{ id: 't1', type: 'tool_use' as const, label: 'Edit bar.ts', timestamp: 1000 }],
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    // Thinking should be independent
    expect(buttons.some((b) => b.textContent?.includes('Thinking'))).toBe(true);
    // CLI block should also exist
    expect(container.textContent).toContain('CLI Output');
  });

  it('callback origin: content text shown ABOVE CLI block', () => {
    const msg = {
      id: 'msg-3',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'Here is the answer',
      origin: 'callback' as const,
      toolEvents: [{ id: 't1', type: 'tool_use' as const, label: 'Read x.ts', timestamp: 1000 }],
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    const text = container.textContent ?? '';
    const answerIdx = text.indexOf('Here is the answer');
    const cliIdx = text.indexOf('CLI Output');
    expect(answerIdx).toBeGreaterThanOrEqual(0);
    expect(cliIdx).toBeGreaterThan(answerIdx);
  });

  it('stream origin with only content (no tools) still renders CLI block', () => {
    const msg = {
      id: 'msg-4',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'some CLI output',
      origin: 'stream' as const,
      timestamp: Date.now(),
      isStreaming: false,
    };
    act(() => {
      root.render(React.createElement(ChatMessage, { message: msg, getCatById }));
    });
    expect(container.textContent).toContain('CLI Output');
  });
});
