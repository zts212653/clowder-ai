/**
 * GameOrchestrator (F101)
 *
 * System-driven game lifecycle: start → tick → action → advance → end.
 * Coordinates GameEngine (logic) + GameStore (persistence) + Socket (broadcast).
 */

import type { GameAction, GameConfig, GameDefinition, GameRuntime, Seat } from '@cat-cafe/shared';
import type { IGameStore } from '../stores/ports/GameStore.js';
import { GameEngine } from './GameEngine.js';
import { GameViewBuilder } from './GameViewBuilder.js';
import { WerewolfEngine } from './werewolf/WerewolfEngine.js';

interface SocketLike {
  broadcastToRoom(room: string, event: string, data: unknown): void;
  emitToUser(userId: string, event: string, data: unknown): void;
}

export interface GameOrchestratorDeps {
  gameStore: IGameStore;
  socketManager: SocketLike;
}

export interface StartGameInput {
  threadId: string;
  definition: GameDefinition;
  seats: Seat[];
  config: GameConfig;
}

export class GameOrchestrator {
  private readonly store: IGameStore;
  private readonly socket: SocketLike;

  constructor(deps: GameOrchestratorDeps) {
    this.store = deps.gameStore;
    this.socket = deps.socketManager;
  }

  /** Create and persist a new game, broadcast to thread */
  async startGame(input: StartGameInput): Promise<GameRuntime> {
    const now = Date.now();
    const gameId = `game-${now}-${Math.random().toString(36).slice(2, 8)}`;

    const runtime: GameRuntime = {
      gameId,
      threadId: input.threadId,
      gameType: input.definition.gameType,
      definition: input.definition,
      seats: input.seats,
      currentPhase: input.definition.phases[0]?.name ?? 'lobby',
      round: 1,
      eventLog: [],
      pendingActions: {},
      status: 'playing',
      config: input.config,
      phaseStartedAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    // Auto-skip initial phase(s) if no actors for the role (system-driven, not cat-driven)
    this.skipEmptyPhases(runtime);

    const created = await this.store.createGame(runtime);

    this.socket.broadcastToRoom(`thread:${input.threadId}`, 'game:started', {
      gameId: created.gameId,
      gameType: created.gameType,
      status: created.status,
      seats: created.seats.map((s) => ({ seatId: s.seatId, actorType: s.actorType, actorId: s.actorId })),
      timestamp: now,
    });

    return created;
  }

  /** Handle a player action submission */
  async handlePlayerAction(gameId: string, seatId: string, action: GameAction): Promise<void> {
    const runtime = await this.store.getGame(gameId);
    if (!runtime) throw new Error(`Game ${gameId} not found`);
    if (runtime.status !== 'playing') throw new Error('Game is not active');

    const engine = this.createEngine(runtime);
    engine.submitAction(seatId, action);

    if (engine.allActionsCollected()) {
      this.advancePhase(engine);
    }

    await this.store.updateGame(gameId, engine.getRuntime());
    await this.broadcastGameState(gameId);
  }

  /** System tick — check timeouts and advance if expired */
  async tick(gameId: string): Promise<void> {
    const runtime = await this.store.getGame(gameId);
    if (!runtime) return;
    if (runtime.status !== 'playing') return;

    const phaseDef = runtime.definition.phases.find((p) => p.name === runtime.currentPhase);
    if (!phaseDef) return;

    const phaseStart = runtime.phaseStartedAt ?? runtime.updatedAt;
    const elapsed = Date.now() - phaseStart;

    if (elapsed < phaseDef.timeoutMs) return; // not expired

    // Timeout — advance phase
    const engine = this.createEngine(runtime);
    engine.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'timeout',
      scope: 'public',
      payload: { reason: 'phase_timeout' },
    });

    this.advancePhase(engine);
    await this.store.updateGame(gameId, engine.getRuntime());
    await this.broadcastGameState(gameId);
  }

  /** Broadcast scoped game state — per-seat views to each actor + observer */
  async broadcastGameState(gameId: string): Promise<void> {
    const runtime = await this.store.getGame(gameId);
    if (!runtime) return;

    const now = Date.now();

    // Emit per-seat scoped views (information isolation at transport layer)
    for (const seat of runtime.seats) {
      const view = GameViewBuilder.buildView(runtime, seat.seatId as import('@cat-cafe/shared').SeatId);
      this.socket.emitToUser(seat.actorId, 'game:state_update', {
        gameId: runtime.gameId,
        view,
        timestamp: now,
      });
    }

    // Emit observer view for god-view/detective humans (not in seats)
    const { humanRole, observerUserId } = runtime.config;
    if (observerUserId && humanRole !== 'player') {
      const viewer =
        humanRole === 'detective' && runtime.config.detectiveSeatId
          ? (`detective:${runtime.config.detectiveSeatId}` as const)
          : 'god';
      const view = GameViewBuilder.buildView(runtime, viewer);
      this.socket.emitToUser(observerUserId, 'game:state_update', {
        gameId: runtime.gameId,
        view,
        timestamp: now,
      });
    }
  }

  /** God action: pause a playing game */
  async pauseGame(gameId: string): Promise<void> {
    const runtime = await this.store.getGame(gameId);
    if (!runtime) throw new Error(`Game ${gameId} not found`);
    if (runtime.status !== 'playing') throw new Error('Game is not playing');

    runtime.status = 'paused';
    runtime.updatedAt = Date.now();
    await this.store.updateGame(gameId, runtime);

    this.socket.broadcastToRoom(`thread:${runtime.threadId}`, 'game:paused', {
      gameId,
      timestamp: Date.now(),
    });
  }

  /** God action: resume a paused game */
  async resumeGame(gameId: string): Promise<void> {
    const runtime = await this.store.getGame(gameId);
    if (!runtime) throw new Error(`Game ${gameId} not found`);
    if (runtime.status !== 'paused') throw new Error('Game is not paused');

    runtime.status = 'playing';
    runtime.phaseStartedAt = Date.now();
    runtime.updatedAt = Date.now();
    await this.store.updateGame(gameId, runtime);

    this.socket.broadcastToRoom(`thread:${runtime.threadId}`, 'game:resumed', {
      gameId,
      timestamp: Date.now(),
    });
    await this.broadcastGameState(gameId);
  }

  /** God action: skip current phase */
  async skipPhase(gameId: string): Promise<void> {
    const runtime = await this.store.getGame(gameId);
    if (!runtime) throw new Error(`Game ${gameId} not found`);
    if (runtime.status !== 'playing') throw new Error('Game is not playing');

    const engine = this.createEngine(runtime);
    engine.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'god_skip',
      scope: 'public',
      payload: { reason: 'god_skipped_phase' },
    });

    this.advancePhase(engine);
    await this.store.updateGame(gameId, engine.getRuntime());
    await this.broadcastGameState(gameId);
  }

  // --- Private helpers ---

  private createEngine(runtime: GameRuntime): GameEngine {
    if (runtime.gameType === 'werewolf') return new WerewolfEngine(runtime);
    return new GameEngine(runtime);
  }

  private advancePhase(engine: GameEngine): void {
    const runtime = engine.getRuntime();
    const phases = runtime.definition.phases;
    const currentIdx = phases.findIndex((p) => p.name === runtime.currentPhase);

    engine.clearPendingActions();

    const nextIdx = currentIdx + 1;
    const targetPhase = nextIdx < phases.length ? phases[nextIdx] : phases[0];
    if (!targetPhase) return; // no phases defined

    const isNewRound = nextIdx >= phases.length;
    if (isNewRound) {
      runtime.round++;
    }

    const fromPhase = runtime.currentPhase;
    runtime.currentPhase = targetPhase.name;
    runtime.phaseStartedAt = Date.now();

    engine.appendEvent({
      round: runtime.round,
      phase: targetPhase.name,
      type: isNewRound ? 'round_start' : 'phase_start',
      scope: 'public',
      payload: isNewRound ? { round: runtime.round } : { from: fromPhase, to: targetPhase.name },
    });

    this.socket.broadcastToRoom(`thread:${runtime.threadId}`, 'game:phase_changed', {
      gameId: runtime.gameId,
      phase: targetPhase.name,
      round: runtime.round,
      timestamp: Date.now(),
    });

    // Check win condition after phase advance
    const winner = engine.checkWinCondition();
    if (winner) {
      runtime.status = 'finished';
      runtime.winner = winner;
      engine.appendEvent({
        round: runtime.round,
        phase: runtime.currentPhase,
        type: 'game_end',
        scope: 'public',
        payload: { winner },
      });
      this.socket.broadcastToRoom(`thread:${runtime.threadId}`, 'game:finished', {
        gameId: runtime.gameId,
        winner,
        timestamp: Date.now(),
      });
      return;
    }

    // Auto-skip if new phase has no actors (system-driven, not cat-driven)
    this.skipEmptyPhases(runtime);
  }

  /** Skip consecutive phases that have no alive actors for the acting role.
   *  System (judge) handles this — cats should never wait for a non-existent role. */
  private skipEmptyPhases(runtime: GameRuntime): void {
    const phases = runtime.definition.phases;
    let safety = phases.length; // prevent infinite loops
    while (safety-- > 0) {
      const phase = phases.find((p) => p.name === runtime.currentPhase);
      if (!phase) break;
      const role = phase.actingRole;
      if (!role || role === '*') break; // wildcard phases always have actors
      if (runtime.seats.some((s) => s.alive && s.role === role)) break; // has actors

      // No alive seat for this role — skip
      const skipped = runtime.currentPhase;
      const curIdx = phases.findIndex((p) => p.name === runtime.currentPhase);
      const nextIdx = curIdx + 1;
      const next = nextIdx < phases.length ? phases[nextIdx] : phases[0];
      if (!next) break;

      const isNewRound = nextIdx >= phases.length;
      if (isNewRound) runtime.round++;

      runtime.eventLog.push({
        eventId: `evt-skip-${Date.now()}-${skipped}`,
        round: runtime.round,
        phase: skipped,
        type: 'phase_skip',
        scope: 'public' as import('@cat-cafe/shared').EventScope,
        payload: { skippedPhase: skipped, reason: 'no_actors_for_role' },
        timestamp: Date.now(),
      });

      runtime.currentPhase = next.name;
      runtime.phaseStartedAt = Date.now();
      runtime.version++;
      runtime.updatedAt = Date.now();
    }
  }
}
