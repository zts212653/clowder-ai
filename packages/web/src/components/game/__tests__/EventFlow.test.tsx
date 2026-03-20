import type { GameEvent } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventFlow } from '../EventFlow';

Object.assign(globalThis as Record<string, unknown>, { React });

function makeEvent(overrides: Partial<GameEvent> & { eventId: string }): GameEvent {
  return {
    round: 1,
    phase: 'day_discuss',
    type: 'speech',
    scope: 'public',
    payload: { senderName: 'P2 宪宪', content: '我觉得P3很可疑' },
    timestamp: Date.now(),
    ...overrides,
  };
}

function render(events: GameEvent[], catDisplayNames?: Record<string, string>): string {
  return renderToStaticMarkup(React.createElement(EventFlow, { events, catDisplayNames }));
}

describe('EventFlow', () => {
  it('renders system events with bell icon', () => {
    const events = [makeEvent({ eventId: 'e1', type: 'death', payload: { message: 'P4 号玩家死亡' } })];
    const html = render(events);
    expect(html).toContain('data-testid="system-event"');
    expect(html).toContain('P4 号玩家死亡');
    expect(html).toContain('🔔');
  });

  it('renders chat bubbles for speech events', () => {
    const events = [
      makeEvent({ eventId: 'e2', type: 'speech', payload: { senderName: 'P2 宪宪', content: '我觉得P3很可疑' } }),
    ];
    const html = render(events, { 'P2 宪宪': 'P2 宪宪' });
    expect(html).toContain('data-testid="chat-bubble"');
    expect(html).toContain('P2 宪宪');
    expect(html).toContain('我觉得P3很可疑');
  });

  it('renders multiple events', () => {
    const events = [
      makeEvent({ eventId: 'e1', type: 'phase_change', payload: { message: '进入白天讨论' } }),
      makeEvent({ eventId: 'e2', type: 'speech', payload: { senderName: 'P1', content: '大家好' } }),
      makeEvent({ eventId: 'e3', type: 'speech', payload: { senderName: 'P3', content: '我是好人' } }),
    ];
    const html = render(events);
    expect(html).toContain('进入白天讨论');
    expect(html).toContain('大家好');
    expect(html).toContain('我是好人');
  });

  it('renders empty state when no events', () => {
    const html = render([]);
    expect(html).toContain('data-testid="event-flow"');
    expect(html).not.toContain('data-testid="chat-bubble"');
  });

  // --- Hotfix 1: action.* events should render as system events, not chat bubbles ---

  it('renders action.requested as system event (not chat bubble)', () => {
    const events = [
      makeEvent({
        eventId: 'e-ar',
        type: 'action.requested',
        scope: 'god',
        payload: { seatId: 'P1', actionName: 'kill' },
      }),
    ];
    const html = render(events);
    expect(html).toContain('data-testid="system-event"');
    expect(html).not.toContain('data-testid="chat-bubble"');
    // Should display meaningful info, not empty
    expect(html).toContain('P1');
  });

  it('renders action.submitted as system event (not chat bubble)', () => {
    const events = [
      makeEvent({
        eventId: 'e-as',
        type: 'action.submitted',
        scope: 'god',
        payload: { seatId: 'P2', actionName: 'vote', target: 'P4' },
      }),
    ];
    const html = render(events);
    expect(html).toContain('data-testid="system-event"');
    expect(html).not.toContain('data-testid="chat-bubble"');
    expect(html).toContain('P2');
  });

  it('renders action.timeout as system event', () => {
    const events = [
      makeEvent({
        eventId: 'e-at',
        type: 'action.timeout',
        scope: 'god',
        payload: { seatId: 'P3', message: 'P3 行动超时' },
      }),
    ];
    const html = render(events);
    expect(html).toContain('data-testid="system-event"');
    expect(html).not.toContain('data-testid="chat-bubble"');
  });

  it('renders action.fallback as system event', () => {
    const events = [
      makeEvent({
        eventId: 'e-af',
        type: 'action.fallback',
        scope: 'god',
        payload: { seatId: 'P5', message: 'P5 自动执行' },
      }),
    ];
    const html = render(events);
    expect(html).toContain('data-testid="system-event"');
    expect(html).not.toContain('data-testid="chat-bubble"');
  });

  // --- Hotfix 1b: speech/last_words use payload.text, EventFlow should fall back to it ---

  it('renders speech with payload.text (not just content/message)', () => {
    const events = [
      makeEvent({
        eventId: 'e-sp',
        type: 'speech',
        payload: { seatId: 'P2', text: '我是预言家，P4查杀' },
      }),
    ];
    const html = render(events);
    expect(html).toContain('data-testid="chat-bubble"');
    expect(html).toContain('我是预言家，P4查杀');
  });

  it('renders last_words with payload.text', () => {
    const events = [
      makeEvent({
        eventId: 'e-lw',
        type: 'last_words',
        payload: { seatId: 'P4', text: '请帮我报仇' },
      }),
    ];
    const html = render(events);
    expect(html).toContain('data-testid="chat-bubble"');
    expect(html).toContain('请帮我报仇');
  });

  // --- Hotfix: ballot.updated should render as system event ---

  it('renders ballot.updated as system event', () => {
    const events = [
      makeEvent({
        eventId: 'e-bu',
        type: 'ballot.updated',
        scope: 'public',
        payload: { voterSeat: 'P1', choice: 'P3', revision: 1 },
      }),
    ];
    const html = render(events);
    expect(html).toContain('data-testid="system-event"');
    expect(html).not.toContain('data-testid="chat-bubble"');
    expect(html).toContain('P1');
  });
});
