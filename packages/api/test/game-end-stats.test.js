import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameStatsRecorder } from '../dist/domains/cats/services/game/GameStatsRecorder.js';

/** Build a minimal finished runtime for stats testing */
function buildFinishedRuntime(overrides = {}) {
  return {
    gameId: 'game-test-1',
    threadId: 'thread-1',
    gameType: 'werewolf',
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 6,
      maxPlayers: 12,
      roles: [
        { name: 'wolf', faction: 'wolf', description: 'wolf' },
        { name: 'seer', faction: 'village', description: 'seer' },
        { name: 'witch', faction: 'village', description: 'witch' },
        { name: 'villager', faction: 'village', description: 'villager' },
      ],
      phases: [],
      actions: [],
      winConditions: [],
    },
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: false, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'sonnet', role: 'wolf', alive: false, properties: {} },
      { seatId: 'P3', actorType: 'cat', actorId: 'codex', role: 'seer', alive: true, properties: {} },
      { seatId: 'P4', actorType: 'cat', actorId: 'gpt52', role: 'witch', alive: true, properties: {} },
      { seatId: 'P5', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
      { seatId: 'P6', actorType: 'cat', actorId: 'gemini', role: 'villager', alive: false, properties: {} },
      { seatId: 'P7', actorType: 'cat', actorId: 'spark', role: 'villager', alive: true, properties: {} },
    ],
    currentPhase: 'day_vote',
    round: 3,
    eventLog: [
      // Round 1: wolf kills P6, seer divines P1
      {
        eventId: 'e1',
        round: 1,
        phase: 'night_wolf',
        type: 'player_action',
        scope: 'faction:wolf',
        payload: { seatId: 'P1', action: 'kill', target: 'P6' },
        timestamp: 1000,
      },
      {
        eventId: 'e2',
        round: 1,
        phase: 'night_seer',
        type: 'player_action',
        scope: 'seat:P3',
        payload: { seatId: 'P3', action: 'divine', target: 'P1' },
        timestamp: 2000,
      },
      {
        eventId: 'e3',
        round: 1,
        phase: 'night_witch',
        type: 'player_action',
        scope: 'seat:P4',
        payload: { seatId: 'P4', action: 'heal', target: 'P6' },
        timestamp: 3000,
      },
      {
        eventId: 'e4',
        round: 1,
        phase: 'night_resolve',
        type: 'night_result',
        scope: 'public',
        payload: { deaths: [], saved: ['P6'] },
        timestamp: 4000,
      },
      // Round 2: wolf kills P6 again (witch can't save twice), seer divines P2
      {
        eventId: 'e5',
        round: 2,
        phase: 'night_wolf',
        type: 'player_action',
        scope: 'faction:wolf',
        payload: { seatId: 'P2', action: 'kill', target: 'P6' },
        timestamp: 5000,
      },
      {
        eventId: 'e6',
        round: 2,
        phase: 'night_seer',
        type: 'player_action',
        scope: 'seat:P3',
        payload: { seatId: 'P3', action: 'divine', target: 'P2' },
        timestamp: 6000,
      },
      {
        eventId: 'e7',
        round: 2,
        phase: 'night_resolve',
        type: 'night_result',
        scope: 'public',
        payload: { deaths: ['P6'] },
        timestamp: 7000,
      },
      // Round 2 day: vote exile P1
      {
        eventId: 'e8',
        round: 2,
        phase: 'day_vote',
        type: 'vote_result',
        scope: 'public',
        payload: { exiled: 'P1' },
        timestamp: 8000,
      },
      // Round 3: wolf P2 kills nobody (last wolf), seer divines
      {
        eventId: 'e9',
        round: 3,
        phase: 'night_wolf',
        type: 'player_action',
        scope: 'faction:wolf',
        payload: { seatId: 'P2', action: 'kill', target: 'P5' },
        timestamp: 9000,
      },
      // Round 3 day: vote exile P2
      {
        eventId: 'e10',
        round: 3,
        phase: 'day_vote',
        type: 'vote_result',
        scope: 'public',
        payload: { exiled: 'P2' },
        timestamp: 10000,
      },
    ],
    pendingActions: {},
    status: 'finished',
    winner: 'village',
    config: { timeoutMs: 30000, voiceMode: false, humanRole: 'god-view' },
    version: 1,
    createdAt: 1000,
    updatedAt: 10000,
    ...overrides,
  };
}

describe('GameStatsRecorder — detailed stats + MVP', () => {
  it('extractDetailedStats returns per-player stats with action counts', () => {
    const runtime = buildFinishedRuntime();
    const stats = GameStatsRecorder.extractDetailedStats(runtime);

    assert.equal(stats.winner, 'village');
    assert.equal(stats.rounds, 3);
    assert.equal(stats.players.length, 7);

    // P3 (seer) divined twice
    const seer = stats.players.find((p) => p.seatId === 'P3');
    assert.ok(seer);
    assert.equal(seer.role, 'seer');
    assert.equal(seer.divineCount, 2);
    assert.equal(seer.survived, true);
    assert.equal(seer.won, true);
  });

  it('calculates MVP from winning side', () => {
    const runtime = buildFinishedRuntime();
    const stats = GameStatsRecorder.extractDetailedStats(runtime);

    // MVP should be from the winning side (village)
    const mvp = stats.players.find((p) => p.seatId === stats.mvpSeatId);
    assert.ok(mvp, 'MVP seat should exist');
    assert.equal(mvp.faction, 'village', 'MVP should be from winning side');
  });

  it('wolf faction MVP when wolves win', () => {
    const runtime = buildFinishedRuntime({
      winner: 'wolf',
      seats: [
        { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
        { seatId: 'P2', actorType: 'cat', actorId: 'sonnet', role: 'wolf', alive: true, properties: {} },
        { seatId: 'P3', actorType: 'cat', actorId: 'codex', role: 'seer', alive: false, properties: {} },
        { seatId: 'P4', actorType: 'cat', actorId: 'gpt52', role: 'villager', alive: false, properties: {} },
      ],
    });
    const stats = GameStatsRecorder.extractDetailedStats(runtime);
    const mvp = stats.players.find((p) => p.seatId === stats.mvpSeatId);
    assert.ok(mvp);
    assert.equal(mvp.faction, 'wolf');
  });

  it('includes duration in stats', () => {
    const runtime = buildFinishedRuntime();
    const stats = GameStatsRecorder.extractDetailedStats(runtime);
    assert.ok(stats.duration > 0, 'duration should be positive');
  });
});
