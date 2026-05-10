/**
 * F12→F190: useChatCommands hub integration tests
 * Tests /help and /config via real processCommand invocation.
 * After F190, /help and /config navigate to /settings via window.location.assign.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

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
const mockAssign = vi.fn();

describe('useChatCommands hub commands (F190)', () => {
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
    mockAssign.mockClear();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign: mockAssign },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    captured = null;
  });

  it('/help navigates to /settings?s=skills', async () => {
    const handled = await act(() => captured?.processCommand('/help'));
    expect(handled).toBe(true);
    expect(mockAssign).toHaveBeenCalledWith('/settings?s=skills');
  });

  it('/help does NOT add any message to chat', async () => {
    await act(() => captured?.processCommand('/help'));
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('/config (no args) navigates to /settings?s=system', async () => {
    const handled = await act(() => captured?.processCommand('/config'));
    expect(handled).toBe(true);
    expect(mockAssign).toHaveBeenCalledWith('/settings?s=system');
  });

  it('/config (no args) does NOT add any message to chat', async () => {
    await act(() => captured?.processCommand('/config'));
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('/config set still adds messages (regression)', async () => {
    const handled = await act(() => captured?.processCommand('/config set cli.timeoutMs 120000'));
    expect(handled).toBe(true);
    expect(useChatStore.getState().messages.length).toBeGreaterThanOrEqual(1);
    expect(mockAssign).not.toHaveBeenCalled();
  });
});
