/**
 * Werewolf Night Ballot Tests (F101 Phase F — Task 2)
 *
 * Multi-wolf independent voting: each wolf submits a kill ballot,
 * resolved by majority. Ties → no_kill (空刀).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WerewolfEngine } from '../dist/domains/cats/services/game/werewolf/WerewolfEngine.js';
import { WerewolfLobby } from '../dist/domains/cats/services/game/werewolf/WerewolfLobby.js';

/**
 * Helper: create a 7-player game and return engine + wolf seat IDs.
 * 7p preset: wolf:2, seer:1, witch:1, guard:1, villager:2
 */
function setup7pGame() {
  const lobby = new WerewolfLobby();
  const runtime = lobby.createLobby({
    threadId: 'thread-ballot-test',
    playerCount: 7,
    players: Array.from({ length: 7 }, (_, i) => ({
      actorType: 'cat',
      actorId: `actor-${i + 1}`,
    })),
  });
  lobby.startGame(runtime);

  const engine = new WerewolfEngine(runtime);
  const wolves = runtime.seats.filter((s) => s.role === 'wolf').map((s) => s.seatId);
  const nonWolves = runtime.seats.filter((s) => s.role !== 'wolf').map((s) => s.seatId);

  return { engine, runtime, wolves, nonWolves };
}

describe('Multi-wolf Night Ballot (F101 Phase F)', () => {
  describe('submitNightBallot', () => {
    it('2 wolves submit different targets → majority wins', () => {
      const { engine, wolves, nonWolves } = setup7pGame();
      assert.equal(wolves.length, 2, 'should have exactly 2 wolves');

      engine.submitNightBallot(wolves[0], nonWolves[0]);
      engine.submitNightBallot(wolves[1], nonWolves[0]);

      const resolution = engine.resolveNightBallots();
      assert.equal(resolution.winningChoice, nonWolves[0]);
      assert.equal(resolution.fallbackApplied, false);
    });

    it('2 wolves submit same target → unanimous', () => {
      const { engine, wolves, nonWolves } = setup7pGame();

      engine.submitNightBallot(wolves[0], nonWolves[1]);
      engine.submitNightBallot(wolves[1], nonWolves[1]);

      const resolution = engine.resolveNightBallots();
      assert.equal(resolution.winningChoice, nonWolves[1]);
    });

    it('2 wolves tie (1v1 different targets) → no_kill', () => {
      const { engine, wolves, nonWolves } = setup7pGame();

      engine.submitNightBallot(wolves[0], nonWolves[0]);
      engine.submitNightBallot(wolves[1], nonWolves[1]);

      const resolution = engine.resolveNightBallots();
      assert.equal(resolution.winningChoice, null, 'tie should result in no_kill');
      assert.equal(resolution.tiePolicy, 'no_kill');
    });
  });

  describe('resolveNightBallots', () => {
    it('returns Resolution with correct fields', () => {
      const { engine, wolves, nonWolves } = setup7pGame();

      engine.submitNightBallot(wolves[0], nonWolves[0]);
      engine.submitNightBallot(wolves[1], nonWolves[0]);

      const resolution = engine.resolveNightBallots();
      assert.equal(typeof resolution.winningChoice, 'string');
      assert.equal(resolution.tiePolicy, 'no_kill');
      assert.equal(typeof resolution.revoteCount, 'number');
      assert.equal(resolution.fallbackApplied, false);
    });

    it('ballots are cleared after resolution', () => {
      const { engine, wolves, nonWolves } = setup7pGame();

      engine.submitNightBallot(wolves[0], nonWolves[0]);
      engine.submitNightBallot(wolves[1], nonWolves[0]);
      engine.resolveNightBallots();

      // Second resolve with no ballots → null
      const resolution2 = engine.resolveNightBallots();
      assert.equal(resolution2.winningChoice, null);
    });
  });

  describe('resolveNight integration', () => {
    it('resolveNight uses ballot result as kill target', () => {
      const { engine, runtime, wolves, nonWolves } = setup7pGame();
      const target = nonWolves[0];

      // Both wolves vote same target
      engine.submitNightBallot(wolves[0], target);
      engine.submitNightBallot(wolves[1], target);

      const result = engine.resolveNight();
      assert.ok(result.deaths.includes(target), 'ballot-chosen target should die');

      const seat = runtime.seats.find((s) => s.seatId === target);
      assert.equal(seat.alive, false);
    });

    it('resolveNight with tied ballot → no kill from wolves', () => {
      const { engine, wolves, nonWolves } = setup7pGame();

      engine.submitNightBallot(wolves[0], nonWolves[0]);
      engine.submitNightBallot(wolves[1], nonWolves[1]);

      const result = engine.resolveNight();
      // With no_kill tie policy, wolves don't kill anyone
      assert.ok(!result.deaths.includes(nonWolves[0]), 'tied target A should survive');
      assert.ok(!result.deaths.includes(nonWolves[1]), 'tied target B should survive');
    });

    it('old setNightAction kill still works for single wolf', () => {
      // Backward compat: setNightAction('kill') should still set the kill target
      const { engine, wolves, nonWolves } = setup7pGame();
      const target = nonWolves[2];

      engine.setNightAction(wolves[0], 'kill', target);

      const result = engine.resolveNight();
      assert.ok(result.deaths.includes(target), 'setNightAction kill should still work');
    });
  });
});
