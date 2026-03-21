/**
 * GameAutoPlayer (F101 Phase C → H3/H4)
 *
 * Drives AI cat seats through the game loop.
 * Phase H3: Uses WerewolfAIPlayer (LLM) for decisions, falls back to random.
 * Phase H4: AI speech with messageStore context.
 */

import type { GameAction, GameRuntime, GameView, Seat, SeatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import type { IGameStore } from '../stores/ports/GameStore.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { GameOrchestrator } from './GameOrchestrator.js';
import { GameViewBuilder } from './GameViewBuilder.js';
import { LlmAIProvider } from './LlmAIProvider.js';
import { WerewolfAIPlayer } from './werewolf/WerewolfAIPlayer.js';

const log = createModuleLogger('game-auto-player');

interface AutoPlayerDeps {
  gameStore: IGameStore;
  orchestrator: GameOrchestrator;
  /** Optional: when provided, AI speech context is assembled from messageStore (H4) */
  messageStore?: IMessageStore;
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

/** Phases that resolve instantly — no player action, no delay */
const SKIP_PHASES = new Set(['night_resolve', 'day_pk', 'lobby']);

/** Phases that tick through after a brief pause — shows announcements before advancing */
const ANNOUNCE_PHASES = new Set(['day_announce', 'day_last_words', 'day_exile']);

export class GameAutoPlayer {
  private readonly store: IGameStore;
  private readonly orchestrator: GameOrchestrator;
  private readonly messageStore?: IMessageStore;
  private readonly activeLoops = new Set<string>();
  private stopController: AbortController | null = null;
  /** Per-cat AI player cache (keyed by actorId) */
  private readonly aiPlayers = new Map<string, WerewolfAIPlayer>();

  constructor(deps: AutoPlayerDeps) {
    this.store = deps.gameStore;
    this.orchestrator = deps.orchestrator;
    this.messageStore = deps.messageStore;
  }

  /** Get or create a WerewolfAIPlayer for a cat. Returns null if model not configured. */
  private getAIPlayer(catId: string): WerewolfAIPlayer | null {
    if (this.aiPlayers.has(catId)) return this.aiPlayers.get(catId) ?? null;
    try {
      const player = new WerewolfAIPlayer(new LlmAIProvider(catId));
      this.aiPlayers.set(catId, player);
      return player;
    } catch {
      // Model not configured for this cat — cache miss, skip LLM
      return null;
    }
  }

  /** Start the auto-play loop for a game. Runs asynchronously. */
  startLoop(gameId: string): void {
    if (this.activeLoops.has(gameId)) return;
    this.activeLoops.add(gameId);
    if (!this.stopController) this.stopController = new AbortController();
    log.info({ gameId }, `[GameAutoPlayer] Loop started`);
    this.runLoop(gameId)
      .catch((err) => {
        log.error({ gameId, err }, `[GameAutoPlayer] Loop error`);
      })
      .finally(() => {
        this.activeLoops.delete(gameId);
        log.info({ gameId }, `[GameAutoPlayer] Loop exited`);
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
        log.info(
          { gameId: game.gameId, phase: game.currentPhase, round: game.round },
          `[GameAutoPlayer] Recovering loop`,
        );
        this.startLoop(game.gameId);
        recovered++;
      }
    }
    if (recovered > 0) {
      log.info({ count: recovered }, `[GameAutoPlayer] Recovered active game(s)`);
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
        log.warn(
          { gameId, maxMs: GameAutoPlayer.MAX_WALL_CLOCK_MS },
          `[GameAutoPlayer] wall-clock safety limit reached, exiting loop`,
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

      if (ANNOUNCE_PHASES.has(runtime.currentPhase)) {
        await this.orchestrator.tick(gameId);
        await sleep(GameAutoPlayer.TICK_MS * 2, signal);
        continue;
      }

      const acted = await this.actForPhase(runtime);
      if (acted) {
        log.info({ gameId, phase: runtime.currentPhase, round: runtime.round }, `[GameAutoPlayer] actions submitted`);
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

    let anySucceeded = false;
    for (const seat of pendingCats) {
      const action = await this.buildAction(runtime, seat, mapping.actionName);
      if (!action) continue;

      try {
        await this.orchestrator.handlePlayerAction(runtime.gameId, seat.seatId, action);
        anySucceeded = true;
      } catch (err) {
        // Phase may have advanced, action invalid — that's fine
        log.debug({ seatId: seat.seatId, msg: (err as Error).message }, `[GameAutoPlayer] Action failed`);
      }
    }

    return anySucceeded;
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

  /** H3: Build action using LLM, with random fallback on failure */
  private async buildAction(runtime: GameRuntime, seat: Seat, actionName: string): Promise<GameAction | null> {
    const seatId = seat.seatId as SeatId;
    const aliveOthers = runtime.seats.filter((s) => s.alive && s.seatId !== seatId);
    if (aliveOthers.length === 0) return null;

    // Try LLM decision if this is an AI cat
    if (seat.actorType === 'cat') {
      try {
        const aiAction = await this.buildAIAction(runtime, seat, seatId, actionName);
        if (aiAction) return aiAction;
      } catch (err) {
        log.warn({ seatId, actorId: seat.actorId, msg: (err as Error).message }, `[GameAutoPlayer] AI fallback`);
      }
    }

    // Fallback: random selection (original logic)
    return this.buildRandomAction(runtime, seat, seatId, actionName, aliveOthers);
  }

  /** H3: LLM-powered action decision via WerewolfAIPlayer.
   *  Returns null if LLM response is invalid (triggers random fallback in caller). */
  private async buildAIAction(
    runtime: GameRuntime,
    seat: Seat,
    seatId: SeatId,
    actionName: string,
  ): Promise<GameAction | null> {
    const aiPlayer = this.getAIPlayer(seat.actorId);
    if (!aiPlayer) return null; // No model configured — caller falls back to random
    const view = GameViewBuilder.buildView(runtime, seatId);
    const aliveSeatIds = new Set(runtime.seats.filter((s) => s.alive).map((s) => s.seatId));

    let action: GameAction | null = null;

    switch (actionName) {
      case 'kill':
      case 'guard':
      case 'divine':
      case 'heal':
      case 'shoot':
        action = await aiPlayer.decideNightAction(seatId, seat.role, view, runtime.round);
        break;
      case 'vote':
        action = await aiPlayer.decideVote(seatId, seat.role, view, runtime.round);
        break;
      case 'speak': {
        const speechText = await this.buildAISpeech(runtime, seat, seatId, view);
        return { seatId, actionName: 'speak', params: { speechText }, submittedAt: Date.now() };
      }
      default:
        return null;
    }

    // Validate LLM response — reject if actionName/targetSeat don't match phase rules
    if (!action || !action.actionName) return null;

    // Phase+role whitelist: actionName must be allowed for this phase and role
    const allowedActions = runtime.definition.actions.filter(
      (a) => a.allowedPhase === runtime.currentPhase && (a.allowedRole === seat.role || a.allowedRole === '*'),
    );
    const isAllowedAction = allowedActions.some((a) => a.name === action!.actionName);
    if (!isAllowedAction) {
      log.warn(
        { actionName: action.actionName, phase: runtime.currentPhase, role: seat.role },
        `[GameAutoPlayer] AI returned actionName not allowed in phase for role, falling back`,
      );
      return null;
    }

    // targetSeat must be an alive seat (if provided)
    if (action.targetSeat && !aliveSeatIds.has(action.targetSeat)) {
      log.warn(
        { targetSeat: action.targetSeat, seatId },
        `[GameAutoPlayer] AI returned invalid targetSeat, falling back`,
      );
      return null;
    }

    return action;
  }

  /** H4: Build AI speech with prior game conversation context from messageStore */
  private async buildAISpeech(_runtime: GameRuntime, seat: Seat, seatId: SeatId, view: GameView): Promise<string> {
    const aiPlayer = this.getAIPlayer(seat.actorId);
    if (!aiPlayer) return `我是${seat.actorId}，暂时没有特别要分享的。`;

    // Augment view with conversation history from messageStore
    if (this.messageStore && _runtime.threadId) {
      const recentMessages = await this.messageStore.getByThread(_runtime.threadId, 50);
      const visible = recentMessages.filter(
        (m) =>
          !m.visibility ||
          m.visibility === 'public' ||
          (m.extra?.targetCats as string[] | undefined)?.includes(seat.actorId),
      );
      if (visible.length > 0) {
        // Build catId → seatId mapping for consistent prompt identity
        const catToSeat = new Map<string, string>();
        for (const s of _runtime.seats) {
          catToSeat.set(s.actorId, s.seatId);
        }
        // Inject conversation as synthetic visible events so the prompt includes them
        for (const m of visible) {
          const speakerSeat = m.catId ? (catToSeat.get(m.catId) ?? m.catId) : 'system';
          view.visibleEvents.push({
            eventId: `msg-${m.id}`,
            round: _runtime.round,
            phase: 'day_discuss',
            type: m.catId ? 'speech' : 'announce',
            scope: 'public' as import('@cat-cafe/shared').EventScope,
            payload: { seatId: speakerSeat, text: m.content },
            timestamp: m.timestamp,
          });
        }
      }
    }

    const text = await aiPlayer.decideSpeech(seatId, seat.role, view, _runtime.round);
    return text || `我是${seat.actorId}，暂时没有特别要分享的。`;
  }

  /** Fallback: random action selection (original pre-H3 logic) */
  private buildRandomAction(
    _runtime: GameRuntime,
    seat: Seat,
    seatId: SeatId,
    actionName: string,
    aliveOthers: Seat[],
  ): GameAction | null {
    const now = Date.now();

    switch (actionName) {
      case 'kill': {
        const wolfRoles = new Set(['wolf']);
        const targets = aliveOthers.filter((s) => !wolfRoles.has(s.role));
        const target = targets.length > 0 ? pickRandom(targets) : pickRandom(aliveOthers);
        return { seatId, actionName: 'kill', targetSeat: target.seatId as SeatId, submittedAt: now };
      }
      case 'guard': {
        const lastGuarded = seat.properties.lastGuardTarget;
        const targets = aliveOthers.filter((s) => s.seatId !== lastGuarded);
        const pool = targets.length > 0 ? targets : aliveOthers;
        return { seatId, actionName: 'guard', targetSeat: pickRandom(pool).seatId as SeatId, submittedAt: now };
      }
      case 'divine':
        return { seatId, actionName: 'divine', targetSeat: pickRandom(aliveOthers).seatId as SeatId, submittedAt: now };
      case 'heal':
        return { seatId, actionName: 'heal', submittedAt: now };
      case 'shoot':
        return { seatId, actionName: 'shoot', targetSeat: pickRandom(aliveOthers).seatId as SeatId, submittedAt: now };
      case 'vote':
        return { seatId, actionName: 'vote', targetSeat: pickRandom(aliveOthers).seatId as SeatId, submittedAt: now };
      case 'speak': {
        const templates = [
          `我是${seat.actorId}，目前没有特殊信息可以分享。`,
          `我觉得${pickRandom(aliveOthers).seatId}有嫌疑，大家注意一下。`,
          `昨晚没什么特别的发现，先听听其他人的看法。`,
          `我建议大家冷静分析，不要被情绪左右投票。`,
        ];
        return { seatId, actionName: 'speak', params: { speechText: pickRandom(templates) }, submittedAt: now };
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
