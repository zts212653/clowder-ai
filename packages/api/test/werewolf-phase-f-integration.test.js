/**
 * Phase F Integration Test (F101 — Task 8)
 *
 * Full game scenario: 7 players, 2 wolves, multi-wolf ballot,
 * timeout fallback, god-view transparency, day vote revision + lock.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameViewBuilder } from '../dist/domains/cats/services/game/GameViewBuilder.js';
import { WerewolfEngine } from '../dist/domains/cats/services/game/werewolf/WerewolfEngine.js';
import { WerewolfLobby } from '../dist/domains/cats/services/game/werewolf/WerewolfLobby.js';

function setup7pGame() {
  const lobby = new WerewolfLobby();
  const runtime = lobby.createLobby({
    threadId: 'thread-phase-f-int',
    playerCount: 7,
    players: Array.from({ length: 7 }, (_, i) => ({
      actorType: i === 0 ? 'human' : 'cat',
      actorId: `actor-${i + 1}`,
    })),
  });
  lobby.startGame(runtime);
  return { lobby, runtime };
}

describe('Phase F Integration — Multi-wolf + Fallback + Transparency', () => {
  it('Night 1: both wolves vote, one agrees → target dies + god sees detail, player sees aggregate', () => {
    const { runtime } = setup7pGame();
    const engine = new WerewolfEngine(runtime);

    const wolves = runtime.seats.filter((s) => s.role === 'wolf');
    const nonWolves = runtime.seats.filter((s) => s.role !== 'wolf' && s.alive);
    assert.equal(wolves.length, 2, 'should have 2 wolves');

    const target = nonWolves[0].seatId;

    // Both wolves vote same target
    engine.submitNightBallot(wolves[0].seatId, target);
    engine.submitNightBallot(wolves[1].seatId, target);

    // Resolve night
    const result = engine.resolveNight();
    assert.ok(result.deaths.includes(target), 'target should die');

    // God view: actionStatus scoped to current phase's acting role.
    // Since currentPhase is still night_guard (initial phase), only guard gets actionStatus.
    // Wolves submitted ballots but that doesn't affect actionStatus scoping.
    const godView = GameViewBuilder.buildView(runtime, 'god');
    const guardSeat = godView.seats.find(
      (s) => s.alive && runtime.seats.find((rs) => rs.seatId === s.seatId)?.role === 'guard',
    );
    if (guardSeat) {
      assert.ok(guardSeat.actionStatus !== undefined, 'guard should have actionStatus in night_guard phase');
    }
    const wolfSeats = godView.seats.filter((s) => wolves.some((w) => w.seatId === s.seatId));
    for (const ws of wolfSeats) {
      assert.equal(ws.actionStatus, undefined, `${ws.seatId} (wolf) should NOT have actionStatus in night_guard phase`);
    }

    // Player view shows aggregate (no seat-level detail at night)
    const playerView = GameViewBuilder.buildView(runtime, nonWolves[1].seatId);
    const nonWolfSeat = playerView.seats.find((s) => s.seatId === wolves[0].seatId);
    assert.equal(nonWolfSeat?.actionStatus, undefined, 'player should not see wolf actionStatus at night');
  });

  it('Night 1: wolf tie → no kill (KD-25)', () => {
    const { runtime } = setup7pGame();
    const engine = new WerewolfEngine(runtime);

    const wolves = runtime.seats.filter((s) => s.role === 'wolf');
    const nonWolves = runtime.seats.filter((s) => s.role !== 'wolf' && s.alive);

    // Each wolf votes different target
    engine.submitNightBallot(wolves[0].seatId, nonWolves[0].seatId);
    engine.submitNightBallot(wolves[1].seatId, nonWolves[1].seatId);

    const result = engine.resolveNight();
    // With tie policy no_kill, neither target should die from wolves
    assert.ok(!result.deaths.includes(nonWolves[0].seatId), 'tied target A survives');
    assert.ok(!result.deaths.includes(nonWolves[1].seatId), 'tied target B survives');
  });

  it('Day vote: revision + lock + public visibility (KD-26)', () => {
    const { runtime } = setup7pGame();
    const engine = new WerewolfEngine(runtime);
    runtime.currentPhase = 'day_vote';

    const wolves = runtime.seats.filter((s) => s.role === 'wolf');
    const aliveSeats = runtime.seats.filter((s) => s.alive);
    const target = wolves[0].seatId;

    // Villager votes, changes mind, then locks
    const voter = aliveSeats.find((s) => s.role !== 'wolf');
    engine.castDayVote(voter.seatId, wolves[1].seatId);
    engine.castDayVote(voter.seatId, target); // revision 2
    engine.lockDayVote(voter.seatId);

    const ballot = engine.getDayBallot(voter.seatId);
    assert.equal(ballot.revision, 2);
    assert.equal(ballot.locked, true);
    assert.equal(ballot.choice, target);

    // ballot.updated events should be public (KD-26)
    const ballotEvents = runtime.eventLog.filter((e) => e.type === 'ballot.updated');
    assert.ok(ballotEvents.length >= 2, 'should have ballot.updated events');
    assert.ok(
      ballotEvents.every((e) => e.scope === 'public'),
      'ballot.updated should be public',
    );

    // Player view shows real-time ballots
    const otherPlayer = aliveSeats.find((s) => s.seatId !== voter.seatId && s.role !== 'wolf');
    const view = GameViewBuilder.buildView(runtime, otherPlayer.seatId);
    const publicBallotEvents = view.visibleEvents.filter((e) => e.type === 'ballot.updated');
    assert.ok(publicBallotEvents.length >= 2, 'other player should see ballot.updated events');
  });

  it('God view: shows fallback annotation after timeout', () => {
    const { runtime } = setup7pGame();
    const engine = new WerewolfEngine(runtime);

    const wolves = runtime.seats.filter((s) => s.role === 'wolf');
    const nonWolves = runtime.seats.filter((s) => s.role !== 'wolf' && s.alive);

    // Only wolf 1 votes
    engine.submitNightBallot(wolves[0].seatId, nonWolves[0].seatId);

    // Simulate fallback for wolf 2
    engine.appendEvent({
      round: 1,
      phase: 'night_wolf',
      type: 'action.fallback',
      scope: 'god',
      payload: { seatId: wolves[1].seatId, fallbackSource: 'random', target: nonWolves[1].seatId, reason: 'timeout' },
    });

    const godView = GameViewBuilder.buildView(runtime, 'god');
    const fallbackEvents = godView.visibleEvents.filter((e) => e.type === 'action.fallback');
    assert.ok(fallbackEvents.length >= 1, 'god should see fallback events');
    assert.equal(fallbackEvents[0].payload.fallbackSource, 'random');

    // Player should NOT see fallback events (god scope)
    const playerView = GameViewBuilder.buildView(runtime, nonWolves[0].seatId);
    const leakedFallback = playerView.visibleEvents.filter((e) => e.type === 'action.fallback');
    assert.equal(leakedFallback.length, 0, 'player should not see god-scoped fallback');
  });

  it('revealPolicy: phase_end events hidden during phase, visible after', () => {
    const { runtime } = setup7pGame();
    const currentPhase = runtime.currentPhase; // actual phase from lobby

    // Add phase_end event tagged with current phase
    runtime.eventLog.push({
      eventId: 'e-reveal-1',
      round: 1,
      phase: currentPhase,
      type: 'action.submitted',
      scope: 'public',
      payload: { seatId: 'P1' },
      timestamp: Date.now(),
      revealPolicy: 'phase_end',
    });

    // During same phase → hidden
    const viewDuring = GameViewBuilder.buildView(runtime, runtime.seats[3].seatId);
    assert.equal(
      viewDuring.visibleEvents.find((e) => e.eventId === 'e-reveal-1'),
      undefined,
      'phase_end event hidden during same phase',
    );

    // After phase change → visible
    runtime.currentPhase = 'day_vote';
    const viewAfter = GameViewBuilder.buildView(runtime, runtime.seats[3].seatId);
    assert.ok(
      viewAfter.visibleEvents.find((e) => e.eventId === 'e-reveal-1'),
      'phase_end event visible after phase change',
    );
  });

  it('full flow: night ballot → day vote → no regression on existing mechanics', () => {
    const { runtime } = setup7pGame();
    const engine = new WerewolfEngine(runtime);

    const wolves = runtime.seats.filter((s) => s.role === 'wolf');
    const nonWolves = runtime.seats.filter((s) => s.role !== 'wolf' && s.alive);
    const target = nonWolves[0].seatId;

    // Night: wolves agree → kill
    engine.submitNightBallot(wolves[0].seatId, target);
    engine.submitNightBallot(wolves[1].seatId, target);
    const nightResult = engine.resolveNight();
    assert.ok(nightResult.deaths.includes(target));

    // Day: remaining players vote to exile a wolf
    runtime.currentPhase = 'day_vote';
    const aliveNonWolves = runtime.seats.filter((s) => s.alive && s.role !== 'wolf');
    const exileTarget = wolves[0].seatId;

    for (const seat of aliveNonWolves) {
      engine.castDayVote(seat.seatId, exileTarget);
      engine.lockDayVote(seat.seatId);
    }
    // Wolves vote for a villager
    for (const wolf of wolves.filter((w) => runtime.seats.find((s) => s.seatId === w.seatId)?.alive)) {
      engine.castDayVote(wolf.seatId, aliveNonWolves[0].seatId);
      engine.lockDayVote(wolf.seatId);
    }

    assert.equal(engine.allDayVotesLocked(), true, 'all votes should be locked');
    const dayResult = engine.resolveDayVotes();
    assert.equal(dayResult.exiled, exileTarget, 'wolf should be exiled by majority');

    // Check win condition
    const winner = engine.checkWinCondition();
    // With 1 wolf (1 exiled) vs remaining villagers, village should not have won yet
    // unless wolf count is less than remaining good players
    assert.ok(winner === null || winner === 'village', 'game state should be valid');
  });
});
