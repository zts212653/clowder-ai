/**
 * F12: useChatCommands hub integration tests
 * Tests /help and /config via real processCommand invocation.
 *
 * Uses React.createElement + createRoot to render the hook (project convention),
 * avoiding @testing-library/react dependency.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

// Mock apiFetch — /config set needs it
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ config: {} }),
  }),
}));

// Import after mocking
const { useChatCommands } = await import('../useChatCommands');

// Minimal hook renderer — captures processCommand from the hook
let captured: { processCommand: (input: string) => Promise<boolean> } | null = null;

function HookHost() {
  const { processCommand } = useChatCommands();
  captured = { processCommand };
  return null;
}

let root: Root;
let container: HTMLDivElement;

describe('useChatCommands hub commands (F12)', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      hubState: null,
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

  it('/help opens Hub to commands tab via processCommand', async () => {
    const handled = await act(() => captured?.processCommand('/help'));
    expect(handled).toBe(true);
    expect(useChatStore.getState().hubState).toMatchObject({ open: true, tab: 'commands' });
  });

  it('/help does NOT add any message to chat', async () => {
    await act(() => captured?.processCommand('/help'));
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('/config (no args) opens Hub to system tab via processCommand', async () => {
    const handled = await act(() => captured?.processCommand('/config'));
    expect(handled).toBe(true);
    expect(useChatStore.getState().hubState).toMatchObject({ open: true, tab: 'system' });
  });

  it('/config (no args) does NOT add any message to chat', async () => {
    await act(() => captured?.processCommand('/config'));
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('/config set still adds messages (regression)', async () => {
    const handled = await act(() => captured?.processCommand('/config set cli.timeoutMs 120000'));
    expect(handled).toBe(true);
    // Should have user echo + system response
    expect(useChatStore.getState().messages.length).toBeGreaterThanOrEqual(1);
    // Hub should NOT open for /config set
    expect(useChatStore.getState().hubState).toBeNull();
  });

  it('hubState defaults to null', () => {
    expect(useChatStore.getState().hubState).toBeNull();
  });

  it('openHub/closeHub cycle works', () => {
    useChatStore.getState().openHub('commands');
    expect(useChatStore.getState().hubState).toMatchObject({ open: true, tab: 'commands' });
    useChatStore.getState().closeHub();
    expect(useChatStore.getState().hubState).toBeNull();
  });
});
