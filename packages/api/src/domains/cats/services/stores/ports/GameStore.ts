/**
 * Game Store Interface (F101)
 *
 * Persistence layer for game state. Enforces single active game per thread (KD-15).
 */

import type { GameRuntime } from '@cat-cafe/shared';

export interface IGameStore {
  /** Create a new game. Rejects if thread already has an active game (KD-15). */
  createGame(runtime: GameRuntime): Promise<GameRuntime>;

  /** Get a game by ID */
  getGame(gameId: string): Promise<GameRuntime | null>;

  /** Get the active game for a thread (null if none) */
  getActiveGame(threadId: string): Promise<GameRuntime | null>;

  /** Update game state with optimistic concurrency (version check) */
  updateGame(gameId: string, runtime: GameRuntime): Promise<void>;

  /** End a game and record the winner */
  endGame(gameId: string, winner: string): Promise<void>;

  /** List all active games across all threads (for recovery on startup) */
  listActiveGames(): Promise<GameRuntime[]>;
}
