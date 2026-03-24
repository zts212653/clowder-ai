/**
 * GameOrchestrator (F101)
 *
 * System-driven game lifecycle: start → tick → action → advance → end.
 * Coordinates GameEngine (logic) + GameStore (persistence) + Socket (broadcast).
 */

import type { GameAction, GameConfig, GameDefinition, GameRuntime, PendingAction, Seat } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import type { IGameStore } from '../stores/ports/GameStore.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import { GameEngine } from './GameEngine.js';
import { GameViewBuilder } from './GameViewBuilder.js';
import { WerewolfEngine } from './werewolf/WerewolfEngine.js';

const log = createModuleLogger('game-orchestrator');

interface SocketLike {
  broadcastToRoom(room: string, event: string, data: unknown): void;
  emitToUser(userId: string, event: string, data: unknown): void;
}

export interface GameOrchestratorDeps {
  gameStore: IGameStore;
  socketManager: SocketLike;
  /** Optional: when provided, game announce/speech events are dual-written to messageStore (Phase H) */
  messageStore?: IMessageStore;
  onGameEnd?: (gameId: string) => void;
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
  private readonly messageStore?: IMessageStore;
  private readonly onGameEnd?: (gameId: string) => void;

  constructor(deps: GameOrchestratorDeps) {
    this.store = deps.gameStore;
    this.socket = deps.socketManager;
    this.messageStore = deps.messageStore;
    this.onGameEnd = deps.onGameEnd;
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

    // Log action.requested
    engine.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'action.requested',
      scope: 'god',
      payload: { seatId, actionName: action.actionName },
      revealPolicy: 'live',
    });

    engine.submitAction(seatId, action);

    // Mark as acted + log action.submitted
    const pending = engine.getRuntime().pendingActions[seatId] as PendingAction | undefined;
    if (pending) {
      pending.status = 'acted';
    }

    engine.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'action.submitted',
      scope: 'god',
      payload: { seatId, actionName: action.actionName, target: action.targetSeat },
      revealPolicy: 'live',
    });

    // H2: Record speech + dual-write to messageStore when speak action has text
    // Accept both speechText (AI path) and content (human frontend path)
    const speechText = (action.params?.speechText ?? action.params?.content) as string | undefined;
    if (action.actionName === 'speak' && speechText) {
      const seat = runtime.seats.find((s) => s.seatId === seatId);
      if (engine instanceof WerewolfEngine) {
        (engine as WerewolfEngine).recordSpeech(seatId, speechText);
      }
      this.writeSpeech(runtime, seat?.actorId ?? seatId, speechText);
    }

    // Emit real-time ballot.updated for day votes (KD-26: live transparency)
    if (action.actionName === 'vote' && action.targetSeat) {
      engine.appendEvent({
        round: runtime.round,
        phase: runtime.currentPhase,
        type: 'ballot.updated',
        scope: 'public',
        payload: { voterSeat: seatId, choice: action.targetSeat, revision: 1 },
        revealPolicy: 'live',
      });
    }

    if (engine.allActionsCollected()) {
      this.advancePhase(engine);
    }

    await this.store.updateGame(gameId, engine.getRuntime());
    await this.broadcastGameState(gameId);
  }

  /** System tick — check timeouts, apply fallbacks, and advance if expired */
  async tick(gameId: string): Promise<void> {
    const runtime = await this.store.getGame(gameId);
    if (!runtime) return;
    if (runtime.status !== 'playing') return;

    const phaseDef = runtime.definition.phases.find((p) => p.name === runtime.currentPhase);
    if (!phaseDef) return;

    const phaseStart = runtime.phaseStartedAt ?? runtime.updatedAt;
    const elapsed = Date.now() - phaseStart;

    // Grace period: on round 1, extend timeout by max grace among seated cats
    const graceMs = runtime.round === 1 ? this.getMaxGraceMs(runtime) : 0;
    const effectiveTimeout = phaseDef.timeoutMs + graceMs;

    if (elapsed < effectiveTimeout) return; // not expired

    const engine = this.createEngine(runtime);

    // Apply fallbacks for missing seats before advancing
    this.applyFallbacks(engine);

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

  /** H2: Write a cat speech message to messageStore (dual-write) */
  private writeSpeech(runtime: GameRuntime, catId: string, content: string): void {
    if (!this.messageStore) return;
    const userId = runtime.config.observerUserId ?? 'system';
    Promise.resolve(
      this.messageStore.append({
        userId,
        catId: catId as import('@cat-cafe/shared').CatId,
        content,
        mentions: [],
        timestamp: Date.now(),
        threadId: runtime.threadId,
      }),
    ).catch((err) => {
      log.error({ err }, '[GameOrchestrator] Failed to write speech to messageStore');
    });
  }

  private writeAnnounce(runtime: GameRuntime, content: string): void {
    if (!this.messageStore) return;
    const userId = runtime.config.observerUserId ?? 'system';
    Promise.resolve(
      this.messageStore.append({
        userId,
        catId: null,
        content,
        mentions: [],
        timestamp: Date.now(),
        threadId: runtime.threadId,
      }),
    ).catch((err) => {
      log.error({ err }, '[GameOrchestrator] Failed to write announce to messageStore');
    });
  }

  private formatDeaths(deaths: string[], runtime: GameRuntime): string {
    return deaths
      .map((seatId) => {
        const seat = runtime.seats.find((s) => s.seatId === seatId);
        const name = seat ? `${seatId}(${seat.actorId})` : seatId;
        return name;
      })
      .join('、');
  }

  /** Grace periods per cat breed (KD-28). Only applied on round 1. */
  private static readonly GRACE_MS: Record<string, number> = {
    opus: 6000,
    codex: 12000,
    gpt52: 12000,
    gemini: 30000,
  };

  /** Get max grace period among all cat actors in the game */
  private getMaxGraceMs(runtime: GameRuntime): number {
    let maxGrace = 0;
    for (const seat of runtime.seats) {
      if (seat.actorType === 'cat') {
        const grace = GameOrchestrator.GRACE_MS[seat.actorId] ?? 0;
        if (grace > maxGrace) maxGrace = grace;
      }
    }
    return maxGrace;
  }

  /** Apply fallbacks for seats that haven't submitted actions */
  private applyFallbacks(engine: GameEngine): void {
    const runtime = engine.getRuntime();
    const phaseDef = runtime.definition.phases.find((p) => p.name === runtime.currentPhase);
    if (!phaseDef) return;

    const actingRole = phaseDef.actingRole;
    const expectedSeats =
      actingRole === '*'
        ? runtime.seats.filter((s) => s.alive && !s.properties.idiotRevealed)
        : runtime.seats.filter((s) => s.alive && s.role === actingRole);

    const aliveSeatIds = runtime.seats.filter((s) => s.alive).map((s) => s.seatId);

    for (const seat of expectedSeats) {
      if (runtime.pendingActions[seat.seatId]) continue; // already acted

      // Log timeout for this seat
      engine.appendEvent({
        round: runtime.round,
        phase: runtime.currentPhase,
        type: 'action.timeout',
        scope: 'god',
        payload: { seatId: seat.seatId, reason: 'timeout' },
      });

      // Generate random fallback target (any alive seat except self and same-faction)
      const wolfRoles = new Set(runtime.definition.roles.filter((r) => r.faction === 'wolf').map((r) => r.name));
      const isWolf = wolfRoles.has(seat.role);
      const validTargets = aliveSeatIds.filter((id) => {
        if (id === seat.seatId) return false;
        if (isWolf) {
          const targetSeat = runtime.seats.find((s) => s.seatId === id);
          return targetSeat ? !wolfRoles.has(targetSeat.role) : false;
        }
        return true;
      });

      const randomTarget =
        validTargets.length > 0
          ? validTargets[Math.floor(Math.random() * validTargets.length)]
          : (aliveSeatIds.find((id) => id !== seat.seatId) ?? seat.seatId);

      // Create fallback pending action — use phase-specific action definition
      const phaseActions = runtime.definition.actions.filter((a) => a.allowedPhase === runtime.currentPhase);
      const actionForSeat =
        phaseActions.find((a) => a.allowedRole === seat.role) ?? phaseActions.find((a) => a.allowedRole === '*');
      const fallbackActionName = actionForSeat?.name ?? 'vote';

      const fallbackAction: PendingAction = {
        seatId: seat.seatId as import('@cat-cafe/shared').SeatId,
        actionName: fallbackActionName,
        targetSeat: randomTarget as import('@cat-cafe/shared').SeatId,
        submittedAt: Date.now(),
        status: 'fallback',
        requestedAt: runtime.phaseStartedAt ?? runtime.updatedAt,
        fallbackSource: 'random',
      };
      runtime.pendingActions[seat.seatId] = fallbackAction;

      engine.appendEvent({
        round: runtime.round,
        phase: runtime.currentPhase,
        type: 'action.fallback',
        scope: 'god',
        payload: {
          seatId: seat.seatId,
          actionName: fallbackActionName,
          fallbackSource: 'random',
          target: randomTarget,
          reason: 'timeout',
        },
      });

      // Emit public ballot.updated for day-vote fallbacks (transparency trail)
      if (fallbackActionName === 'vote') {
        engine.appendEvent({
          round: runtime.round,
          phase: runtime.currentPhase,
          type: 'ballot.updated',
          scope: 'public',
          payload: { voterSeat: seat.seatId, choice: randomTarget, revision: 1, source: 'fallback' },
          revealPolicy: 'live',
        });
      }
    }
  }

  private createEngine(runtime: GameRuntime): GameEngine {
    if (runtime.gameType === 'werewolf') return new WerewolfEngine(runtime);
    return new GameEngine(runtime);
  }

  private advancePhase(engine: GameEngine): void {
    const runtime = engine.getRuntime();
    const phases = runtime.definition.phases;
    const currentIdx = phases.findIndex((p) => p.name === runtime.currentPhase);

    // Resolve current phase's actions before clearing
    this.resolveCurrentPhase(engine);

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

    // RB-8: Write round announce to messageStore
    if (isNewRound) {
      const roundText = `🌙 第 ${runtime.round} 个夜晚降临了。闭眼。`;
      engine.appendEvent({
        round: runtime.round,
        phase: targetPhase.name,
        type: 'round_announce',
        scope: 'public',
        payload: { round: runtime.round, text: roundText },
      });
      this.writeAnnounce(runtime, roundText);
    }

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

      const factionLabel = winner === 'wolf' ? '狼人阵营' : '好人阵营';
      const endText = `🏆 游戏结束！${factionLabel}获胜！`;
      this.writeAnnounce(runtime, endText);

      this.socket.broadcastToRoom(`thread:${runtime.threadId}`, 'game:finished', {
        gameId: runtime.gameId,
        winner,
        timestamp: Date.now(),
      });
      this.onGameEnd?.(runtime.gameId);
      return;
    }

    // Auto-skip if new phase has no actors (system-driven, not cat-driven)
    this.skipEmptyPhases(runtime);

    // H2: Generate last words immediately on ENTERING day_last_words (not on leaving).
    // Content must be visible during the phase, not appear only at phase end.
    if (runtime.currentPhase === 'day_last_words' && engine instanceof WerewolfEngine) {
      this.resolveLastWords(engine as WerewolfEngine, runtime);
    }
  }

  /** Resolve current phase's actions into game state via WerewolfEngine */
  private resolveCurrentPhase(engine: GameEngine): void {
    if (!(engine instanceof WerewolfEngine)) return;

    const werewolf = engine as WerewolfEngine;
    const runtime = engine.getRuntime();
    const phaseName = runtime.currentPhase;
    const phaseDef = runtime.definition.phases.find((p) => p.name === phaseName);
    if (!phaseDef) return;

    if (phaseName === 'night_resolve') {
      this.resolveNightFromEvents(werewolf, runtime);
    } else if (phaseDef.type === 'day_vote') {
      this.resolveDayVoteFromPending(werewolf, runtime);
    }
  }

  /** Reconstruct night actions from event log and resolve */
  private resolveNightFromEvents(werewolf: WerewolfEngine, runtime: GameRuntime): void {
    const roundEvents = runtime.eventLog.filter((e) => e.round === runtime.round);

    for (const evt of roundEvents) {
      if (evt.type !== 'action.submitted' && evt.type !== 'action.fallback') continue;
      const { seatId, actionName, target } = evt.payload as Record<string, string>;
      if (!seatId || !target) continue;

      if (actionName === 'kill') {
        werewolf.submitNightBallot(seatId, target);
      } else if (actionName === 'guard' || actionName === 'heal' || actionName === 'poison') {
        werewolf.setNightAction(seatId, actionName, target);
      }
    }

    const result = werewolf.resolveNight();

    werewolf.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'night_resolved',
      scope: 'god',
      payload: { deaths: result.deaths, hunterCanShoot: result.hunterCanShoot },
      revealPolicy: 'phase_end',
    });

    // RB-1 + RB-2: Write public dawn announce so players can see who died
    const dawnText =
      result.deaths.length > 0
        ? `☀️ 天亮了。昨夜 ${this.formatDeaths(result.deaths, runtime)} 被袭击。`
        : '☀️ 天亮了。昨夜是平安夜。';

    werewolf.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'dawn_announce',
      scope: 'public',
      payload: { deaths: result.deaths, text: dawnText },
    });

    this.writeAnnounce(runtime, dawnText);
  }

  /** Feed pending day votes into engine and resolve.
   *  Uses silent ballot feed — ballot.updated events were already emitted at submission time. */
  private resolveDayVoteFromPending(werewolf: WerewolfEngine, runtime: GameRuntime): void {
    for (const [seatId, pending] of Object.entries(runtime.pendingActions)) {
      const pa = pending as PendingAction;
      if (pa.actionName === 'vote' && pa.targetSeat) {
        // Skip revealed idiots — they lose voting rights (consistent with castDayVote)
        const seat = runtime.seats.find((s) => s.seatId === seatId);
        if (seat?.properties.idiotRevealed) continue;
        werewolf.feedDayBallotSilent(seatId, pa.targetSeat as string);
      }
    }

    const result = werewolf.resolveDayVotes();

    werewolf.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'vote_resolved',
      scope: 'public',
      payload: { exiled: result.exiled, tied: result.tied, pkCandidates: result.pkCandidates },
    });

    // RB-5: Write public exile announce with vote tally
    const exileText = result.exiled
      ? `🗳️ 投票结果：${result.exiled}(${runtime.seats.find((s) => s.seatId === result.exiled)?.actorId ?? '?'}) 被放逐。`
      : result.tied
        ? '🗳️ 投票平局，无人被放逐。'
        : '🗳️ 投票结束。';

    werewolf.appendEvent({
      round: runtime.round,
      phase: runtime.currentPhase,
      type: 'exile_announce',
      scope: 'public',
      payload: { exiled: result.exiled, tied: result.tied, text: exileText },
    });

    this.writeAnnounce(runtime, exileText);
  }

  /** H2/RB-4: Generate template last words for the exiled player.
   *  Finds the most recently exiled seat and writes their farewell. */
  private resolveLastWords(werewolf: WerewolfEngine, runtime: GameRuntime): void {
    // Find the exiled seat — recently killed via exile (check vote_resolved in this round)
    const voteResults = runtime.eventLog.filter((e) => e.round === runtime.round && e.type === 'vote_resolved');
    const voteResult = voteResults[voteResults.length - 1];
    const exiled = (voteResult?.payload as Record<string, unknown> | undefined)?.exiled as string | undefined;
    if (!exiled) return;

    const seat = runtime.seats.find((s) => s.seatId === exiled);
    if (!seat) return;

    const lastWordsText = `我是${seat.actorId}，我的遗言是：请大家相信我的判断，好人阵营加油。`;
    werewolf.recordLastWords(exiled, lastWordsText);

    // Announce + dual-write
    const announceText = `📜 ${exiled}(${seat.actorId}) 发表遗言。`;
    this.writeAnnounce(runtime, announceText);
    this.writeSpeech(runtime, seat.actorId, lastWordsText);
  }

  /** Skip consecutive phases that have no alive actors for the acting role.
   *  System (judge) handles this — cats should never wait for a non-existent role.
   *  Note: day_hunter death-trigger needs special architecture (dead seat can't
   *  submit actions). Currently disabled — hunter shoot is auto-skipped.
   *  TODO(H-next): implement hunter death-trigger as a special resolve phase. */
  private skipEmptyPhases(runtime: GameRuntime): void {
    const phases = runtime.definition.phases;
    let safety = phases.length; // prevent infinite loops
    while (safety-- > 0) {
      const phase = phases.find((p) => p.name === runtime.currentPhase);
      if (!phase) break;
      const role = phase.actingRole;
      if (!role || role === '*') break; // wildcard phases always have actors
      // day_hunter is deferred (v1) — always skip, death-trigger needs special resolve phase
      if (phase.name === 'day_hunter') {
        /* fall through to skip logic */
      } else if (runtime.seats.some((s) => s.alive && s.role === role)) break; // has actors

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
