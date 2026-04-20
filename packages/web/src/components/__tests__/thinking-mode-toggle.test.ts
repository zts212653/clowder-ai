/**
 * Thinking UI behavior (2026-03-01):
 * - Default is COLLAPSED
 * - `Thread.thinkingMode` does NOT control UI expansion/collapse
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

// ── Stub hooks used by ChatMessage ──
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], isLoading: false, getCatById: () => undefined, getCatsByBreed: () => new Map() }),
  formatCatName: () => '布偶猫',
}));
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

// ── Stub heavy sub-components ──
vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('span', null, content),
}));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));
vi.mock('@/components/PlanBoardPanel', () => ({ PlanBoardPanel: () => null }));
vi.mock('@/components/SessionChainPanel', () => ({ SessionChainPanel: () => null }));
vi.mock('@/components/audit/AuditExplorerPanel', () => ({ AuditExplorerPanel: () => null }));

const THINKING_TEXT =
  'I am thinking about the meaning of cats and coffee, and why a refresh should still respect thread-specific bubble preferences.';

describe('F045: ThinkingContent thinkingMode toggle', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // Stable baseline for each test
    useChatStore.getState().setUiThinkingExpandedByDefault(false);
    useChatStore.getState().setGlobalBubbleDefaults({ thinking: 'collapsed', cliOutput: 'collapsed' });
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const thinkingMsg = {
    id: 't1',
    type: 'assistant' as const,
    catId: 'opus',
    content: 'visible reply',
    thinking: THINKING_TEXT,
    timestamp: Date.now(),
    contentBlocks: [],
  };

  const getCatById = vi.fn(() => ({
    id: 'opus',
    displayName: '布偶猫',
    color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
    breedId: 'ragdoll',
    clientId: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    avatar: '/avatars/opus.png',
    mentionPatterns: [],
    roleDescription: '',
    personality: '',
  }));

  it('default: thinking block is collapsed', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: thinkingMsg as never,
          getCatById: getCatById as never,
        }),
      );
    });

    // Collapsed: button visible with label, full thinking text NOT rendered
    const buttons = container.querySelectorAll('button');
    const thinkingButton = Array.from(buttons).find((b) => b.textContent?.includes('Thinking'));
    expect(thinkingButton).toBeTruthy();

    // Full content should NOT be in the DOM when collapsed
    // The border-l-2 div with MarkdownContent only renders when expanded
    const expandedBlocks = container.querySelectorAll('.cli-output-md');
    expect(expandedBlocks.length).toBe(0);
  });

  it('global toggle: expand then collapse re-renders already-mounted blocks', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');

    act(() => {
      useChatStore.getState().setLoadingThreads(false);
    });

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: thinkingMsg as never,
          getCatById: getCatById as never,
        }),
      );
    });

    expect(container.querySelectorAll('.cli-output-md').length).toBe(0);

    // Expand globally via bubble defaults
    act(() => {
      useChatStore.getState().setGlobalBubbleDefaults({ thinking: 'expanded', cliOutput: 'collapsed' });
    });

    expect(container.querySelectorAll('.cli-output-md').length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain(THINKING_TEXT);

    // Collapse globally again
    act(() => {
      useChatStore.getState().setGlobalBubbleDefaults({ thinking: 'collapsed', cliOutput: 'collapsed' });
    });

    expect(container.querySelectorAll('.cli-output-md').length).toBe(0);
  });

  it('thread-level bubble override loaded async beats initial global default after refresh-like hydration', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const { RightStatusPanel } = await import('@/components/RightStatusPanel');

    act(() => {
      useChatStore.setState({
        currentThreadId: 'thread-a',
        threads: [],
        isLoadingThreads: true,
        globalBubbleDefaults: { thinking: 'expanded', cliOutput: 'collapsed' },
      });
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(RightStatusPanel, {
            intentMode: null,
            targetCats: [],
            catStatuses: {},
            catInvocations: {},
            threadId: 'thread-a',
            messageSummary: { total: 1, assistant: 1, system: 0, evidence: 0, followup: 0 },
          }),
          React.createElement(ChatMessage, {
            message: thinkingMsg as never,
            getCatById: getCatById as never,
          }),
        ),
      );
    });

    expect(container.querySelectorAll('.cli-output-md').length).toBe(0);
    expect(container.textContent).not.toContain(THINKING_TEXT);
    expect(container.textContent).toContain('Thinking: 恢复中');
    expect(container.textContent).toContain('恢复中...');

    act(() => {
      useChatStore.setState({
        isLoadingThreads: false,
        threads: [
          {
            id: 'thread-a',
            projectPath: 'default',
            title: 'Thread A',
            createdBy: 'default-user',
            participants: [],
            lastActiveAt: Date.now(),
            createdAt: Date.now(),
            bubbleThinking: 'collapsed',
          },
        ],
      });
    });

    expect(container.querySelectorAll('.cli-output-md').length).toBe(0);
    expect(container.textContent).not.toContain(THINKING_TEXT);
  });

  it('restores expanded bubble after refresh once thread metadata hydrates', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');

    act(() => {
      useChatStore.setState({
        currentThreadId: 'thread-expanded',
        threads: [],
        isLoadingThreads: true,
        globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
      });
      root.render(
        React.createElement(ChatMessage, {
          message: thinkingMsg as never,
          getCatById: getCatById as never,
        }),
      );
    });

    expect(container.querySelectorAll('.cli-output-md').length).toBe(0);
    expect(container.textContent).not.toContain(THINKING_TEXT);

    act(() => {
      useChatStore.setState({
        isLoadingThreads: false,
        threads: [
          {
            id: 'thread-expanded',
            projectPath: 'default',
            title: 'Thread Expanded',
            createdBy: 'default-user',
            participants: [],
            lastActiveAt: Date.now(),
            createdAt: Date.now(),
            bubbleThinking: 'expanded',
          },
        ],
      });
    });

    expect(container.querySelectorAll('.cli-output-md').length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain(THINKING_TEXT);
  });

  it('stream-origin messages render via CliOutputBlock (F097)', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');

    const streamMsg = {
      id: 's1',
      type: 'assistant' as const,
      catId: 'opus',
      content: 'stream inner monologue content here',
      origin: 'stream',
      isStreaming: false,
      timestamp: Date.now(),
      contentBlocks: [],
    };

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: streamMsg as never,
          getCatById: getCatById as never,
        }),
      );
    });

    // F097: stream content now renders inside CliOutputBlock, not ThinkingContent
    expect(container.textContent).toContain('CLI Output');

    // Click to expand → content visible in terminal substrate
    const cliButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('CLI Output'),
    );
    expect(cliButton).toBeTruthy();
    act(() => {
      cliButton?.click();
    });

    expect(container.textContent).toContain('stream inner monologue content here');
  });

  it('bubble toggle click immediately re-renders already-mounted thinking block', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const { RightStatusPanel } = await import('@/components/RightStatusPanel');

    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ bubbleThinking: 'collapsed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    act(() => {
      useChatStore.setState({
        currentThreadId: 'thread-a',
        globalBubbleDefaults: { thinking: 'expanded', cliOutput: 'collapsed' },
        threads: [
          {
            id: 'thread-a',
            projectPath: 'default',
            title: 'Thread A',
            createdBy: 'default-user',
            participants: [],
            lastActiveAt: Date.now(),
            createdAt: Date.now(),
            bubbleThinking: 'expanded',
          },
        ],
      });
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(RightStatusPanel, {
            intentMode: null,
            targetCats: [],
            catStatuses: {},
            catInvocations: {},
            threadId: 'thread-a',
            messageSummary: { total: 1, assistant: 1, system: 0, evidence: 0, followup: 0 },
          }),
          React.createElement(ChatMessage, {
            message: thinkingMsg as never,
            getCatById: getCatById as never,
          }),
        ),
      );
    });

    expect(container.textContent).toContain(THINKING_TEXT);
    expect(container.querySelectorAll('.cli-output-md').length).toBeGreaterThanOrEqual(1);

    const collapseButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '折叠',
    );
    expect(collapseButton).toBeTruthy();

    await act(async () => {
      collapseButton?.click();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/threads/thread-a',
      expect.objectContaining({
        method: 'PATCH',
      }),
    );
    expect(container.querySelectorAll('.cli-output-md').length).toBe(0);
    expect(container.textContent).not.toContain(THINKING_TEXT);
  });

  it('bubble toggle collapses on first click when thread is following an expanded global default', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const { RightStatusPanel } = await import('@/components/RightStatusPanel');

    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ bubbleThinking: 'collapsed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    act(() => {
      useChatStore.setState({
        currentThreadId: 'thread-global',
        globalBubbleDefaults: { thinking: 'expanded', cliOutput: 'collapsed' },
        threads: [
          {
            id: 'thread-global',
            projectPath: 'default',
            title: 'Thread Global',
            createdBy: 'default-user',
            participants: [],
            lastActiveAt: Date.now(),
            createdAt: Date.now(),
          },
        ],
      });
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(RightStatusPanel, {
            intentMode: null,
            targetCats: [],
            catStatuses: {},
            catInvocations: {},
            threadId: 'thread-global',
            messageSummary: { total: 1, assistant: 1, system: 0, evidence: 0, followup: 0 },
          }),
          React.createElement(ChatMessage, {
            message: thinkingMsg as never,
            getCatById: getCatById as never,
          }),
        ),
      );
    });

    expect(container.textContent).toContain('跟随全局');
    expect(container.textContent).toContain(THINKING_TEXT);
    expect(container.querySelectorAll('.cli-output-md').length).toBeGreaterThanOrEqual(1);

    const collapseButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '折叠',
    );
    expect(collapseButton).toBeTruthy();

    await act(async () => {
      collapseButton?.click();
      await Promise.resolve();
    });

    expect(container.querySelectorAll('.cli-output-md').length).toBe(0);
    expect(container.textContent).not.toContain(THINKING_TEXT);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/threads/thread-global',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ bubbleThinking: 'collapsed' }),
      }),
    );
  });
});
