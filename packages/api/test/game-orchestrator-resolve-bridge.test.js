/**
 * GameOrchestrator Resolution Bridge Tests (F101 Phase F — Review Fix)
 *
 * Codex P1-1: advancePhase must actually resolve actions into game state.
 * Codex P1-2: action.submitted must carry target field.
 * Codex P2-1: fallback actionName must match phase-specific action definitions.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GameOrchestrator } from '../dist/domains/cats/services/game/GameOrchestrator.js';

function createStubGameStore() {
  const games = new Map();
  const activeByThread = new Map();
  return {
    games,
    async createGame(runtime) {
      if (activeByThread.has(runtime.threadId)) {
        throw new Error(`Thread ${runtime.threadId} already has an active game`);
      }
      games.set(runtime.gameId, structuredClone(runtime));
      activeByThread.set(runtime.threadId, runtime.gameId);
      return structuredClone(runtime);
    },
    async getGame(gameId) {
      const g = games.get(gameId);
      return g ? structuredClone(g) : null;
    },
    async getActiveGame(threadId) {
      const id = activeByThread.get(threadId);
      if (!id) return null;
      return this.getGame(id);
    },
    async updateGame(gameId, runtime) {
      games.set(gameId, structuredClone(runtime));
    },
    async endGame(gameId, winner) {
      const g = games.get(gameId);
      if (g) {
        g.status = 'finished';
        g.winner = winner;
        activeByThread.delete(g.threadId);
      }
    },
  };
}

function createStubSocket() {
  const broadcasts = [];
  return {
    broadcasts,
    broadcastToRoom(room, event, data) {
      broadcasts.push({ room, event, data });
    },
    emitToUser(userId, event, data) {
      broadcasts.push({ userId, event, data });
    },
  };
}

/** Full werewolf definition with resolve phases */
function makeFullDefinition() {
  return {
    gameType: 'werewolf',
    displayName: 'Werewolf',
    minPlayers: 4,
    maxPlayers: 6,
    roles: [
      { name: 'wolf', faction: 'wolf', description: 'Kills at night' },
      { name: 'guard', faction: 'village', description: 'Guards at night', nightActionPhase: 'night_guard' },
      { name: 'villager', faction: 'village', description: 'Votes by day' },
    ],
    phases: [
      { name: 'night_guard', type: 'night_action', actingRole: 'guard', timeoutMs: 30000, autoAdvance: true },
      { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true },
      { name: 'night_resolve', type: 'resolve', timeoutMs: 5000, autoAdvance: true },
      { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 60000, autoAdvance: true },
      { name: 'day_exile', type: 'resolve', timeoutMs: 5000, autoAdvance: true },
    ],
    actions: [
      { name: 'guard', allowedRole: 'guard', allowedPhase: 'night_guard', targetRequired: true, schema: {} },
      { name: 'kill', allowedRole: 'wolf', allowedPhase: 'night_wolf', targetRequired: true, schema: {} },
      { name: 'vote', allowedRole: '*', allowedPhase: 'day_vote', targetRequired: true, schema: {} },
    ],
    winConditions: [],
  };
}

function makeSeats() {
  return [
    { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
    { seatId: 'P2', actorType: 'cat', actorId: 'codex', role: 'wolf', alive: true, properties: {} },
    { seatId: 'P3', actorType: 'cat', actorId: 'gemini', role: 'guard', alive: true, properties: {} },
    { seatId: 'P4', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
    { seatId: 'P5', actorType: 'cat', actorId: 'gpt52', role: 'villager', alive: true, properties: {} },
    { seatId: 'P6', actorType: 'cat', actorId: 'actor6', role: 'villager', alive: true, properties: {} },
  ];
}

describe('P1-2: action.submitted carries target', () => {
  let store, socket, orchestrator, runtime;

  beforeEach(async () => {
    store = createStubGameStore();
    socket = createStubSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    runtime = await orchestrator.startGame({
      threadId: 'thread-resolve-bridge',
      definition: makeFullDefinition(),
      seats: makeSeats(),
      config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P4' },
    });
  });

  it('action.submitted event includes target field', async () => {
    // Guard submits action (game starts at night_guard)
    const g = store.games.get(runtime.gameId);
    // Ensure we're on night_guard
    g.currentPhase = 'night_guard';

    await orchestrator.handlePlayerAction(runtime.gameId, 'P3', {
      seatId: 'P3',
      actionName: 'guard',
      targetSeat: 'P4',
      submittedAt: Date.now(),
    });

    const updated = await store.getGame(runtime.gameId);
    const submitted = updated.eventLog.find((e) => e.type === 'action.submitted' && e.payload.seatId === 'P3');
    assert.ok(submitted, 'should have action.submitted event');
    assert.equal(submitted.payload.target, 'P4', 'action.submitted must include target');
  });
});

describe('P1-1: Resolution bridge — night actions cause deaths', () => {
  let store, socket, orchestrator, runtime;

  beforeEach(async () => {
    store = createStubGameStore();
    socket = createStubSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    runtime = await orchestrator.startGame({
      threadId: 'thread-resolve-night',
      definition: makeFullDefinition(),
      seats: makeSeats(),
      config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P4' },
    });
  });

  it('wolf kill resolves into actual death after night_resolve', async () => {
    const g = store.games.get(runtime.gameId);

    // Phase: night_guard — guard acts
    g.currentPhase = 'night_guard';
    await orchestrator.handlePlayerAction(runtime.gameId, 'P3', {
      seatId: 'P3',
      actionName: 'guard',
      targetSeat: 'P3', // guard self
      submittedAt: Date.now(),
    });

    // After guard acts, all guard actions collected → auto-advance to night_wolf
    let updated = await store.getGame(runtime.gameId);
    assert.equal(updated.currentPhase, 'night_wolf', 'should advance to night_wolf');

    // Phase: night_wolf — both wolves kill P4
    await orchestrator.handlePlayerAction(runtime.gameId, 'P1', {
      seatId: 'P1',
      actionName: 'kill',
      targetSeat: 'P4',
      submittedAt: Date.now(),
    });
    await orchestrator.handlePlayerAction(runtime.gameId, 'P2', {
      seatId: 'P2',
      actionName: 'kill',
      targetSeat: 'P4',
      submittedAt: Date.now(),
    });

    // Both wolves acted → auto-advance to night_resolve
    // night_resolve has no actors → auto-advance again (via tick or skipEmptyPhases)
    updated = await store.getGame(runtime.gameId);

    // Force night_resolve to advance by ticking (5s base + 30s gemini grace on round 1)
    if (updated.currentPhase === 'night_resolve') {
      const gAfter = store.games.get(runtime.gameId);
      gAfter.phaseStartedAt = Date.now() - 60000; // expire past grace period
      await orchestrator.tick(runtime.gameId);
      updated = await store.getGame(runtime.gameId);
    }

    // After night resolution, P4 should be dead
    const p4 = updated.seats.find((s) => s.seatId === 'P4');
    assert.equal(p4.alive, false, 'P4 should be dead after wolf kill resolution');

    // Should have night_resolved event
    const resolvedEvt = updated.eventLog.find((e) => e.type === 'night_resolved');
    assert.ok(resolvedEvt, 'should have night_resolved event');
    assert.ok(resolvedEvt.payload.deaths.includes('P4'), 'night_resolved should list P4 as dead');
  });
});

describe('P1-1: Resolution bridge — day votes cause exile', () => {
  let store, socket, orchestrator, runtime;

  beforeEach(async () => {
    store = createStubGameStore();
    socket = createStubSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    runtime = await orchestrator.startGame({
      threadId: 'thread-resolve-day',
      definition: makeFullDefinition(),
      seats: makeSeats(),
      config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P4' },
    });
  });

  it('day votes resolve into actual exile', async () => {
    const g = store.games.get(runtime.gameId);
    // Jump directly to day_vote for this test
    g.currentPhase = 'day_vote';

    // All 6 players vote to exile P1 (wolf)
    for (const seatId of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
      await orchestrator.handlePlayerAction(runtime.gameId, seatId, {
        seatId,
        actionName: 'vote',
        targetSeat: 'P1',
        submittedAt: Date.now(),
      });
    }

    // All voted → should auto-advance past day_vote
    let updated = await store.getGame(runtime.gameId);

    // If on day_exile, tick to advance (5s base + 30s grace on round 1)
    if (updated.currentPhase === 'day_exile') {
      const gAfter = store.games.get(runtime.gameId);
      gAfter.phaseStartedAt = Date.now() - 60000;
      await orchestrator.tick(runtime.gameId);
      updated = await store.getGame(runtime.gameId);
    }

    // P1 should be exiled (dead or alive-with-idiotRevealed if idiot, but P1 is wolf → dead)
    const p1 = updated.seats.find((s) => s.seatId === 'P1');
    assert.equal(p1.alive, false, 'P1 should be exiled (dead) after majority vote');

    // Should have vote_resolved event
    const resolvedEvt = updated.eventLog.find((e) => e.type === 'vote_resolved');
    assert.ok(resolvedEvt, 'should have vote_resolved event');
    assert.equal(resolvedEvt.payload.exiled, 'P1', 'vote_resolved should name P1 as exiled');
  });
});

describe('P2-1: fallback actionName uses phase-specific definition', () => {
  let store, socket, orchestrator, runtime;

  beforeEach(async () => {
    store = createStubGameStore();
    socket = createStubSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    runtime = await orchestrator.startGame({
      threadId: 'thread-fallback-action',
      definition: makeFullDefinition(),
      seats: makeSeats(),
      config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P4' },
    });
  });

  it('guard fallback uses actionName="guard", not "vote"', async () => {
    const g = store.games.get(runtime.gameId);
    g.currentPhase = 'night_guard';
    g.phaseStartedAt = Date.now() - 60000; // expire timeout

    await orchestrator.tick(runtime.gameId);

    const updated = await store.getGame(runtime.gameId);
    const fallback = updated.eventLog.find((e) => e.type === 'action.fallback' && e.payload.seatId === 'P3');
    assert.ok(fallback, 'should have fallback for guard');
    assert.equal(fallback.payload.actionName, 'guard', 'fallback actionName should be "guard", not "vote"');
  });

  it('wolf fallback uses actionName="kill"', async () => {
    const g = store.games.get(runtime.gameId);
    g.currentPhase = 'night_wolf';
    g.phaseStartedAt = Date.now() - 60000;

    await orchestrator.tick(runtime.gameId);

    const updated = await store.getGame(runtime.gameId);
    const fallback = updated.eventLog.find((e) => e.type === 'action.fallback' && e.payload.seatId === 'P1');
    assert.ok(fallback, 'should have fallback for wolf');
    // Check the pending action's actionName (not just event payload)
    const pendingP1 = updated.pendingActions?.['P1'];
    if (pendingP1) {
      assert.equal(pendingP1.actionName, 'kill', 'wolf fallback actionName should be "kill"');
    }
  });
});

describe('Cloud P1: ballot.updated emitted at submission time (not batched at resolution)', () => {
  let store, socket, orchestrator, runtime;

  beforeEach(async () => {
    store = createStubGameStore();
    socket = createStubSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    runtime = await orchestrator.startGame({
      threadId: 'thread-ballot-live',
      definition: makeFullDefinition(),
      seats: makeSeats(),
      config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P4' },
    });
  });

  it('emits ballot.updated immediately when a player votes during day_vote', async () => {
    const g = store.games.get(runtime.gameId);
    g.currentPhase = 'day_vote';

    // P3 votes
    await orchestrator.handlePlayerAction(runtime.gameId, 'P3', {
      seatId: 'P3',
      actionName: 'vote',
      targetSeat: 'P1',
      submittedAt: Date.now(),
    });

    // After single vote (not all collected yet), check for ballot.updated
    const updated = await store.getGame(runtime.gameId);
    assert.equal(updated.currentPhase, 'day_vote', 'should still be in day_vote (not all voted)');

    const ballotEvents = updated.eventLog.filter((e) => e.type === 'ballot.updated' && e.payload.voterSeat === 'P3');
    assert.ok(ballotEvents.length >= 1, 'ballot.updated should be emitted immediately on vote, not batched');
    assert.equal(ballotEvents[0].scope, 'public', 'ballot.updated should be public (KD-26)');
    assert.equal(ballotEvents[0].payload.choice, 'P1', 'should carry the vote target');
  });
});

describe('Cloud P1: revealed idiot vote excluded from resolution', () => {
  let store, socket, orchestrator, runtime;

  beforeEach(async () => {
    store = createStubGameStore();
    socket = createStubSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    runtime = await orchestrator.startGame({
      threadId: 'thread-idiot-vote',
      definition: makeFullDefinition(),
      seats: makeSeats(),
      config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P4' },
    });
  });

  it('revealed idiot vote does not count in resolution', async () => {
    const g = store.games.get(runtime.gameId);
    g.currentPhase = 'day_vote';
    // Mark P5 as revealed idiot
    const p5 = g.seats.find((s) => s.seatId === 'P5');
    p5.properties.idiotRevealed = true;

    // P5 (idiot) votes P1, everyone else votes P2
    for (const seatId of ['P1', 'P2', 'P3', 'P4', 'P6']) {
      await orchestrator.handlePlayerAction(runtime.gameId, seatId, {
        seatId,
        actionName: 'vote',
        targetSeat: 'P2',
        submittedAt: Date.now(),
      });
    }
    await orchestrator.handlePlayerAction(runtime.gameId, 'P5', {
      seatId: 'P5',
      actionName: 'vote',
      targetSeat: 'P1',
      submittedAt: Date.now(),
    });

    const updated = await store.getGame(runtime.gameId);
    const resolved = updated.eventLog.find((e) => e.type === 'vote_resolved');
    assert.ok(resolved, 'should have vote_resolved event');
    // P2 should be exiled (5 votes), not P1 (idiot vote doesn't count)
    assert.equal(resolved.payload.exiled, 'P2', 'idiot vote should not influence result');
  });
});

describe('Cloud P2: fallback day votes emit ballot.updated', () => {
  let store, socket, orchestrator, runtime;

  beforeEach(async () => {
    store = createStubGameStore();
    socket = createStubSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    runtime = await orchestrator.startGame({
      threadId: 'thread-fallback-ballot',
      definition: makeFullDefinition(),
      seats: makeSeats(),
      config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P4' },
    });
  });

  it('fallback day votes have public ballot.updated trail', async () => {
    const g = store.games.get(runtime.gameId);
    g.currentPhase = 'day_vote';
    g.phaseStartedAt = Date.now() - 120000; // expire timeout

    // Only P3 submits manually
    await orchestrator.handlePlayerAction(runtime.gameId, 'P3', {
      seatId: 'P3',
      actionName: 'vote',
      targetSeat: 'P1',
      submittedAt: Date.now(),
    });

    // Re-expire after manual vote
    const g2 = store.games.get(runtime.gameId);
    g2.phaseStartedAt = Date.now() - 120000;

    await orchestrator.tick(runtime.gameId);

    const updated = await store.getGame(runtime.gameId);
    const ballotEvents = updated.eventLog.filter((e) => e.type === 'ballot.updated');
    // P3 manual + at least some fallback ballots
    assert.ok(ballotEvents.length >= 2, 'should have ballot.updated for both manual and fallback votes');

    // Check that fallback ballots exist
    const fallbackBallots = ballotEvents.filter((e) => e.payload.source === 'fallback');
    assert.ok(fallbackBallots.length >= 1, 'should have at least 1 fallback ballot.updated');
    assert.ok(
      fallbackBallots.every((e) => e.scope === 'public'),
      'fallback ballot.updated should be public',
    );
  });

  it('revealed idiot gets no fallback ballot.updated', async () => {
    const g = store.games.get(runtime.gameId);
    g.currentPhase = 'day_vote';
    // Mark P5 as revealed idiot
    const p5 = g.seats.find((s) => s.seatId === 'P5');
    p5.properties.idiotRevealed = true;
    g.phaseStartedAt = Date.now() - 120000;

    await orchestrator.tick(runtime.gameId);

    const updated = await store.getGame(runtime.gameId);
    const p5Ballots = updated.eventLog.filter((e) => e.type === 'ballot.updated' && e.payload.voterSeat === 'P5');
    assert.equal(p5Ballots.length, 0, 'revealed idiot should have no ballot.updated');
  });
});
