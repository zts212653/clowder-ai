/**
 * F079: useChatCommands /vote tests
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatCommands } from '../useChatCommands';

const mocks = vi.hoisted(() => {
  const mockAddMessage = vi.fn();
  const mockApiFetch = vi.fn();
  const mockSetShowVoteModal = vi.fn();
  const useChatStoreMock = Object.assign(
    () => ({ addMessageToThread: (_threadId: string, message: Record<string, unknown>) => mockAddMessage(message) }),
    {
      getState: () => ({ currentThreadId: 'thread-1', setShowVoteModal: mockSetShowVoteModal }),
    },
  );

  return { mockAddMessage, mockApiFetch, mockSetShowVoteModal, useChatStoreMock };
});

vi.mock('@/stores/chatStore', () => ({
  useChatStore: mocks.useChatStoreMock,
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'user-1',
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.mockApiFetch(...args),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      { id: 'opus', displayName: '布偶猫', mentionPatterns: ['@opus'] },
      { id: 'codex', displayName: '缅因猫', mentionPatterns: ['@codex'] },
    ],
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

interface HarnessProps {
  onReady: (fn: (input: string) => Promise<boolean>) => void;
}

function Harness({ onReady }: HarnessProps) {
  const { processCommand } = useChatCommands();
  React.useEffect(() => {
    onReady(processCommand);
  }, [onReady, processCommand]);
  return null;
}

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('useChatCommands /vote', () => {
  let container: HTMLDivElement;
  let root: Root;

  function getLatestSystemMessage(): Record<string, unknown> | null {
    const calls = mocks.mockAddMessage.mock.calls as Array<[Record<string, unknown>]>;
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      const msg = calls[i][0];
      if (msg.type === 'system') return msg;
    }
    return null;
  }

  async function setupProcessCommand(): Promise<(input: string) => Promise<boolean>> {
    let processCommand: ((input: string) => Promise<boolean>) | null = null;
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          onReady: (fn) => {
            processCommand = fn;
          },
        }),
      );
    });
    if (!processCommand) throw new Error('processCommand not initialized');
    return processCommand;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.mockAddMessage.mockClear();
    mocks.mockApiFetch.mockReset();
    mocks.mockSetShowVoteModal.mockClear();
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('/vote with args opens vote modal (Phase 2)', async () => {
    const processCommand = await setupProcessCommand();

    const result = await act(async () => processCommand('/vote 谁最绿茶? opus codex'));

    expect(result).toBe(true);
    expect(mocks.mockSetShowVoteModal).toHaveBeenCalledWith(true);
    // No API call — modal handles submission
    expect(mocks.mockApiFetch).not.toHaveBeenCalled();
  });

  it('/vote status shows current vote', async () => {
    const processCommand = await setupProcessCommand();

    mocks.mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        vote: {
          question: '谁最绿茶?',
          options: ['opus', 'codex'],
          votes: { 'user-1': 'opus' },
          anonymous: false,
          deadline: Date.now() + 60000,
          status: 'active',
        },
      }),
    });

    const result = await act(async () => processCommand('/vote status'));

    expect(result).toBe(true);
    const msg = getLatestSystemMessage();
    expect(msg?.content).toContain('当前投票');
    expect(msg?.content).toContain('谁最绿茶');
  });

  it('/vote (empty) opens VoteConfigModal (P1-1 fix)', async () => {
    const processCommand = await setupProcessCommand();

    const result = await act(async () => processCommand('/vote'));

    expect(result).toBe(true);
    // Should open modal, NOT query status API
    expect(mocks.mockSetShowVoteModal).toHaveBeenCalledWith(true);
    expect(mocks.mockApiFetch).not.toHaveBeenCalled();
  });

  it('/vote cast records a vote', async () => {
    const processCommand = await setupProcessCommand();

    mocks.mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        question: '谁最绿茶?',
        options: ['opus', 'codex'],
        votes: { 'user-1': 'opus' },
      }),
    });

    const result = await act(async () => processCommand('/vote cast opus'));

    expect(result).toBe(true);
    expect(mocks.mockApiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/vote'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ option: 'opus' }),
      }),
    );
    const msg = getLatestSystemMessage();
    expect(msg?.content).toContain('已投票');
  });

  it('/vote end closes vote with tally', async () => {
    const processCommand = await setupProcessCommand();

    mocks.mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          question: '谁最绿茶?',
          options: ['opus', 'codex'],
          votes: { 'user-1': 'opus', 'user-2': 'opus', 'user-3': 'codex' },
          tally: { opus: 2, codex: 1 },
          status: 'closed',
        },
      }),
    });

    const result = await act(async () => processCommand('/vote end'));

    expect(result).toBe(true);
    const msg = getLatestSystemMessage();
    expect(msg?.content).toContain('投票已结束');
    expect(msg?.content).toContain('opus: 2 票');
    expect(msg?.content).toContain('codex: 1 票');
  });

  it('/vote end anonymous uses backend tally (P1-2 regression)', async () => {
    const processCommand = await setupProcessCommand();

    mocks.mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          question: '谁最绿茶?',
          options: ['opus', 'codex'],
          votes: {}, // stripped by backend for anonymous
          tally: { opus: 2, codex: 1 }, // backend provides tally
          anonymous: true,
          status: 'closed',
        },
      }),
    });

    const result = await act(async () => processCommand('/vote end'));

    expect(result).toBe(true);
    const msg = getLatestSystemMessage();
    expect(msg?.content).toContain('投票已结束');
    // Must show real tally, not "0 票" from empty votes
    expect(msg?.content).toContain('opus: 2 票');
    expect(msg?.content).toContain('codex: 1 票');
  });

  it('/vote with few args still opens modal (Phase 2)', async () => {
    const processCommand = await setupProcessCommand();

    const result = await act(async () => processCommand('/vote 问题?'));

    expect(result).toBe(true);
    expect(mocks.mockSetShowVoteModal).toHaveBeenCalledWith(true);
  });

  it('/vote with --anonymous flag opens modal (Phase 2)', async () => {
    const processCommand = await setupProcessCommand();

    await act(async () => processCommand('/vote 谁最绿茶? opus codex --anonymous'));

    expect(mocks.mockSetShowVoteModal).toHaveBeenCalledWith(true);
    expect(mocks.mockApiFetch).not.toHaveBeenCalled();
  });

  it('/vote status anonymous uses voteCount (P1-2 regression)', async () => {
    const processCommand = await setupProcessCommand();

    mocks.mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        vote: {
          question: '谁最绿茶?',
          options: ['opus', 'codex'],
          votes: {}, // stripped
          voteCount: 3, // backend provides count
          anonymous: true,
          deadline: Date.now() + 60000,
          status: 'active',
        },
      }),
    });

    await act(async () => processCommand('/vote status'));

    const msg = getLatestSystemMessage();
    expect(msg?.content).toContain('已投: 3 票');
    expect(msg?.content).toContain('匿名');
  });

  it('/vote with start-like args opens modal (409 handled in modal now)', async () => {
    const processCommand = await setupProcessCommand();

    await act(async () => processCommand('/vote 谁最绿茶? opus codex'));

    // Phase 2: modal handles API calls, so no 409 test here
    expect(mocks.mockSetShowVoteModal).toHaveBeenCalledWith(true);
  });
});
