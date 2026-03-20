import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/components/ImagePreview', () => ({
  ImagePreview: () => null,
}));
vi.mock('@/utils/compressImage', () => ({
  compressImage: (f: File) => Promise.resolve(f),
}));

// Mock api-client: expose apiFetch as a spy that delegates to globalThis.fetch
// This lets tests verify apiFetch is called (not raw fetch), catching regressions
// where someone switches back to fetch('/api/game/start', ...).
const mockApiFetch = vi.fn((path: string, init?: RequestInit) => globalThis.fetch(path, init));
vi.mock('@/utils/api-client', () => ({
  API_URL: '',
  apiFetch: (...args: [string, RequestInit?]) => mockApiFetch(...args),
}));

// Mock useCatData to return enough cats for a 7-player game (6 cat seats in player mode)
const mockCats = ['opus', 'sonnet', 'codex', 'gpt52', 'spark', 'gemini'].map((id) => ({
  id,
  displayName: id,
  color: { primary: '#888', secondary: '#666' },
  avatar: `/avatars/${id}.png`,
  mentionPatterns: [id],
  provider: 'test',
  defaultModel: 'test',
  roleDescription: '',
  personality: '',
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: mockCats, isLoading: false }),
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

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
});

describe('sendGameCommand respects sendTemporarilyDisabled', () => {
  it('does NOT send game command when upload starts after menu is open', () => {
    const onSend = vi.fn();

    // Step 1: render with idle upload — menu can open
    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false, uploadStatus: 'idle' }));
    });

    // Step 2: open game menu
    const gameBtn = container.querySelector('button[aria-label="Game mode"]') as HTMLButtonElement;
    expect(gameBtn).toBeTruthy();
    act(() => {
      gameBtn.click();
    });

    // Step 3: drill into modes (layer 1 → layer 2)
    const layer1Item = container.querySelector('[data-testid="game-item-werewolf"]') as HTMLElement;
    expect(layer1Item).toBeTruthy();
    act(() => {
      layer1Item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // Step 4: re-render with uploading status (menu stays open, upload started)
    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false, uploadStatus: 'uploading' }));
    });

    // Step 5: click a mode — should NOT call onSend because upload is blocking
    const modeItem = container.querySelector('[data-testid="game-mode-player"]') as HTMLElement;
    expect(modeItem).toBeTruthy();
    act(() => {
      modeItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('opens lobby when upload is idle, calls game API on confirm', async () => {
    const onSend = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'game_started', gameId: 'g1', gameThreadId: 'gt1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    mockApiFetch.mockClear();

    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false, uploadStatus: 'idle' }));
    });

    const gameBtn = container.querySelector('button[aria-label="Game mode"]') as HTMLButtonElement;
    act(() => {
      gameBtn.click();
    });

    const layer1Item = container.querySelector('[data-testid="game-item-werewolf"]') as HTMLElement;
    act(() => {
      layer1Item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    const modeItem = container.querySelector('[data-testid="game-mode-player"]') as HTMLElement;
    act(() => {
      modeItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // Mode click now opens lobby instead of sending directly
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="game-lobby"]')).toBeTruthy();

    // Select all required cats (7-player mode needs catSeatsNeeded=6 cats)
    for (const catId of ['opus', 'sonnet', 'codex', 'gpt52', 'spark', 'gemini']) {
      const toggle = container.querySelector(`[data-testid="cat-toggle-${catId}"]`) as HTMLButtonElement;
      expect(toggle).toBeTruthy();
      act(() => {
        toggle.click();
      });
    }

    // Confirm in lobby calls game API directly (not onSend)
    const confirmBtn = container.querySelector('[data-testid="lobby-confirm"]') as HTMLButtonElement;
    act(() => {
      confirmBtn.click();
    });

    // Wait for async startGame to complete
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should NOT call onSend — game start bypasses message pipeline
    expect(onSend).not.toHaveBeenCalled();
    // Should call apiFetch (not raw fetch) with structured payload
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/game/start',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"gameType":"werewolf"'),
      }),
    );

    vi.restoreAllMocks();
  });
});

describe('game button toggle closes open menu', () => {
  it('clicking game button again dismisses the menu', () => {
    const onSend = vi.fn();

    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false }));
    });

    const gameBtn = container.querySelector('button[aria-label="Game mode"]') as HTMLButtonElement;

    // Open menu
    act(() => {
      gameBtn.click();
    });
    expect(container.querySelector('[data-testid="game-item-werewolf"]')).toBeTruthy();

    // Click game button again — should close the menu
    act(() => {
      gameBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      gameBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      gameBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="game-item-werewolf"]')).toBeNull();
  });
});

describe('layer drill-in does not trigger outside-click close', () => {
  it('clicking werewolf drills into modes (layer 2 visible)', () => {
    const onSend = vi.fn();

    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false }));
    });

    // Open game menu
    const gameBtn = container.querySelector('button[aria-label="Game mode"]') as HTMLButtonElement;
    act(() => {
      gameBtn.click();
    });
    expect(container.querySelector('[data-testid="game-item-werewolf"]')).toBeTruthy();

    // Click werewolf to drill in
    const werewolfItem = container.querySelector('[data-testid="game-item-werewolf"]') as HTMLElement;
    act(() => {
      werewolfItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // Layer 2 should be visible (mode selection)
    expect(container.querySelector('[data-testid="game-mode-player"]')).toBeTruthy();
    // Layer 1 should be gone
    expect(container.querySelector('[data-testid="game-item-werewolf"]')).toBeNull();
  });
});

describe('game start failure handling (P1-1)', () => {
  it('shows error and restores lobby when API returns error', async () => {
    const onSend = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Thread already has an active game' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false, uploadStatus: 'idle' }));
    });

    // Open lobby
    const gameBtn = container.querySelector('button[aria-label="Game mode"]') as HTMLButtonElement;
    act(() => {
      gameBtn.click();
    });
    const layer1Item = container.querySelector('[data-testid="game-item-werewolf"]') as HTMLElement;
    act(() => {
      layer1Item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    const modeItem = container.querySelector('[data-testid="game-mode-player"]') as HTMLElement;
    act(() => {
      modeItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="game-lobby"]')).toBeTruthy();

    // Confirm — triggers fetch which will fail
    const confirmBtn = container.querySelector('[data-testid="lobby-confirm"]') as HTMLButtonElement;
    act(() => {
      confirmBtn.click();
    });

    // Wait for async fetch to resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Lobby should be restored after failure
    expect(container.querySelector('[data-testid="game-lobby"]')).toBeTruthy();

    fetchSpy.mockRestore();
  });

  it('shows error and restores lobby on network failure', async () => {
    const onSend = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false, uploadStatus: 'idle' }));
    });

    // Open lobby
    const gameBtn = container.querySelector('button[aria-label="Game mode"]') as HTMLButtonElement;
    act(() => {
      gameBtn.click();
    });
    const layer1Item = container.querySelector('[data-testid="game-item-werewolf"]') as HTMLElement;
    act(() => {
      layer1Item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    const modeItem = container.querySelector('[data-testid="game-mode-player"]') as HTMLElement;
    act(() => {
      modeItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="game-lobby"]')).toBeTruthy();

    const confirmBtn = container.querySelector('[data-testid="lobby-confirm"]') as HTMLButtonElement;
    act(() => {
      confirmBtn.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Lobby should be restored after network failure
    expect(container.querySelector('[data-testid="game-lobby"]')).toBeTruthy();

    fetchSpy.mockRestore();
  });
});

describe('game start calls dedicated API (not message pipeline)', () => {
  it('calls /api/game/start regardless of hasActiveInvocation', async () => {
    const onSend = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'game_started', gameId: 'g1', gameThreadId: 'gt1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    mockApiFetch.mockClear();

    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false, hasActiveInvocation: true }));
    });

    const gameBtn = container.querySelector('button[aria-label="Game mode"]') as HTMLButtonElement;
    act(() => {
      gameBtn.click();
    });

    const layer1Item = container.querySelector('[data-testid="game-item-werewolf"]') as HTMLElement;
    act(() => {
      layer1Item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    const modeItem = container.querySelector('[data-testid="game-mode-player"]') as HTMLElement;
    act(() => {
      modeItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // Lobby opens, confirm to trigger game API call
    expect(container.querySelector('[data-testid="game-lobby"]')).toBeTruthy();

    // Select all required cats (7-player mode needs catSeatsNeeded=6 cats)
    for (const catId of ['opus', 'sonnet', 'codex', 'gpt52', 'spark', 'gemini']) {
      const toggle = container.querySelector(`[data-testid="cat-toggle-${catId}"]`) as HTMLButtonElement;
      expect(toggle).toBeTruthy();
      act(() => {
        toggle.click();
      });
    }

    const confirmBtn = container.querySelector('[data-testid="lobby-confirm"]') as HTMLButtonElement;
    act(() => {
      confirmBtn.click();
    });

    // Wait for async startGame to complete
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Game start bypasses message pipeline entirely
    expect(onSend).not.toHaveBeenCalled();
    // Must go through apiFetch (shared API client), not raw fetch
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/game/start',
      expect.objectContaining({
        method: 'POST',
      }),
    );

    vi.restoreAllMocks();
  });
});
