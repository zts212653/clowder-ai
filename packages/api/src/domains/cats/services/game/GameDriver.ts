export interface GameDriver {
  /** Start the game loop for a given game. Runs asynchronously. */
  startLoop(gameId: string): void;
  stopLoop(gameId: string): void;
  stopAllLoops(): void;
  /** Recover active games on API startup. Returns count of recovered games. */
  recoverActiveGames(): Promise<number>;
}
