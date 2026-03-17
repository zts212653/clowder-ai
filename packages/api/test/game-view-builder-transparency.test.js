/**
 * GameViewBuilder Transparency Tests (F101 Phase F — Task 4)
 *
 * Tests god-view action detail, player aggregate progress, and revealPolicy filtering.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameViewBuilder } from '../dist/domains/cats/services/game/GameViewBuilder.js';

function makeRuntime(overrides = {}) {
  return {
    gameId: 'game-1',
    threadId: 'thread-1',
    gameType: 'werewolf',
    status: 'playing',
    currentPhase: 'night_wolf',
    round: 1,
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'gemini', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P3', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
      { seatId: 'P4', actorType: 'cat', actorId: 'codex', role: 'villager', alive: true, properties: {} },
    ],
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 2,
      maxPlayers: 8,
      roles: [
        { name: 'wolf', faction: 'wolf', description: 'Kills at night' },
        { name: 'villager', faction: 'village', description: 'Votes by day' },
      ],
      phases: [
        { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true },
        { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 60000, autoAdvance: true },
      ],
      actions: [],
      winConditions: [],
    },
    eventLog: [],
    pendingActions: {},
    config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P3' },
    phaseStartedAt: Date.now(),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('GameViewBuilder — Transparency (F101 Phase F)', () => {
  describe('god-view action status', () => {
    it('shows actionStatus per seat for god view', () => {
      const runtime = makeRuntime({
        pendingActions: {
          P1: {
            seatId: 'P1',
            actionName: 'kill',
            targetSeat: 'P3',
            submittedAt: Date.now(),
            status: 'acted',
            requestedAt: Date.now() - 1000,
          },
        },
      });
      const view = GameViewBuilder.buildView(runtime, 'god');
      const p1 = view.seats.find((s) => s.seatId === 'P1');
      const p2 = view.seats.find((s) => s.seatId === 'P2');
      assert.equal(p1.actionStatus, 'acted');
      assert.equal(p2.actionStatus, 'waiting');
    });

    it('shows fallback annotation in god view', () => {
      const runtime = makeRuntime({
        pendingActions: {
          P1: {
            seatId: 'P1',
            actionName: 'kill',
            targetSeat: 'P3',
            submittedAt: Date.now(),
            status: 'fallback',
            requestedAt: Date.now(),
            fallbackSource: 'random',
          },
        },
      });
      const view = GameViewBuilder.buildView(runtime, 'god');
      const p1 = view.seats.find((s) => s.seatId === 'P1');
      assert.equal(p1.actionStatus, 'fallback');
    });
  });

  describe('player-view aggregate progress', () => {
    it('shows submittedCount/totalExpected for player view', () => {
      const runtime = makeRuntime({
        pendingActions: {
          P1: {
            seatId: 'P1',
            actionName: 'kill',
            targetSeat: 'P3',
            submittedAt: Date.now(),
            status: 'acted',
            requestedAt: Date.now(),
          },
        },
      });
      const view = GameViewBuilder.buildView(runtime, 'P3');
      assert.equal(view.submittedCount, 1);
      assert.equal(view.totalExpected, 2); // 2 wolves expected
    });

    it('player view does NOT show per-seat actionStatus during night', () => {
      const runtime = makeRuntime({
        pendingActions: {
          P1: {
            seatId: 'P1',
            actionName: 'kill',
            targetSeat: 'P3',
            submittedAt: Date.now(),
            status: 'acted',
            requestedAt: Date.now(),
          },
        },
      });
      const view = GameViewBuilder.buildView(runtime, 'P3');
      const p1 = view.seats.find((s) => s.seatId === 'P1');
      assert.equal(p1.actionStatus, undefined, 'should not expose per-seat status to player at night');
    });
  });

  describe('revealPolicy filtering', () => {
    it('phase_end events hidden during same phase', () => {
      const runtime = makeRuntime({
        eventLog: [
          {
            eventId: 'e1',
            round: 1,
            phase: 'night_wolf',
            type: 'action.submitted',
            scope: 'public',
            payload: { seatId: 'P1' },
            timestamp: Date.now(),
            revealPolicy: 'phase_end',
          },
        ],
      });
      const view = GameViewBuilder.buildView(runtime, 'P3');
      const found = view.visibleEvents.find((e) => e.eventId === 'e1');
      assert.equal(found, undefined, 'phase_end event should be hidden during same phase');
    });

    it('phase_end events visible after phase changes', () => {
      const runtime = makeRuntime({
        currentPhase: 'day_vote', // phase changed from night_wolf
        eventLog: [
          {
            eventId: 'e1',
            round: 1,
            phase: 'night_wolf',
            type: 'action.submitted',
            scope: 'public',
            payload: { seatId: 'P1' },
            timestamp: Date.now(),
            revealPolicy: 'phase_end',
          },
        ],
      });
      const view = GameViewBuilder.buildView(runtime, 'P3');
      const found = view.visibleEvents.find((e) => e.eventId === 'e1');
      assert.ok(found, 'phase_end event should be visible after phase changes');
    });

    it('god view always sees phase_end events', () => {
      const runtime = makeRuntime({
        eventLog: [
          {
            eventId: 'e1',
            round: 1,
            phase: 'night_wolf',
            type: 'action.submitted',
            scope: 'public',
            payload: { seatId: 'P1' },
            timestamp: Date.now(),
            revealPolicy: 'phase_end',
          },
        ],
      });
      const view = GameViewBuilder.buildView(runtime, 'god');
      const found = view.visibleEvents.find((e) => e.eventId === 'e1');
      assert.ok(found, 'god should always see phase_end events');
    });

    it('game_end events hidden during game', () => {
      const runtime = makeRuntime({
        eventLog: [
          {
            eventId: 'e2',
            round: 1,
            phase: 'night_wolf',
            type: 'wolf_internal',
            scope: 'public',
            payload: {},
            timestamp: Date.now(),
            revealPolicy: 'game_end',
          },
        ],
      });
      const view = GameViewBuilder.buildView(runtime, 'P3');
      const found = view.visibleEvents.find((e) => e.eventId === 'e2');
      assert.equal(found, undefined, 'game_end event should be hidden during game');
    });

    it('game_end events visible when game finished', () => {
      const runtime = makeRuntime({
        status: 'finished',
        winner: 'village',
        eventLog: [
          {
            eventId: 'e2',
            round: 1,
            phase: 'night_wolf',
            type: 'wolf_internal',
            scope: 'public',
            payload: {},
            timestamp: Date.now(),
            revealPolicy: 'game_end',
          },
        ],
      });
      const view = GameViewBuilder.buildView(runtime, 'P3');
      const found = view.visibleEvents.find((e) => e.eventId === 'e2');
      assert.ok(found, 'game_end event should be visible when game finished');
    });

    it('phase_end events from prior rounds stay visible when same phase name recurs', () => {
      const runtime = makeRuntime({
        round: 2,
        currentPhase: 'night_wolf', // Same phase name as round 1 event
        eventLog: [
          {
            eventId: 'e-round1-wolf',
            round: 1,
            phase: 'night_wolf',
            type: 'action.submitted',
            scope: 'public',
            payload: { seatId: 'P1' },
            timestamp: Date.now(),
            revealPolicy: 'phase_end',
          },
        ],
      });
      const view = GameViewBuilder.buildView(runtime, 'P3');
      const found = view.visibleEvents.find((e) => e.eventId === 'e-round1-wolf');
      assert.ok(found, 'phase_end event from round 1 should stay visible in round 2 same phase');
    });
  });
});
