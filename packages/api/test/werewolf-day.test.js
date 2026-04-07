/**
 * WerewolfEngine Day Phase Tests (F101 Task B3)
 *
 * Tests vote resolution, exile, hunter shoot, idiot reveal, last words, PK.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWerewolfDefinition } from '../dist/domains/cats/services/game/werewolf/WerewolfDefinition.js';
import { WerewolfEngine } from '../dist/domains/cats/services/game/werewolf/WerewolfEngine.js';

function create9pRuntime() {
  const def = createWerewolfDefinition(9);
  return {
    gameId: 'game-day-test',
    threadId: 'thread-day',
    gameType: 'werewolf',
    definition: def,
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'a1', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'a2', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P3', actorType: 'human', actorId: 'a3', role: 'seer', alive: true, properties: {} },
      { seatId: 'P4', actorType: 'cat', actorId: 'a4', role: 'witch', alive: true, properties: {} },
      { seatId: 'P5', actorType: 'cat', actorId: 'a5', role: 'hunter', alive: true, properties: {} },
      { seatId: 'P6', actorType: 'cat', actorId: 'a6', role: 'guard', alive: true, properties: {} },
      { seatId: 'P7', actorType: 'human', actorId: 'a7', role: 'villager', alive: true, properties: {} },
      { seatId: 'P8', actorType: 'human', actorId: 'a8', role: 'villager', alive: true, properties: {} },
      { seatId: 'P9', actorType: 'human', actorId: 'a9', role: 'villager', alive: true, properties: {} },
    ],
    currentPhase: 'day_vote',
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

describe('WerewolfEngine — Day Phase', () => {
  it('vote phase → highest votes → exile', () => {
    const runtime = create9pRuntime();
    const engine = new WerewolfEngine(runtime);

    // 5 vote for P1, 2 vote for P7
    engine.castVote('P3', 'P1');
    engine.castVote('P4', 'P1');
    engine.castVote('P5', 'P1');
    engine.castVote('P7', 'P1');
    engine.castVote('P8', 'P1');
    engine.castVote('P6', 'P7');
    engine.castVote('P9', 'P7');
    // P1 and P2 (wolves) don't vote for themselves

    const result = engine.resolveVotes();
    assert.equal(result.exiled, 'P1', 'P1 should be exiled (5 votes)');
    assert.equal(result.tied, false, 'should not be tied');

    const seat = engine.getRuntime().seats.find((s) => s.seatId === 'P1');
    assert.equal(seat.alive, false, 'P1 should be dead');
  });

  it('tied vote → PK round needed', () => {
    const runtime = create9pRuntime();
    const engine = new WerewolfEngine(runtime);

    // 3 vote P1, 3 vote P7, rest abstain
    engine.castVote('P3', 'P1');
    engine.castVote('P4', 'P1');
    engine.castVote('P5', 'P1');
    engine.castVote('P6', 'P7');
    engine.castVote('P8', 'P7');
    engine.castVote('P9', 'P7');

    const result = engine.resolveVotes();
    assert.equal(result.tied, true, 'should be tied');
    assert.equal(result.exiled, null, 'no one exiled on tie');
    assert.deepEqual(result.pkCandidates.sort(), ['P1', 'P7'], 'PK candidates');
  });

  it('PK re-vote → still tied → no exile (平票放过)', () => {
    const runtime = create9pRuntime();
    const engine = new WerewolfEngine(runtime);

    // First vote ties
    engine.castVote('P3', 'P1');
    engine.castVote('P4', 'P7');
    const result1 = engine.resolveVotes();
    assert.equal(result1.tied, true);

    // PK round: only non-PK alive players vote, still tied
    engine.castVote('P5', 'P1');
    engine.castVote('P6', 'P7');

    const result2 = engine.resolvePK(['P1', 'P7']);
    assert.equal(result2.exiled, null, 'PK tie → no exile');
  });

  it('exiled player gets last words event', () => {
    const runtime = create9pRuntime();
    const engine = new WerewolfEngine(runtime);

    engine.recordLastWords('P1', 'I am not a wolf, trust me!');

    const events = engine.getRuntime().eventLog;
    const lastWordsEvent = events.find((e) => e.type === 'last_words');
    assert.ok(lastWordsEvent, 'should have last_words event');
    assert.equal(lastWordsEvent.scope, 'public');
    assert.equal(lastWordsEvent.payload.seatId, 'P1');
    assert.equal(lastWordsEvent.payload.text, 'I am not a wolf, trust me!');
  });

  it('exiled hunter → can shoot', () => {
    const runtime = create9pRuntime();
    const engine = new WerewolfEngine(runtime);

    // Exile hunter via vote
    const result = engine.resolveVoteExile('P5');
    assert.equal(result.hunterCanShoot, true, 'Exiled hunter can shoot');
  });

  it('hunter shoot → target dies → win condition checked', () => {
    const runtime = create9pRuntime();
    const engine = new WerewolfEngine(runtime);

    // Hunter is dead (exiled)
    runtime.seats[4].alive = false;

    engine.hunterShoot('P5', 'P1'); // hunter shoots wolf P1

    const seat = engine.getRuntime().seats.find((s) => s.seatId === 'P1');
    assert.equal(seat.alive, false, 'P1 should be dead (shot by hunter)');

    // Event logged
    const shootEvent = engine.getRuntime().eventLog.find((e) => e.type === 'hunter_shoot');
    assert.ok(shootEvent);
    assert.equal(shootEvent.scope, 'public');
    assert.equal(shootEvent.payload.target, 'P1');
  });

  it('idiot survives exile → loses vote right', () => {
    const runtime = create9pRuntime();
    // Add idiot seat
    runtime.seats.push({
      seatId: 'P10',
      actorType: 'cat',
      actorId: 'a10',
      role: 'idiot',
      alive: true,
      properties: {},
    });
    const engine = new WerewolfEngine(runtime);

    const _result = engine.resolveVoteExile('P10');
    const seat = engine.getRuntime().seats.find((s) => s.seatId === 'P10');
    assert.equal(seat.alive, true, 'Idiot survives');
    assert.equal(seat.properties.idiotRevealed, true, 'Idiot revealed');

    // Idiot should not be able to vote
    assert.throws(() => engine.castVote('P10', 'P1'), /cannot vote/i, 'Revealed idiot cannot vote');
  });

  it('dead player cannot vote', () => {
    const runtime = create9pRuntime();
    runtime.seats[6].alive = false; // P7 dead
    const engine = new WerewolfEngine(runtime);

    assert.throws(() => engine.castVote('P7', 'P1'), /not alive|cannot vote/i, 'Dead player cannot vote');
  });

  it('discussion phase → record speeches as public events', () => {
    const runtime = create9pRuntime();
    runtime.currentPhase = 'day_discuss';
    const engine = new WerewolfEngine(runtime);

    engine.recordSpeech('P3', 'I think P1 is suspicious.');
    engine.recordSpeech('P1', 'I am a villager.');

    const speeches = engine.getRuntime().eventLog.filter((e) => e.type === 'speech');
    assert.equal(speeches.length, 2);
    assert.equal(speeches[0].scope, 'public');
    assert.equal(speeches[0].payload.seatId, 'P3');
    assert.ok(speeches[0].payload.actorId, 'speech event should include actorId');
    assert.equal(speeches[1].payload.text, 'I am a villager.');
  });
});
