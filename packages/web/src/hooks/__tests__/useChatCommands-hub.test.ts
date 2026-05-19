/**
 * useChatCommands — /help and /config command tests.
 * /help now adds a system help message; /config (no args) navigates to /settings.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ config: {} }),
  }),
}));

const { useChatCommands } = await import('../useChatCommands');

let captured: { processCommand: (input: string) => Promise<boolean> } | null = null;

function HookHost() {
  const { processCommand } = useChatCommands();
  captured = { processCommand };
  return null;
}

let root: Root;
let container: HTMLDivElement;

describe('useChatCommands /help and /config', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      currentThreadId: 'test-thread',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(HookHost));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    captured = null;
  });

  it('/help adds a system help message', async () => {
    const handled = await act(() => captured?.processCommand('/help'));
    expect(handled).toBe(true);
    const msgs = useChatStore.getState().messages;
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const helpMsg = msgs.find((m) => m.type === 'system' && m.content.includes('可用命令'));
    expect(helpMsg).toBeTruthy();
  });

  it('/config (no args) navigates to /settings?s=system', async () => {
    mockPush.mockClear();
    const handled = await act(() => captured?.processCommand('/config'));
    expect(handled).toBe(true);
    expect(mockPush).toHaveBeenCalledWith('/settings?s=system');
  });

  it('/config set still adds messages (regression)', async () => {
    const handled = await act(() => captured?.processCommand('/config set cli.timeoutMs 120000'));
    expect(handled).toBe(true);
    expect(useChatStore.getState().messages.length).toBeGreaterThanOrEqual(1);
  });
});
