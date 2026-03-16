/**
 * Werewolf Lobby + Role Assignment Tests (F101 Task B4)
 *
 * Tests lobby creation, role shuffling, seat assignment, and scoped role_assigned events.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WerewolfLobby } from '../dist/domains/cats/services/game/werewolf/WerewolfLobby.js';

function makePlayers(count) {
  return Array.from({ length: count }, (_, i) => ({
    actorType: i < 2 ? 'human' : 'cat',
    actorId: `actor-${i + 1}`,
  }));
}

describe('WerewolfLobby', () => {
  it('createLobby → returns LOBBY state runtime', () => {
    const lobby = new WerewolfLobby();
    const runtime = lobby.createLobby({
      threadId: 'thread-lobby-1',
      playerCount: 9,
      players: makePlayers(9),
    });

    assert.equal(runtime.status, 'lobby');
    assert.equal(runtime.gameType, 'werewolf');
    assert.equal(runtime.seats.length, 9);
    assert.equal(runtime.threadId, 'thread-lobby-1');
    // In lobby, roles are not yet assigned
    for (const seat of runtime.seats) {
      assert.equal(seat.role, '', 'role should be empty in lobby');
    }
  });

  it('startGame → assigns roles to all seats', () => {
    const lobby = new WerewolfLobby();
    const runtime = lobby.createLobby({
      threadId: 'thread-lobby-2',
      playerCount: 9,
      players: makePlayers(9),
    });

    lobby.startGame(runtime);

    assert.equal(runtime.status, 'playing');
    assert.equal(runtime.currentPhase, 'night_guard');
    assert.equal(runtime.round, 1);

    // Every seat should have a role
    for (const seat of runtime.seats) {
      assert.ok(seat.role, `Seat ${seat.seatId} should have a role`);
    }
  });

  it('startGame → role distribution matches 9-player preset', () => {
    const lobby = new WerewolfLobby();
    const runtime = lobby.createLobby({
      threadId: 'thread-lobby-3',
      playerCount: 9,
      players: makePlayers(9),
    });

    lobby.startGame(runtime);

    const roleCounts = {};
    for (const seat of runtime.seats) {
      roleCounts[seat.role] = (roleCounts[seat.role] ?? 0) + 1;
    }

    // 9-player preset: wolf:3, seer:1, witch:1, hunter:1, villager:3
    assert.equal(roleCounts.wolf, 3);
    assert.equal(roleCounts.seer, 1);
    assert.equal(roleCounts.witch, 1);
    assert.equal(roleCounts.hunter, 1);
    assert.equal(roleCounts.villager, 3);
  });

  it('startGame → role assignment is shuffled (not always same order)', () => {
    const results = [];
    for (let i = 0; i < 20; i++) {
      const lobby = new WerewolfLobby();
      const runtime = lobby.createLobby({
        threadId: `thread-shuffle-${i}`,
        playerCount: 9,
        players: makePlayers(9),
      });
      lobby.startGame(runtime);
      results.push(runtime.seats.map((s) => s.role).join(','));
    }

    // At least 2 different orderings in 20 runs (astronomically unlikely to be same)
    const unique = new Set(results);
    assert.ok(unique.size >= 2, `Expected shuffled roles, got ${unique.size} unique orderings`);
  });

  it('startGame → emits role_assigned events with seat scope', () => {
    const lobby = new WerewolfLobby();
    const runtime = lobby.createLobby({
      threadId: 'thread-lobby-events',
      playerCount: 9,
      players: makePlayers(9),
    });

    lobby.startGame(runtime);

    const roleEvents = runtime.eventLog.filter((e) => e.type === 'role_assigned');
    assert.equal(roleEvents.length, 9, 'should have 9 role_assigned events');

    // Each event should be scoped to the individual seat
    for (const event of roleEvents) {
      assert.ok(event.scope.startsWith('seat:'), `scope should be seat-scoped: ${event.scope}`);
      assert.ok(event.payload.role, 'should include role in payload');
      assert.ok(event.payload.seatId, 'should include seatId in payload');
      // Verify scope matches the seat
      assert.equal(event.scope, `seat:${event.payload.seatId}`);
    }
  });

  it('startGame → seats have correct actorType and actorId', () => {
    const players = makePlayers(9);
    const lobby = new WerewolfLobby();
    const runtime = lobby.createLobby({
      threadId: 'thread-lobby-actors',
      playerCount: 9,
      players,
    });

    lobby.startGame(runtime);

    for (let i = 0; i < 9; i++) {
      assert.equal(runtime.seats[i].actorType, players[i].actorType);
      assert.equal(runtime.seats[i].actorId, players[i].actorId);
      assert.equal(runtime.seats[i].seatId, `P${i + 1}`);
      assert.equal(runtime.seats[i].alive, true);
    }
  });

  it('rejects invalid player count', () => {
    const lobby = new WerewolfLobby();
    assert.throws(
      () =>
        lobby.createLobby({
          threadId: 'thread-bad',
          playerCount: 5,
          players: makePlayers(5),
        }),
      /no preset/i,
    );
  });
});
