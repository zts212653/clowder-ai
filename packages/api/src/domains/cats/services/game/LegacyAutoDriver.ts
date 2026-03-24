import { GameAutoPlayer } from './GameAutoPlayer.js';
import type { GameDriver } from './GameDriver.js';

type AutoPlayerDeps = ConstructorParameters<typeof GameAutoPlayer>[0];

export class LegacyAutoDriver implements GameDriver {
  private readonly autoPlayer: GameAutoPlayer;

  constructor(deps: AutoPlayerDeps) {
    this.autoPlayer = new GameAutoPlayer(deps);
  }

  startLoop(gameId: string): void {
    this.autoPlayer.startLoop(gameId);
  }

  stopLoop(gameId: string): void {
    this.autoPlayer.stopLoop(gameId);
  }

  stopAllLoops(): void {
    this.autoPlayer.stopAllLoops();
  }

  async recoverActiveGames(): Promise<number> {
    return this.autoPlayer.recoverActiveGames();
  }
}
