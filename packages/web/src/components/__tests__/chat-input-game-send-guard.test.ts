import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';

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

  it('sends game command when upload is idle', () => {
    const onSend = vi.fn();

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

    expect(onSend).toHaveBeenCalledWith('/game werewolf player', undefined, undefined, undefined);
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

describe('sendGameCommand passes queue delivery mode during active invocation', () => {
  it('sends with queue mode when hasActiveInvocation is true', () => {
    const onSend = vi.fn();

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

    expect(onSend).toHaveBeenCalledWith('/game werewolf player', undefined, undefined, 'queue');
  });

  it('sends without queue mode when no active invocation', () => {
    const onSend = vi.fn();

    act(() => {
      root.render(React.createElement(ChatInput, { onSend, disabled: false, hasActiveInvocation: false }));
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

    expect(onSend).toHaveBeenCalledWith('/game werewolf player', undefined, undefined, undefined);
  });
});
