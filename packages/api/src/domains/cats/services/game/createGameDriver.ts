import type { GameAutoPlayer } from './GameAutoPlayer.js';
import type { GameDriver } from './GameDriver.js';
import type { NarratorDeps } from './GameNarratorDriver.js';
import { GameNarratorDriver } from './GameNarratorDriver.js';
import { LegacyAutoDriver } from './LegacyAutoDriver.js';

type LegacyDeps = ConstructorParameters<typeof GameAutoPlayer>[0];

export interface CreateGameDriverOptions {
  gameNarratorEnabled: boolean;
  legacyDeps: LegacyDeps;
  narratorDeps?: NarratorDeps;
}

export function createGameDriver(opts: CreateGameDriverOptions): GameDriver {
  if (opts.gameNarratorEnabled) {
    if (!opts.narratorDeps) {
      throw new Error('narratorDeps required when gameNarratorEnabled is true');
    }
    return new GameNarratorDriver(opts.narratorDeps);
  }
  return new LegacyAutoDriver(opts.legacyDeps);
}
