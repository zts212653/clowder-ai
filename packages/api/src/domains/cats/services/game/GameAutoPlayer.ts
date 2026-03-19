/**
 * GameAutoPlayer (F101 Phase C — AC-C3)
 *
 * Drives AI cat seats through the game loop.
 * After each phase starts, identifies which cat seats need to act,
 * generates a valid action for each, and submits via orchestrator.
 *
 * Uses simple deterministic logic (random valid targets) to keep games
 * playable without requiring full LLM integration.
 */

import type { GameAction, GameRuntime, SeatId } from '@cat-cafe/shared';
import type { IGameStore } from '../stores/ports/GameStore.js';
import type { GameOrchestrator } from './GameOrchestrator.js';

interface AutoPlayerDeps {
  gameStore: IGameStore;
  orchestrator: GameOrchestrator;
}

/** Phase → action mapping for werewolf */
const PHASE_ACTION_MAP: Record<string, { actionName: string; actingRole: string }> = {
  night_guard: { actionName: 'guard', actingRole: 'guard' },
  night_wolf: { actionName: 'kill', actingRole: 'wolf' },
  night_seer: { actionName: 'divine', actingRole: 'seer' },
  night_witch: { actionName: 'heal', actingRole: 'witch' },
  day_discuss: { actionName: 'speak', actingRole: '*' },
  day_vote: { actionName: 'vote', actingRole: '*' },
  day_hunter: { actionName: 'shoot', actingRole: 'hunter' },
};

/** Resolve phases and announce phases need no player action */
const SKIP_PHASES = new Set(['night_resolve', 'day_announce', 'day_last_words', 'day_exile', 'day_pk', 'lobby']);

export class GameAutoPlayer {
  private readonly store: IGameStore;
  private readonly orchestrator: GameOrchestrator;
  private readonly activeLoops = new Set<string>();
  private stopController: AbortController | null = null;

  constructor(deps: AutoPlayerDeps) {
    this.store = deps.gameStore;
    this.orchestrator = deps.orchestrator;
  }

  /** Start the auto-play loop for a game. Runs asynchronously. */
  startLoop(gameId: string): void {
    if (this.activeLoops.has(gameId)) return;
    this.activeLoops.add(gameId);
    if (!this.stopController) this.stopController = new AbortController();
    console.log(`[GameAutoPlayer] Loop started for ${gameId}`);
    this.runLoop(gameId)
      .catch((err) => {
        console.error(`[GameAutoPlayer] Loop error for ${gameId}:`, err);
      })
      .finally(() => {
        this.activeLoops.delete(gameId);
        console.log(`[GameAutoPlayer] Loop exited for ${gameId}`);
      });
  }

  /** Stop tracking a game loop */
  stopLoop(gameId: string): void {
    this.activeLoops.delete(gameId);
  }

  /** Stop all in-flight loops, used by test/server teardown.
   *  Clears the active set AND aborts any in-flight sleep so loops
   *  exit promptly instead of waiting for the current tick to finish. */
  stopAllLoops(): void {
    this.activeLoops.clear();
    if (this.stopController) {
      this.stopController.abort();
      this.stopController = null;
    }
  }

  /** Check if a loop is active for a game */
  isLoopActive(gameId: string): boolean {
    return this.activeLoops.has(gameId);
  }

  /** Recover auto-play loops for all active games in store (AC-G1).
   *  Call at API startup to resume games after process restart. */
  async recoverActiveGames(): Promise<number> {
    const activeGames = await this.store.listActiveGames();
    let recovered = 0;
    for (const game of activeGames) {
      if (game.status === 'playing') {
        console.log(
          `[GameAutoPlayer] Recovering loop for ${game.gameId} (phase=${game.currentPhase}, round=${game.round})`,
        );
        this.startLoop(game.gameId);
        recovered++;
      }
    }
    if (recovered > 0) {
      console.log(`[GameAutoPlayer] Recovered ${recovered} active game(s)`);
    }
    return recovered;
  }

  static readonly TICK_MS = 800;
  static readonly MAX_WALL_CLOCK_MS = 2 * 60 * 60 * 1000; // 2 hours

  private async runLoop(gameId: string): Promise<void> {
    const loopStart = Date.now();
    const signal = this.stopController?.signal;

    for (;;) {
      if (!this.activeLoops.has(gameId)) return;
      if (signal?.aborted) return;
      if (Date.now() - loopStart > GameAutoPlayer.MAX_WALL_CLOCK_MS) {
        console.warn(
          `[GameAutoPlayer] ${gameId} wall-clock safety limit reached (${GameAutoPlayer.MAX_WALL_CLOCK_MS}ms), exiting loop`,
        );
        return;
      }

      const runtime = await this.store.getGame(gameId);
      if (!runtime || runtime.status === 'finished') return;

      if (runtime.status === 'paused') {
        await sleep(GameAutoPlayer.TICK_MS * 2, signal);
        continue;
      }

      if (runtime.status !== 'playing') return;

      if (SKIP_PHASES.has(runtime.currentPhase)) {
        await this.orchestrator.tick(gameId);
        await sleep(GameAutoPlayer.TICK_MS / 2, signal);
        continue;
      }

      const acted = await this.actForPhase(runtime);
      if (acted) {
        console.log(
          `[GameAutoPlayer] ${gameId} phase=${runtime.currentPhase} round=${runtime.round} — actions submitted`,
        );
      }

      await sleep(acted ? GameAutoPlayer.TICK_MS : GameAutoPlayer.TICK_MS * 2, signal);
    }
  }

  /** Submit actions for all AI cat seats that need to act this phase. Returns true if any action was submitted. */
  private async actForPhase(runtime: GameRuntime): Promise<boolean> {
    const phase = runtime.currentPhase;

    const mapping = PHASE_ACTION_MAP[phase];
    if (!mapping) return false;

    const catSeats = this.getCatSeatsForPhase(runtime, mapping.actingRole);
    if (catSeats.length === 0) return false;

    // Check which seats haven't acted yet
    const pendingCats = catSeats.filter((s) => !runtime.pendingActions[s.seatId]);
    if (pendingCats.length === 0) return false;

    for (const seat of pendingCats) {
      const action = this.buildAction(runtime, seat.seatId as SeatId, mapping.actionName);
      if (!action) continue;

      try {
        await this.orchestrator.handlePlayerAction(runtime.gameId, seat.seatId, action);
      } catch (err) {
        // Phase may have advanced, action invalid — that's fine
        console.debug(`[GameAutoPlayer] Action failed for ${seat.seatId}:`, (err as Error).message);
      }
    }

    return true;
  }

  /** Get cat seats that should act in this phase */
  private getCatSeatsForPhase(runtime: GameRuntime, actingRole: string) {
    return runtime.seats.filter((s) => {
      if (s.actorType !== 'cat') return false;
      if (!s.alive) return false;
      if (actingRole === '*') return true;
      return s.role === actingRole;
    });
  }

  /** Build a valid action for a cat seat given current game state */
  private buildAction(runtime: GameRuntime, seatId: SeatId, actionName: string): GameAction | null {
    const seat = runtime.seats.find((s) => s.seatId === seatId);
    if (!seat) return null;

    const aliveOthers = runtime.seats.filter((s) => s.alive && s.seatId !== seatId);
    if (aliveOthers.length === 0) return null;

    const now = Date.now();

    switch (actionName) {
      case 'kill': {
        // Wolves target a non-wolf
        const wolfRoles = new Set(['wolf']);
        const targets = aliveOthers.filter((s) => !wolfRoles.has(s.role));
        const target = targets.length > 0 ? pickRandom(targets) : pickRandom(aliveOthers);
        return { seatId, actionName: 'kill', targetSeat: target.seatId as SeatId, submittedAt: now };
      }

      case 'guard': {
        // Guard: pick random alive player (excluding last guarded if applicable)
        const lastGuarded = seat.properties.lastGuardTarget;
        const targets = aliveOthers.filter((s) => s.seatId !== lastGuarded);
        const pool = targets.length > 0 ? targets : aliveOthers;
        return { seatId, actionName: 'guard', targetSeat: pickRandom(pool).seatId as SeatId, submittedAt: now };
      }

      case 'divine': {
        // Seer: pick random alive player to divine
        return { seatId, actionName: 'divine', targetSeat: pickRandom(aliveOthers).seatId as SeatId, submittedAt: now };
      }

      case 'heal': {
        // Witch: 50% chance to heal the knifed target (pass), 50% chance to skip
        // For simplicity, skip heal action (just submit a no-op heal)
        return { seatId, actionName: 'heal', submittedAt: now };
      }

      case 'shoot': {
        // Hunter: shoot a random alive player
        return { seatId, actionName: 'shoot', targetSeat: pickRandom(aliveOthers).seatId as SeatId, submittedAt: now };
      }

      case 'vote': {
        // Vote for a random alive player
        return { seatId, actionName: 'vote', targetSeat: pickRandom(aliveOthers).seatId as SeatId, submittedAt: now };
      }

      case 'speak': {
        // Discussion: submit a speak action (no target needed)
        return { seatId, actionName: 'speak', submittedAt: now };
      }

      default:
        return null;
    }
  }
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
