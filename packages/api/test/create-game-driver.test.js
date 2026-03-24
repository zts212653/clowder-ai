import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGameDriver } from '../dist/domains/cats/services/game/createGameDriver.js';
import { GameNarratorDriver } from '../dist/domains/cats/services/game/GameNarratorDriver.js';
import { LegacyAutoDriver } from '../dist/domains/cats/services/game/LegacyAutoDriver.js';

function makeLegacyDeps() {
  return {
    gameStore: {
      getGame: async () => null,
      listActiveGames: async () => [],
      createGame: async (r) => r,
      getActiveGame: async () => null,
      updateGame: async () => {},
      endGame: async () => {},
    },
    orchestrator: {
      tick: async () => {},
      handlePlayerAction: async () => {},
      broadcastGameState: async () => {},
      pauseGame: async () => {},
      resumeGame: async () => {},
      skipPhase: async () => {},
    },
    messageStore: { append: (m) => ({ id: 'msg-1', ...m }) },
  };
}

function makeNarratorDeps() {
  return {
    gameStore: {
      getGame: async () => null,
      listActiveGames: async () => [],
      createGame: async (r) => r,
      getActiveGame: async () => null,
      updateGame: async () => {},
      endGame: async () => {},
    },
    orchestrator: { broadcastGameState: async () => {} },
    wakeCat: async () => {},
    actionNotifier: {
      waitForAction: async () => true,
      waitForAllActions: async () => {},
      onActionReceived: () => {},
      cleanup: () => {},
    },
  };
}

describe('createGameDriver', () => {
  it('returns LegacyAutoDriver when gameNarratorEnabled is false', () => {
    const driver = createGameDriver({
      gameNarratorEnabled: false,
      legacyDeps: makeLegacyDeps(),
    });
    assert.ok(driver instanceof LegacyAutoDriver);
  });

  it('returns GameNarratorDriver when gameNarratorEnabled is true', () => {
    const driver = createGameDriver({
      gameNarratorEnabled: true,
      legacyDeps: makeLegacyDeps(),
      narratorDeps: makeNarratorDeps(),
    });
    assert.ok(driver instanceof GameNarratorDriver);
  });

  it('throws when gameNarratorEnabled is true but narratorDeps missing', () => {
    assert.throws(
      () => createGameDriver({ gameNarratorEnabled: true, legacyDeps: makeLegacyDeps() }),
      /narratorDeps required/,
    );
  });

  it('returned driver implements GameDriver interface', () => {
    const driver = createGameDriver({
      gameNarratorEnabled: false,
      legacyDeps: makeLegacyDeps(),
    });
    assert.equal(typeof driver.startLoop, 'function');
    assert.equal(typeof driver.stopLoop, 'function');
    assert.equal(typeof driver.stopAllLoops, 'function');
    assert.equal(typeof driver.recoverActiveGames, 'function');
  });
});
