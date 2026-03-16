/**
 * Information Isolation Red-Line Tests (F101 Task A7)
 *
 * These tests are security-critical and must NEVER be weakened.
 * They verify that game event scoping correctly prevents information leaks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameEngine } from '../dist/domains/cats/services/game/GameEngine.js';
import { GameViewBuilder } from '../dist/domains/cats/services/game/GameViewBuilder.js';

function createRuntime(seats) {
  return {
    gameId: 'game-isolation-test',
    threadId: 'thread-isolation',
    gameType: 'werewolf',
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 4,
      maxPlayers: 12,
      roles: [
        { name: 'wolf', faction: 'wolf', description: 'Kills at night' },
        { name: 'villager', faction: 'village', description: 'Votes by day' },
        { name: 'seer', faction: 'village', description: 'Divines at night' },
        { name: 'witch', faction: 'village', description: 'Saves or poisons' },
      ],
      phases: [
        { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true },
        { name: 'night_seer', type: 'night_action', actingRole: 'seer', timeoutMs: 30000, autoAdvance: true },
        { name: 'night_witch', type: 'night_action', actingRole: 'witch', timeoutMs: 30000, autoAdvance: true },
        { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 60000, autoAdvance: true },
      ],
      actions: [
        { name: 'kill', allowedRole: 'wolf', allowedPhase: 'night_wolf', targetRequired: true, schema: {} },
        { name: 'divine', allowedRole: 'seer', allowedPhase: 'night_seer', targetRequired: true, schema: {} },
        { name: 'save', allowedRole: 'witch', allowedPhase: 'night_witch', targetRequired: true, schema: {} },
        { name: 'vote', allowedRole: '*', allowedPhase: 'day_vote', targetRequired: true, schema: {} },
      ],
      winConditions: [],
    },
    seats: seats ?? [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'human', actorId: 'alice', role: 'villager', alive: true, properties: {} },
      { seatId: 'P3', actorType: 'cat', actorId: 'gemini', role: 'seer', alive: true, properties: {} },
      { seatId: 'P4', actorType: 'cat', actorId: 'codex', role: 'witch', alive: true, properties: {} },
    ],
    currentPhase: 'night_wolf',
    round: 1,
    eventLog: [],
    pendingActions: {},
    status: 'playing',
    config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('Information Isolation Red-Line Tests', () => {
  it('RED-LINE 1: villager CANNOT see wolf faction events', () => {
    const runtime = createRuntime();
    const engine = new GameEngine(runtime);

    engine.appendEvent({
      round: 1,
      phase: 'night_wolf',
      type: 'wolf_kill',
      scope: 'faction:wolf',
      payload: { target: 'P2' },
    });

    const villagerEvents = engine.getVisibleEvents('P2');
    const wolfEvent = villagerEvents.find((e) => e.type === 'wolf_kill');
    assert.equal(wolfEvent, undefined, 'Villager must NOT see wolf faction events');
  });

  it('RED-LINE 2: villager CANNOT see other players night action results', () => {
    const runtime = createRuntime();
    const engine = new GameEngine(runtime);

    // Seer's divine result (seat-scoped)
    engine.appendEvent({
      round: 1,
      phase: 'night_seer',
      type: 'divine_result',
      scope: 'seat:P3',
      payload: { target: 'P1', result: 'wolf' },
    });

    // Witch's notification (seat-scoped)
    engine.appendEvent({
      round: 1,
      phase: 'night_witch',
      type: 'witch_notification',
      scope: 'seat:P4',
      payload: { knifedPlayer: 'P2' },
    });

    const villagerEvents = engine.getVisibleEvents('P2');
    assert.equal(
      villagerEvents.find((e) => e.type === 'divine_result'),
      undefined,
      'Villager must NOT see seer divine result',
    );
    assert.equal(
      villagerEvents.find((e) => e.type === 'witch_notification'),
      undefined,
      'Villager must NOT see witch notification',
    );
  });

  it('RED-LINE 3: wolf player CAN see faction:wolf events', () => {
    const runtime = createRuntime();
    const engine = new GameEngine(runtime);

    engine.appendEvent({
      round: 1,
      phase: 'night_wolf',
      type: 'wolf_discussion',
      scope: 'faction:wolf',
      payload: { message: 'Let us kill P2' },
    });

    const wolfEvents = engine.getVisibleEvents('P1');
    const discussion = wolfEvents.find((e) => e.type === 'wolf_discussion');
    assert.ok(discussion, 'Wolf MUST see faction:wolf events');
  });

  it('RED-LINE 4: seer CAN see their own seat:P3 divine results', () => {
    const runtime = createRuntime();
    const engine = new GameEngine(runtime);

    engine.appendEvent({
      round: 1,
      phase: 'night_seer',
      type: 'divine_result',
      scope: 'seat:P3',
      payload: { target: 'P1', result: 'wolf' },
    });

    const seerEvents = engine.getVisibleEvents('P3');
    const divine = seerEvents.find((e) => e.type === 'divine_result');
    assert.ok(divine, 'Seer MUST see their own divine result');
    assert.equal(divine.payload.result, 'wolf');
  });

  it('RED-LINE 5: witch CAN see seat:P4 (who was knifed)', () => {
    const runtime = createRuntime();
    const engine = new GameEngine(runtime);

    engine.appendEvent({
      round: 1,
      phase: 'night_witch',
      type: 'witch_notification',
      scope: 'seat:P4',
      payload: { knifedPlayer: 'P2' },
    });

    const witchEvents = engine.getVisibleEvents('P4');
    const notification = witchEvents.find((e) => e.type === 'witch_notification');
    assert.ok(notification, 'Witch MUST see who was knifed');
    assert.equal(notification.payload.knifedPlayer, 'P2');
  });

  it('RED-LINE 6: god-view CAN see ALL events', () => {
    const runtime = createRuntime();
    const engine = new GameEngine(runtime);

    engine.appendEvent({
      round: 1,
      phase: 'night_wolf',
      type: 'wolf_kill',
      scope: 'faction:wolf',
      payload: { target: 'P2' },
    });
    engine.appendEvent({
      round: 1,
      phase: 'night_seer',
      type: 'divine_result',
      scope: 'seat:P3',
      payload: { target: 'P1', result: 'wolf' },
    });
    engine.appendEvent({
      round: 1,
      phase: 'night_witch',
      type: 'witch_notification',
      scope: 'seat:P4',
      payload: { knifedPlayer: 'P2' },
    });
    engine.appendEvent({
      round: 1,
      phase: 'day_vote',
      type: 'vote',
      scope: 'public',
      payload: { voter: 'P2', target: 'P1' },
    });
    engine.appendEvent({
      round: 1,
      phase: 'day_vote',
      type: 'system_note',
      scope: 'god',
      payload: { note: 'debug info' },
    });

    const godEvents = engine.getVisibleEvents('god');
    assert.equal(godEvents.length, 5, 'God MUST see all 5 events');
  });

  it('RED-LINE 7: GameView returns different views for different players', () => {
    const runtime = createRuntime();
    const engine = new GameEngine(runtime);

    engine.appendEvent({
      round: 1,
      phase: 'night_wolf',
      type: 'wolf_kill',
      scope: 'faction:wolf',
      payload: { target: 'P2' },
    });
    engine.appendEvent({
      round: 1,
      phase: 'night_seer',
      type: 'divine_result',
      scope: 'seat:P3',
      payload: { target: 'P1', result: 'wolf' },
    });
    engine.appendEvent({
      round: 1,
      phase: 'day_vote',
      type: 'announcement',
      scope: 'public',
      payload: { message: 'Day begins' },
    });

    const wolfView = GameViewBuilder.buildView(engine.getRuntime(), 'P1');
    const villagerView = GameViewBuilder.buildView(engine.getRuntime(), 'P2');
    const seerView = GameViewBuilder.buildView(engine.getRuntime(), 'P3');
    const godView = GameViewBuilder.buildView(engine.getRuntime(), 'god');

    // Wolf sees faction:wolf + public = 2
    assert.equal(wolfView.visibleEvents.length, 2, 'Wolf sees wolf_kill + announcement');
    // Villager sees only public = 1
    assert.equal(villagerView.visibleEvents.length, 1, 'Villager sees only announcement');
    // Seer sees seat:P3 + public = 2
    assert.equal(seerView.visibleEvents.length, 2, 'Seer sees divine_result + announcement');
    // God sees all = 3
    assert.equal(godView.visibleEvents.length, 3, 'God sees all 3');
  });

  it('RED-LINE 8: role masking — villager cannot see other players roles', () => {
    const runtime = createRuntime();
    const villagerView = GameViewBuilder.buildView(runtime, 'P2');

    // Villager should see their own role
    const selfSeat = villagerView.seats.find((s) => s.seatId === 'P2');
    assert.equal(selfSeat.role, 'villager', 'Player sees own role');

    // Should NOT see wolf's role
    const wolfSeat = villagerView.seats.find((s) => s.seatId === 'P1');
    assert.equal(wolfSeat.role, undefined, 'Villager must NOT see wolf role');
  });

  it('RED-LINE 9: dead players can only see public events (no night spy)', () => {
    const seats = [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'human', actorId: 'alice', role: 'villager', alive: false, properties: {} },
      { seatId: 'P3', actorType: 'cat', actorId: 'gemini', role: 'seer', alive: true, properties: {} },
      { seatId: 'P4', actorType: 'cat', actorId: 'codex', role: 'witch', alive: true, properties: {} },
    ];
    const runtime = createRuntime(seats);
    const engine = new GameEngine(runtime);

    // Even if dead player had a seat-scoped event before death, post-death
    // they should only see public events
    engine.appendEvent({
      round: 2,
      phase: 'night_wolf',
      type: 'wolf_kill',
      scope: 'faction:wolf',
      payload: { target: 'P3' },
    });
    engine.appendEvent({
      round: 2,
      phase: 'day_vote',
      type: 'announce',
      scope: 'public',
      payload: { message: 'Day 2' },
    });

    const deadView = engine.getVisibleEvents('P2');
    assert.equal(deadView.length, 1, 'Dead player sees only public events');
    assert.equal(deadView[0].type, 'announce');
  });

  it('RED-LINE 10: dead WOLF must NOT see faction:wolf events (P1-3)', () => {
    const seats = [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: false, properties: {} },
      { seatId: 'P2', actorType: 'human', actorId: 'alice', role: 'villager', alive: true, properties: {} },
      { seatId: 'P3', actorType: 'cat', actorId: 'gemini', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P4', actorType: 'cat', actorId: 'codex', role: 'villager', alive: true, properties: {} },
    ];
    const runtime = createRuntime(seats);
    const engine = new GameEngine(runtime);

    engine.appendEvent({
      round: 2,
      phase: 'night_wolf',
      type: 'wolf_kill',
      scope: 'faction:wolf',
      payload: { target: 'P2' },
    });
    engine.appendEvent({
      round: 2,
      phase: 'day_vote',
      type: 'announce',
      scope: 'public',
      payload: { message: 'Day 2' },
    });

    // Dead wolf (P1) should only see public events, NOT faction:wolf
    const deadWolfEvents = engine.getVisibleEvents('P1');
    const wolfEvent = deadWolfEvents.find((e) => e.type === 'wolf_kill');
    assert.equal(wolfEvent, undefined, 'Dead wolf must NOT see faction:wolf events');
    assert.equal(deadWolfEvents.length, 1, 'Dead wolf sees only public events');

    // Dead wolf's GameView should also not show faction events
    const deadWolfView = GameViewBuilder.buildView(engine.getRuntime(), 'P1');
    const viewWolfEvent = deadWolfView.visibleEvents.find((e) => e.type === 'wolf_kill');
    assert.equal(viewWolfEvent, undefined, 'Dead wolf GameView must NOT include faction:wolf events');
  });

  it('RED-LINE 11: hasActed must NOT leak during night phases to non-god players', () => {
    const runtime = createRuntime();
    runtime.currentPhase = 'night_wolf';
    // Wolf (P1) has acted, others haven't
    runtime.pendingActions = { P1: { actionName: 'kill', target: 'P2' } };

    // Villager (P2) should NOT see wolf's hasActed during night
    const villagerView = GameViewBuilder.buildView(runtime, 'P2');
    const wolfSeat = villagerView.seats.find((s) => s.seatId === 'P1');
    assert.equal(wolfSeat.hasActed, undefined, 'Villager must NOT see wolf hasActed during night');
    // Villager can see own hasActed
    const selfSeat = villagerView.seats.find((s) => s.seatId === 'P2');
    assert.equal(selfSeat.hasActed, false, 'Villager can see own hasActed');

    // God CAN see all hasActed
    const godView = GameViewBuilder.buildView(runtime, 'god');
    const godWolfSeat = godView.seats.find((s) => s.seatId === 'P1');
    assert.equal(godWolfSeat.hasActed, true, 'God can see wolf hasActed during night');

    // Detective CAN see all hasActed
    const detectiveView = GameViewBuilder.buildView(runtime, 'detective:P3');
    const detectiveWolfSeat = detectiveView.seats.find((s) => s.seatId === 'P1');
    assert.equal(detectiveWolfSeat.hasActed, true, 'Detective can see wolf hasActed during night');
  });

  it('RED-LINE 12: hasActed is visible to all during day phases', () => {
    const runtime = createRuntime();
    runtime.currentPhase = 'day_vote';
    runtime.pendingActions = { P1: { actionName: 'vote', target: 'P3' } };

    // During day phase, everyone can see hasActed (e.g. who has voted)
    const villagerView = GameViewBuilder.buildView(runtime, 'P2');
    const wolfSeat = villagerView.seats.find((s) => s.seatId === 'P1');
    assert.equal(wolfSeat.hasActed, true, 'Villager CAN see hasActed during day phase');
  });
});
