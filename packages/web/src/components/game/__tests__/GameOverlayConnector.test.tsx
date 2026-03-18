import type { GameView } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GameOverlayConnector } from '../GameOverlayConnector';

Object.assign(globalThis as Record<string, unknown>, { React });

const mockView: GameView = {
  gameId: 'g1',
  threadId: 't1',
  gameType: 'werewolf',
  status: 'playing',
  currentPhase: 'day_discuss',
  round: 1,
  seats: [
    { seatId: 'P1', actorType: 'cat', actorId: 'opus', displayName: '宪宪', alive: true },
    { seatId: 'P2', actorType: 'cat', actorId: 'codex', displayName: '砚砚', alive: true },
  ],
  visibleEvents: [],
  config: { timeoutMs: 120000, voiceMode: false, humanRole: 'player' as const },
};

function render(view: GameView | null): string {
  return renderToStaticMarkup(
    React.createElement(GameOverlayConnector, {
      gameView: view,
      isGameActive: !!view,
      isNight: false,
      selectedTarget: null,
      godScopeFilter: 'all',
      onClose: () => {},
      onSelectTarget: () => {},
      onGodScopeChange: () => {},
      onVote: () => {},
      onSpeak: () => {},
      onConfirmAction: () => {},
    }),
  );
}

describe('GameOverlayConnector', () => {
  it('renders GameOverlay when game is active', () => {
    const html = render(mockView);
    expect(html).toContain('data-testid="game-shell"');
    expect(html).toContain('data-testid="top-bar"');
  });

  it('renders nothing when game is not active', () => {
    const html = render(null);
    expect(html).toBe('');
  });

  it('renders nothing when gameView is null even if isGameActive flag set', () => {
    const html = renderToStaticMarkup(
      React.createElement(GameOverlayConnector, {
        gameView: null,
        isGameActive: true,
        isNight: false,
        selectedTarget: null,
        godScopeFilter: 'all',
        onClose: () => {},
        onSelectTarget: () => {},
        onGodScopeChange: () => {},
        onVote: () => {},
        onSpeak: () => {},
        onConfirmAction: () => {},
      }),
    );
    expect(html).toBe('');
  });

  it('renders nothing when gameView.threadId does not match currentThreadId (thread isolation)', () => {
    const html = renderToStaticMarkup(
      React.createElement(GameOverlayConnector, {
        gameView: mockView,
        isGameActive: true,
        currentThreadId: 'thread-different',
        isNight: false,
        selectedTarget: null,
        godScopeFilter: 'all',
        onClose: () => {},
        onSelectTarget: () => {},
        onGodScopeChange: () => {},
        onVote: () => {},
        onSpeak: () => {},
        onConfirmAction: () => {},
      }),
    );
    expect(html).toBe('');
  });

  it('renders overlay when gameView.threadId matches currentThreadId', () => {
    const html = renderToStaticMarkup(
      React.createElement(GameOverlayConnector, {
        gameView: mockView,
        isGameActive: true,
        currentThreadId: 't1',
        isNight: false,
        selectedTarget: null,
        godScopeFilter: 'all',
        onClose: () => {},
        onSelectTarget: () => {},
        onGodScopeChange: () => {},
        onVote: () => {},
        onSpeak: () => {},
        onConfirmAction: () => {},
      }),
    );
    expect(html).toContain('data-testid="game-shell"');
  });
});
