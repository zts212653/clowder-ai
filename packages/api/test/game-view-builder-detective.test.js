import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameViewBuilder } from '../dist/domains/cats/services/game/GameViewBuilder.js';

/** Minimal runtime factory for testing detective viewer */
function createRuntime(overrides = {}) {
  return {
    gameId: 'g1',
    threadId: 'th1',
    gameType: 'werewolf',
    status: 'playing',
    currentPhase: 'night_werewolf',
    round: 1,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    winner: undefined,
    config: {
      timeoutMs: 30000,
      voiceMode: false,
      humanRole: 'detective',
      detectiveSeatId: 'P3',
    },
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 6,
      maxPlayers: 12,
      roles: [
        { name: 'villager', faction: 'village', description: 'Villager' },
        { name: 'werewolf', faction: 'wolf', nightActionPhase: 'night_werewolf', description: 'Wolf' },
        { name: 'seer', faction: 'village', nightActionPhase: 'night_seer', description: 'Seer' },
      ],
      phases: [],
      actions: [],
      winConditions: [],
    },
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'villager', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'sonnet', role: 'werewolf', alive: true, properties: {} },
      { seatId: 'P3', actorType: 'cat', actorId: 'codex', role: 'werewolf', alive: true, properties: {} },
      { seatId: 'P4', actorType: 'cat', actorId: 'gpt52', role: 'seer', alive: true, properties: {} },
      { seatId: 'P5', actorType: 'cat', actorId: 'gemini', role: 'villager', alive: true, properties: {} },
      { seatId: 'P6', actorType: 'cat', actorId: 'spark', role: 'villager', alive: true, properties: {} },
    ],
    pendingActions: {},
    eventLog: [
      { round: 1, phase: 'deal', type: 'role_assigned', scope: 'seat:P3', payload: { role: 'werewolf' }, timestamp: 1 },
      { round: 1, phase: 'deal', type: 'role_assigned', scope: 'seat:P1', payload: { role: 'villager' }, timestamp: 2 },
      {
        round: 1,
        phase: 'night_werewolf',
        type: 'wolf_chat',
        scope: 'faction:wolf',
        payload: { msg: 'kill P1?' },
        timestamp: 3,
      },
      {
        round: 1,
        phase: 'night_werewolf',
        type: 'announce',
        scope: 'public',
        payload: { msg: 'Night falls' },
        timestamp: 4,
      },
      {
        round: 1,
        phase: 'night_seer',
        type: 'divine_result',
        scope: 'seat:P4',
        payload: { target: 'P2', isWolf: true },
        timestamp: 5,
      },
      {
        round: 1,
        phase: 'night_werewolf',
        type: 'god_note',
        scope: 'god',
        payload: { note: 'god only' },
        timestamp: 6,
      },
    ],
    ...overrides,
  };
}

describe('GameViewBuilder — detective viewer', () => {
  it('detective:P3 sees bound seat role + faction mates roles, not others', () => {
    const runtime = createRuntime();
    const view = GameViewBuilder.buildView(runtime, 'detective:P3');

    // P3 is werewolf — detective should see P3's role
    const p3 = view.seats.find((s) => s.seatId === 'P3');
    assert.equal(p3.role, 'werewolf', 'should see bound seat role');
    assert.equal(p3.faction, 'wolf', 'should see bound seat faction');

    // P2 is also wolf (faction mate) — detective should see P2's role
    const p2 = view.seats.find((s) => s.seatId === 'P2');
    assert.equal(p2.role, 'werewolf', 'should see faction mate role');

    // P1 (villager), P4 (seer), P5, P6 — detective should NOT see their roles
    const p1 = view.seats.find((s) => s.seatId === 'P1');
    assert.equal(p1.role, undefined, 'should NOT see non-faction role');
    const p4 = view.seats.find((s) => s.seatId === 'P4');
    assert.equal(p4.role, undefined, 'should NOT see seer role');
  });

  it('detective:P3 sees public + bound seat + faction events, not god/other-seat', () => {
    const runtime = createRuntime();
    const view = GameViewBuilder.buildView(runtime, 'detective:P3');

    const scopes = view.visibleEvents.map((e) => e.scope);
    // Should see: public, seat:P3, faction:wolf
    assert.ok(scopes.includes('public'), 'should see public events');
    assert.ok(scopes.includes('seat:P3'), 'should see bound seat events');
    assert.ok(scopes.includes('faction:wolf'), 'should see faction events');
    // Should NOT see: seat:P1, seat:P4, god
    assert.ok(!scopes.includes('seat:P1'), 'should NOT see other seat events');
    assert.ok(!scopes.includes('seat:P4'), 'should NOT see seer events');
    assert.ok(!scopes.includes('god'), 'should NOT see god events');
  });

  it('detective loses faction visibility when bound seat dies', () => {
    const runtime = createRuntime();
    // Kill P3
    runtime.seats[2].alive = false;

    const view = GameViewBuilder.buildView(runtime, 'detective:P3');

    // P3's role still visible (own seat)
    const p3 = view.seats.find((s) => s.seatId === 'P3');
    assert.equal(p3.role, 'werewolf', 'should still see bound seat role');

    // P2 (faction mate) role should be hidden now
    const p2 = view.seats.find((s) => s.seatId === 'P2');
    assert.equal(p2.role, undefined, 'should NOT see faction mate after bound seat dies');

    // Faction events should be hidden
    const scopes = view.visibleEvents.map((e) => e.scope);
    assert.ok(!scopes.includes('faction:wolf'), 'should NOT see faction events after death');
  });

  it('detective view includes detectiveSeatId in config', () => {
    const runtime = createRuntime();
    const view = GameViewBuilder.buildView(runtime, 'detective:P3');

    assert.equal(view.config.humanRole, 'detective');
    assert.equal(view.config.detectiveSeatId, 'P3');
  });
});
