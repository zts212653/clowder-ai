/**
 * Full 12-Person Werewolf Integration Test (F101 Task B9)
 *
 * Simulates a complete game: lobby → deal → night/day cycles → win.
 * Uses 12-player preset (wolf:4, seer:1, witch:1, hunter:1, guard:1, villager:4)
 * to exercise guard role mechanics.
 * Verifies information isolation at each step.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameViewBuilder } from '../dist/domains/cats/services/game/GameViewBuilder.js';
import { WerewolfEngine } from '../dist/domains/cats/services/game/werewolf/WerewolfEngine.js';
import { WerewolfLobby } from '../dist/domains/cats/services/game/werewolf/WerewolfLobby.js';

function makePlayers(count) {
  return Array.from({ length: count }, (_, i) => ({
    actorType: i === 0 ? 'human' : 'cat',
    actorId: `actor-${i + 1}`,
  }));
}

describe('Full 12-Person Werewolf Game', () => {
  it('complete game: lobby → role assignment → night/day → village wins', () => {
    // === Phase 1: Lobby + Role Assignment ===
    const lobby = new WerewolfLobby();
    const runtime = lobby.createLobby({
      threadId: 'thread-full-game',
      playerCount: 12,
      players: makePlayers(12),
    });

    assert.equal(runtime.status, 'lobby');
    assert.equal(runtime.seats.length, 12);

    lobby.startGame(runtime);

    assert.equal(runtime.status, 'playing');
    assert.equal(runtime.round, 1);

    // Verify all roles assigned
    for (const seat of runtime.seats) {
      assert.ok(seat.role, `${seat.seatId} should have role`);
    }

    // Count roles — should match 12p preset: wolf:4, seer:1, witch:1, hunter:1, guard:1, villager:4
    const roleCounts = {};
    for (const seat of runtime.seats) {
      roleCounts[seat.role] = (roleCounts[seat.role] ?? 0) + 1;
    }
    assert.equal(roleCounts.wolf, 4);
    assert.equal(roleCounts.seer, 1);
    assert.equal(roleCounts.witch, 1);
    assert.equal(roleCounts.hunter, 1);
    assert.equal(roleCounts.guard, 1);
    assert.equal(roleCounts.villager, 4);

    // Verify role_assigned events are seat-scoped
    const roleEvents = runtime.eventLog.filter((e) => e.type === 'role_assigned');
    assert.equal(roleEvents.length, 12);
    for (const e of roleEvents) {
      assert.ok(e.scope.startsWith('seat:'));
    }

    // === Phase 2: Information Isolation Check ===
    const wolves = runtime.seats.filter((s) => s.role === 'wolf');
    const villagers = runtime.seats.filter((s) => s.role === 'villager');
    const seer = runtime.seats.find((s) => s.role === 'seer');
    const witch = runtime.seats.find((s) => s.role === 'witch');
    const guard = runtime.seats.find((s) => s.role === 'guard');

    // Wolf view: sees own role + teammate
    const wolfView = GameViewBuilder.buildView(runtime, wolves[0].seatId);
    const wolfSelfSeat = wolfView.seats.find((s) => s.seatId === wolves[0].seatId);
    assert.equal(wolfSelfSeat.role, 'wolf');
    const wolfTeammate = wolfView.seats.find((s) => s.seatId === wolves[1].seatId);
    assert.equal(wolfTeammate.role, 'wolf', 'wolf should see teammate role');

    // Villager view: sees own role, not wolf role
    const villagerView = GameViewBuilder.buildView(runtime, villagers[0].seatId);
    const villagerSelfSeat = villagerView.seats.find((s) => s.seatId === villagers[0].seatId);
    assert.equal(villagerSelfSeat.role, 'villager');
    const villagerWolfSeat = villagerView.seats.find((s) => s.seatId === wolves[0].seatId);
    assert.equal(villagerWolfSeat.role, undefined, 'villager must not see wolf role');

    // Each player's role_assigned event only visible to themselves
    for (const e of roleEvents) {
      const targetSeatId = e.payload.seatId;
      const otherSeatId = runtime.seats.find((s) => s.seatId !== targetSeatId).seatId;
      const otherView = GameViewBuilder.buildView(runtime, otherSeatId);
      const canSee = otherView.visibleEvents.find(
        (ev) => ev.type === 'role_assigned' && ev.payload.seatId === targetSeatId,
      );
      if (otherSeatId !== targetSeatId) {
        assert.equal(canSee, undefined, `${otherSeatId} must not see ${targetSeatId}'s role_assigned`);
      }
    }

    // === Phase 3: Night 1 ===
    const engine = new WerewolfEngine(runtime);

    // Guard protects seer
    engine.setNightAction(guard.seatId, 'guard', seer.seatId);
    // Wolves kill a villager
    engine.setNightAction(wolves[0].seatId, 'kill', villagers[0].seatId);
    // Seer divines wolf
    engine.appendEvent({
      round: 1,
      phase: 'night_seer',
      type: 'divine_result',
      scope: `seat:${seer.seatId}`,
      payload: { target: wolves[0].seatId, result: 'wolf' },
    });

    const night1 = engine.resolveNight();
    assert.ok(night1.deaths.includes(villagers[0].seatId), 'villager should die');
    assert.equal(night1.deaths.length, 1, 'only one death');

    // Verify villager is dead
    const deadVillager = engine.getRuntime().seats.find((s) => s.seatId === villagers[0].seatId);
    assert.equal(deadVillager.alive, false);

    // Seer can see their divine result, wolf cannot
    const seerViewN1 = GameViewBuilder.buildView(engine.getRuntime(), seer.seatId);
    const divineEvent = seerViewN1.visibleEvents.find((e) => e.type === 'divine_result');
    assert.ok(divineEvent, 'seer should see divine result');

    const wolfViewN1 = GameViewBuilder.buildView(engine.getRuntime(), wolves[0].seatId);
    const wolfSeeDivine = wolfViewN1.visibleEvents.find((e) => e.type === 'divine_result');
    assert.equal(wolfSeeDivine, undefined, 'wolf must not see seer divine result');

    // === Phase 4: Day 1 — Vote out wolf ===
    const aliveNonWolf = engine.getRuntime().seats.filter((s) => s.alive && s.role !== 'wolf');
    for (const s of aliveNonWolf) {
      engine.castVote(s.seatId, wolves[0].seatId);
    }
    for (const w of wolves.filter((w) => w.alive)) {
      engine.castVote(w.seatId, seer.seatId);
    }

    const day1 = engine.resolveVotes();
    assert.equal(day1.exiled, wolves[0].seatId, 'wolf should be exiled');
    assert.equal(day1.tied, false);

    engine.recordLastWords(wolves[0].seatId, 'Good game.');

    // === Phase 5: Night 2 ===
    engine.getRuntime().round = 2;

    engine.setNightAction(wolves[1].seatId, 'kill', seer.seatId);
    // Guard can't guard same target two nights in a row
    assert.throws(() => engine.setNightAction(guard.seatId, 'guard', seer.seatId), /cannot guard same target/i);
    engine.setNightAction(guard.seatId, 'guard', witch.seatId);
    // Witch saves seer
    engine.setNightAction(witch.seatId, 'heal', seer.seatId);

    const night2 = engine.resolveNight();
    assert.ok(!night2.deaths.includes(seer.seatId), 'seer saved by witch');

    // === Phase 6: Day 2 — Vote out second wolf ===
    const aliveDay2 = engine.getRuntime().seats.filter((s) => s.alive);
    for (const s of aliveDay2.filter((s) => s.role !== 'wolf')) {
      engine.castVote(s.seatId, wolves[1].seatId);
    }
    for (const w of wolves.filter((w) => w.alive && w !== wolves[1])) {
      engine.castVote(w.seatId, seer.seatId);
    }

    const day2 = engine.resolveVotes();
    assert.equal(day2.exiled, wolves[1].seatId, 'second wolf exiled');

    // === Phase 7: Night 3 — wolves kill villager ===
    engine.getRuntime().round = 3;
    engine.setNightAction(wolves[2].seatId, 'kill', villagers[1].seatId);
    engine.setNightAction(guard.seatId, 'guard', seer.seatId);
    engine.resolveNight();

    // === Phase 8: Day 3 — Vote out third wolf ===
    const aliveDay3 = engine.getRuntime().seats.filter((s) => s.alive);
    for (const s of aliveDay3.filter((s) => s.role !== 'wolf')) {
      engine.castVote(s.seatId, wolves[2].seatId);
    }
    engine.castVote(wolves[2].seatId, seer.seatId);
    engine.castVote(wolves[3].seatId, seer.seatId);

    const day3 = engine.resolveVotes();
    assert.equal(day3.exiled, wolves[2].seatId, 'third wolf exiled');

    // === Phase 9: Night 4 — last wolf kills villager ===
    engine.getRuntime().round = 4;
    engine.setNightAction(wolves[3].seatId, 'kill', villagers[2].seatId);
    engine.resolveNight();

    // === Phase 10: Day 4 — Vote out last wolf ===
    const aliveDay4 = engine.getRuntime().seats.filter((s) => s.alive);
    for (const s of aliveDay4.filter((s) => s.role !== 'wolf')) {
      engine.castVote(s.seatId, wolves[3].seatId);
    }
    engine.castVote(wolves[3].seatId, seer.seatId);

    const day4 = engine.resolveVotes();
    assert.equal(day4.exiled, wolves[3].seatId, 'last wolf exiled');

    // === Win Condition ===
    const winner = engine.checkWinCondition();
    assert.equal(winner, 'village', 'village should win (all wolves dead)');

    for (const w of wolves) {
      const seat = engine.getRuntime().seats.find((s) => s.seatId === w.seatId);
      assert.equal(seat.alive, false, `${w.seatId} should be dead`);
    }
  });

  it('wolf wins when wolves >= good players', () => {
    const lobby = new WerewolfLobby();
    const runtime = lobby.createLobby({
      threadId: 'thread-wolf-wins',
      playerCount: 12,
      players: makePlayers(12),
    });
    lobby.startGame(runtime);

    const engine = new WerewolfEngine(runtime);
    const good = runtime.seats.filter((s) => s.role !== 'wolf');

    // Kill good players until wolves >= good
    // 12p: 4 wolves, 8 good → kill 5 good → 3 good vs 4 wolves
    for (let i = 0; i < 5; i++) {
      good[i].alive = false;
    }

    const winner = engine.checkWinCondition();
    assert.equal(winner, 'wolf', 'wolves win when >= good count');
  });

  it('dead player isolation — only sees public events after death', () => {
    const lobby = new WerewolfLobby();
    const runtime = lobby.createLobby({
      threadId: 'thread-dead-iso',
      playerCount: 12,
      players: makePlayers(12),
    });
    lobby.startGame(runtime);

    const engine = new WerewolfEngine(runtime);
    const wolves = runtime.seats.filter((s) => s.role === 'wolf');
    const villagers = runtime.seats.filter((s) => s.role === 'villager');

    // Kill a villager
    engine.setNightAction(wolves[0].seatId, 'kill', villagers[0].seatId);
    engine.resolveNight();

    // Add events for round 2
    engine.appendEvent({
      round: 2,
      phase: 'night_wolf',
      type: 'wolf_kill',
      scope: 'faction:wolf',
      payload: { target: villagers[1].seatId },
    });
    engine.appendEvent({
      round: 2,
      phase: 'day_vote',
      type: 'announcement',
      scope: 'public',
      payload: { message: 'Day 2' },
    });

    // Dead villager should only see public events
    const deadView = GameViewBuilder.buildView(engine.getRuntime(), villagers[0].seatId);
    const visibleTypes = deadView.visibleEvents.map((e) => e.type);
    assert.ok(!visibleTypes.includes('wolf_kill'), 'dead player must not see wolf events');
    assert.ok(visibleTypes.includes('announcement'), 'dead player sees public events');
  });
});
