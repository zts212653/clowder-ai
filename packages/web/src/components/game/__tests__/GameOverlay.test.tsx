import type { GameEvent, GameView, SeatView } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GameOverlay } from '../GameOverlay';

Object.assign(globalThis as Record<string, unknown>, { React });

const seats: SeatView[] = [
  { seatId: 'P1', actorType: 'cat', actorId: 'opus', displayName: '宪宪', alive: true },
  { seatId: 'P2', actorType: 'cat', actorId: 'codex', displayName: '砚砚', alive: true },
  { seatId: 'P3', actorType: 'cat', actorId: 'gemini', displayName: '烁烁', alive: true },
];

const events: GameEvent[] = [
  {
    eventId: 'e1',
    round: 1,
    phase: 'day_discuss',
    type: 'phase_change',
    scope: 'public',
    payload: { message: '白天讨论开始' },
    timestamp: Date.now(),
  },
];

function makeView(overrides: Partial<GameView> = {}): GameView {
  return {
    gameId: 'g1',
    threadId: 't1',
    gameType: 'werewolf',
    status: 'playing',
    currentPhase: 'day_discuss',
    round: 1,
    seats,
    visibleEvents: events,
    config: { timeoutMs: 120000, voiceMode: false, humanRole: 'player' as const },
    ...overrides,
  };
}

function render(view: GameView, overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(GameOverlay, {
      view,
      isNight: false,
      selectedTarget: null,
      godScopeFilter: 'all',
      onClose: () => {},
      onSelectTarget: () => {},
      onGodScopeChange: () => {},
      onVote: () => {},
      onSpeak: () => {},
      onConfirmAction: () => {},
      ...overrides,
    }),
  );
}

describe('GameOverlay', () => {
  it('renders GameShell wrapper', () => {
    const html = render(makeView());
    expect(html).toContain('data-testid="game-shell"');
  });

  it('renders TopBar with phase info', () => {
    const html = render(makeView());
    expect(html).toContain('data-testid="top-bar"');
    expect(html).toContain('白天讨论');
  });

  it('renders PlayerGrid with seats', () => {
    const html = render(makeView());
    expect(html).toContain('data-testid="player-grid"');
    expect(html).toContain('data-testid="seat-P1"');
    expect(html).toContain('data-testid="seat-P2"');
  });

  it('renders EventFlow with events', () => {
    const html = render(makeView());
    expect(html).toContain('data-testid="event-flow"');
    expect(html).toContain('白天讨论开始');
  });

  it('renders ActionDock in day mode', () => {
    const html = render(makeView());
    expect(html).toContain('data-testid="action-dock"');
  });

  it('renders NightStatus in night mode', () => {
    const html = render(makeView({ currentPhase: 'seer_check' }), {
      isNight: true,
      myRole: '预言家',
      myActionHint: '请选择查验目标',
    });
    expect(html).toContain('data-testid="night-status"');
    expect(html).toContain('预言家');
  });

  it('renders NightActionCard when night + role action available', () => {
    const html = render(makeView({ currentPhase: 'seer_check' }), {
      isNight: true,
      hasTargetedAction: true,
      myRole: '预言家',
      myRoleIcon: '🔮',
      myActionLabel: '查验',
      myActionHint: '选择一名玩家查验其身份',
    });
    expect(html).toContain('data-testid="night-action-card"');
    expect(html).toContain('🔮');
  });

  it('renders god-view with GodInspector when humanRole is god-view', () => {
    const html = render(makeView({ config: { timeoutMs: 120000, voiceMode: false, humanRole: 'god-view' } }), {
      isGodView: true,
    });
    expect(html).toContain('data-testid="god-inspector"');
  });

  it('does not render GodInspector in player mode', () => {
    const html = render(makeView());
    expect(html).not.toContain('data-testid="god-inspector"');
  });

  it('renders PhaseTimeline', () => {
    const html = render(makeView());
    expect(html).toContain('data-testid="phase-timeline"');
  });

  it('renders detective mode with GodInspector and indicator', () => {
    const html = render(
      makeView({ config: { timeoutMs: 120000, voiceMode: false, humanRole: 'detective', detectiveSeatId: 'P1' } }),
      { isDetective: true, detectiveBoundName: '宪宪' },
    );
    expect(html).toContain('data-testid="god-inspector"');
    expect(html).toContain('data-testid="detective-indicator"');
    expect(html).toContain('绑定: 宪宪');
  });

  it('detective mode hides god action buttons', () => {
    const html = render(
      makeView({ config: { timeoutMs: 120000, voiceMode: false, humanRole: 'detective', detectiveSeatId: 'P1' } }),
      { isDetective: true, gameStatus: 'playing' },
    );
    expect(html).not.toContain('data-testid="god-actions"');
  });
});
