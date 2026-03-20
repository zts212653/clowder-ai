/**
 * GameViewBuilder (F101)
 *
 * Builds scoped GameView from GameRuntime for a specific viewer.
 * Handles role/faction visibility and event filtering.
 */

import type {
  ActionStatus,
  EventScope,
  GameEvent,
  GameRuntime,
  GameView,
  PendingAction,
  SeatId,
  SeatView,
} from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { GameStatsRecorder } from './GameStatsRecorder.js';

export class GameViewBuilder {
  /** Build a scoped view for a specific viewer.
   *  viewer formats: SeatId ('P1'), 'god', or 'detective:P3' (inherits bound seat's perspective) */
  static buildView(runtime: GameRuntime, viewer: SeatId | 'god' | `detective:${string}`): GameView {
    const isGod = viewer === 'god';
    const isDetective = typeof viewer === 'string' && viewer.startsWith('detective:');
    const boundSeatId = isDetective ? (viewer.slice(10) as SeatId) : undefined;
    // Detective inherits bound seat's perspective; player sees own seat
    const effectiveSeatId = boundSeatId ?? (isGod ? undefined : (viewer as SeatId));
    const viewerSeat = effectiveSeatId ? runtime.seats.find((s) => s.seatId === effectiveSeatId) : undefined;
    // Dead players/bound-seats lose faction visibility (no faction leak after death)
    const viewerFaction = viewerSeat?.alive
      ? runtime.definition.roles.find((r) => r.name === viewerSeat.role)?.faction
      : undefined;

    // Filter events by visibility + revealPolicy
    const visibleEvents = runtime.eventLog.filter((e) => {
      // Scope check
      if (!isGod && !GameViewBuilder.isVisible(e.scope, effectiveSeatId as SeatId, viewerFaction)) {
        return false;
      }
      // revealPolicy check (god always sees everything)
      if (!isGod && e.revealPolicy) {
        if (!GameViewBuilder.isRevealed(e, runtime)) return false;
      }
      return true;
    });

    // Build seat views with role masking
    const seats: SeatView[] = runtime.seats.map((seat) => {
      const seatRole = runtime.definition.roles.find((r) => r.name === seat.role);
      const showRole =
        isGod ||
        seat.seatId === effectiveSeatId || // see bound/own seat's role
        (viewerFaction && seatRole?.faction === viewerFaction); // see faction mates

      // hasActed is sensitive during night phases — only god/detective or own seat can see it.
      // During day phases (public), everyone can see who has acted (e.g. voted).
      const isPublicPhase = runtime.currentPhase?.startsWith('day_') ?? false;
      const canSeeActed = isGod || isDetective || seat.seatId === effectiveSeatId || isPublicPhase;

      const pending = runtime.pendingActions[seat.seatId] as PendingAction | undefined;

      const sv: SeatView = {
        seatId: seat.seatId,
        actorType: seat.actorType,
        actorId: seat.actorId,
        displayName: GameViewBuilder.enrichDisplayName(seat.actorId),
        alive: seat.alive,
        hasActed: canSeeActed ? !!pending : undefined,
      };

      // God view: expose per-seat actionStatus only for seats expected to act
      if (isGod && seat.alive) {
        const phaseDef = runtime.definition.phases.find((p) => p.name === runtime.currentPhase);
        const actingRole = phaseDef?.actingRole;
        const shouldAct = actingRole === '*' || (actingRole != null && seat.role === actingRole);
        if (shouldAct) {
          sv.actionStatus = (pending?.status as ActionStatus) ?? 'waiting';
        }
      }

      if (showRole) {
        sv.role = seat.role;
        if (seatRole?.faction) sv.faction = seatRole.faction;
      }
      return sv;
    });

    const view: GameView = {
      gameId: runtime.gameId,
      threadId: runtime.threadId,
      gameType: runtime.gameType,
      status: runtime.status,
      currentPhase: runtime.currentPhase,
      round: runtime.round,
      seats,
      visibleEvents,
      phaseStartedAt: runtime.phaseStartedAt,
      config: {
        timeoutMs: runtime.config.timeoutMs,
        voiceMode: runtime.config.voiceMode,
        humanRole: runtime.config.humanRole,
        ...(runtime.config.humanSeat ? { humanSeat: runtime.config.humanSeat } : {}),
        ...(runtime.config.detectiveSeatId ? { detectiveSeatId: runtime.config.detectiveSeatId } : {}),
      },
    };
    if (runtime.winner) view.winner = runtime.winner;

    // Aggregate action progress (non-god views only — god has per-seat detail)
    if (!isGod) {
      const phaseDef = runtime.definition.phases.find((p) => p.name === runtime.currentPhase);
      if (phaseDef) {
        const actingRole = phaseDef.actingRole;
        const expectedSeats =
          actingRole === '*'
            ? runtime.seats.filter((s) => s.alive)
            : runtime.seats.filter((s) => s.alive && s.role === actingRole);
        view.totalExpected = expectedSeats.length;
        view.submittedCount = expectedSeats.filter((s) => !!runtime.pendingActions[s.seatId]).length;
      }
    }

    // Attach detailed stats when game is finished
    if (runtime.status === 'finished') {
      const detailed = GameStatsRecorder.extractDetailedStats(runtime);
      view.gameStats = {
        winner: detailed.winner,
        rounds: detailed.rounds,
        duration: detailed.duration,
        mvpSeatId: detailed.mvpSeatId,
        mvpReason: detailed.mvpReason,
        players: detailed.players.map((p) => ({
          seatId: p.seatId,
          actorId: p.actorId,
          role: p.role,
          faction: p.faction,
          survived: p.survived,
          won: p.won,
          killCount: p.killCount,
          savedCount: p.savedCount,
          divineCount: p.divineCount,
        })),
      };
    }

    return view;
  }

  /** Check if event's revealPolicy allows it to be shown */
  private static isRevealed(event: GameEvent, runtime: GameRuntime): boolean {
    if (!event.revealPolicy || event.revealPolicy === 'live') return true;
    if (event.revealPolicy === 'phase_end') {
      // Events from prior rounds are always revealed (phase names recur across rounds)
      if (event.round < runtime.round) return true;
      // Same round: visible only if current phase is different from event's phase
      return runtime.currentPhase !== event.phase;
    }
    if (event.revealPolicy === 'game_end') {
      return runtime.status === 'finished';
    }
    return true;
  }

  private static isVisible(scope: EventScope, viewer: SeatId, viewerFaction?: string): boolean {
    if (scope === 'public') return true;
    if (scope === 'god' || scope === 'judge') return false;
    if (scope === `seat:${viewer}`) return true;
    if (viewerFaction && scope === `faction:${viewerFaction}`) return true;
    return false;
  }

  /** H6: Enrich actorId to "breed(actorId)" format.
   *  e.g. "opus" → "布偶猫(opus)", "codex" → "缅因猫(codex)" */
  private static enrichDisplayName(actorId: string): string {
    const entry = catRegistry.tryGet(actorId);
    if (!entry) return actorId;
    const breed = entry.config.breedDisplayName ?? entry.config.displayName;
    return breed ? `${breed}(${actorId})` : actorId;
  }
}
