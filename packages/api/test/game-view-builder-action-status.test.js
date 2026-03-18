import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameViewBuilder } from '../dist/domains/cats/services/game/GameViewBuilder.js';

function makeRuntime(overrides = {}) {
  return {
    gameId: 'game-status-test',
    threadId: 'thread-1',
    gameType: 'werewolf',
    status: 'playing',
    currentPhase: 'night_wolf',
    round: 1,
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'gemini', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P3', actorType: 'human', actorId: 'owner', role: 'seer', alive: true, properties: {} },
      { seatId: 'P4', actorType: 'cat', actorId: 'codex', role: 'villager', alive: true, properties: {} },
    ],
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 2,
      maxPlayers: 8,
      roles: [
        { name: 'wolf', faction: 'wolf', description: 'Kills at night' },
        { name: 'seer', faction: 'village', nightActionPhase: 'night_seer', description: 'Divines one player' },
        { name: 'villager', faction: 'village', description: 'Votes by day' },
      ],
      phases: [
        { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true },
        { name: 'night_seer', type: 'night_action', actingRole: 'seer', timeoutMs: 30000, autoAdvance: true },
        { name: 'day_announce', type: 'announce', timeoutMs: 10000, autoAdvance: true },
        { name: 'day_discuss', type: 'day_discuss', actingRole: '*', timeoutMs: 60000, autoAdvance: true },
        { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 60000, autoAdvance: true },
        { name: 'day_last_words', type: 'announce', timeoutMs: 30000, autoAdvance: true },
      ],
      actions: [],
      winConditions: [],
    },
    eventLog: [],
    pendingActions: {},
    config: { timeoutMs: 30000, voiceMode: false, humanRole: 'god-view' },
    phaseStartedAt: Date.now(),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('GameViewBuilder — actionStatus scoping (Hotfix)', () => {
  it('god view: seats that should NOT act in current phase get no actionStatus', () => {
    const runtime = makeRuntime({
      currentPhase: 'day_last_words',
      pendingActions: {},
    });
    const view = GameViewBuilder.buildView(runtime, 'god');

    for (const seat of view.seats) {
      assert.equal(
        seat.actionStatus,
        undefined,
        `${seat.seatId} should have no actionStatus in day_last_words (announce phase, no actingRole)`,
      );
    }
  });

  it('god view: only acting-role seats get actionStatus during night_wolf', () => {
    const runtime = makeRuntime({
      currentPhase: 'night_wolf',
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
    const p3 = view.seats.find((s) => s.seatId === 'P3');
    const p4 = view.seats.find((s) => s.seatId === 'P4');

    assert.equal(p1.actionStatus, 'acted', 'P1 (wolf) acted');
    assert.equal(p2.actionStatus, 'waiting', 'P2 (wolf) still waiting');
    assert.equal(p3.actionStatus, undefined, 'P3 (seer) should NOT have actionStatus during night_wolf');
    assert.equal(p4.actionStatus, undefined, 'P4 (villager) should NOT have actionStatus during night_wolf');
  });

  it('god view: day_vote (actingRole=*) gives all alive seats actionStatus', () => {
    const runtime = makeRuntime({
      currentPhase: 'day_vote',
      pendingActions: {
        P1: {
          seatId: 'P1',
          actionName: 'vote',
          targetSeat: 'P3',
          submittedAt: Date.now(),
          status: 'acted',
          requestedAt: Date.now(),
        },
      },
    });
    const view = GameViewBuilder.buildView(runtime, 'god');

    const p1 = view.seats.find((s) => s.seatId === 'P1');
    const p2 = view.seats.find((s) => s.seatId === 'P2');
    const p3 = view.seats.find((s) => s.seatId === 'P3');
    const p4 = view.seats.find((s) => s.seatId === 'P4');

    assert.equal(p1.actionStatus, 'acted', 'P1 voted');
    assert.equal(p2.actionStatus, 'waiting', 'P2 not yet voted');
    assert.equal(p3.actionStatus, 'waiting', 'P3 not yet voted');
    assert.equal(p4.actionStatus, 'waiting', 'P4 not yet voted');
  });

  it('god view: dead seats never get actionStatus', () => {
    const runtime = makeRuntime({
      currentPhase: 'day_vote',
      seats: [
        { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: false, properties: {} },
        { seatId: 'P2', actorType: 'cat', actorId: 'gemini', role: 'wolf', alive: true, properties: {} },
        { seatId: 'P3', actorType: 'human', actorId: 'owner', role: 'seer', alive: true, properties: {} },
        { seatId: 'P4', actorType: 'cat', actorId: 'codex', role: 'villager', alive: true, properties: {} },
      ],
    });
    const view = GameViewBuilder.buildView(runtime, 'god');
    const p1 = view.seats.find((s) => s.seatId === 'P1');
    assert.equal(p1.actionStatus, undefined, 'dead P1 should never have actionStatus');
  });
});
