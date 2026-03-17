/**
 * GameEngine Core (F101)
 *
 * Manages event log, action validation, and phase state.
 * Game-specific logic (resolution, phase transitions) is handled by subclasses.
 */

import type { EventScope, GameAction, GameEvent, GameRuntime, PendingAction, SeatId } from '@cat-cafe/shared';

type PartialEvent = Omit<GameEvent, 'eventId' | 'timestamp'>;

export class GameEngine {
  private runtime: GameRuntime;
  private eventCounter: number;

  constructor(runtime: GameRuntime) {
    this.runtime = runtime;
    this.eventCounter = runtime.eventLog.length;
  }

  getRuntime(): GameRuntime {
    return this.runtime;
  }

  /** Append an event to the log with auto-incrementing eventId */
  appendEvent(partial: PartialEvent): GameEvent {
    this.eventCounter++;
    const event: GameEvent = {
      ...partial,
      eventId: `evt-${this.eventCounter}`,
      timestamp: Date.now(),
    };
    this.runtime.eventLog.push(event);
    this.runtime.version++;
    this.runtime.updatedAt = Date.now();
    return event;
  }

  /** Get events visible to a specific viewer */
  getVisibleEvents(viewer: SeatId | 'god'): GameEvent[] {
    if (viewer === 'god') {
      return [...this.runtime.eventLog];
    }

    const seat = this.runtime.seats.find((s) => s.seatId === viewer);
    if (!seat) return this.runtime.eventLog.filter((e) => e.scope === 'public');

    // Dead players only see public + own seat-scoped events (no faction leak)
    const faction =
      seat.alive && seat.role ? this.runtime.definition.roles.find((r) => r.name === seat.role)?.faction : undefined;

    return this.runtime.eventLog.filter((e) => this.isEventVisible(e.scope, viewer, faction));
  }

  /** Submit a player action with validation */
  submitAction(seatId: string, action: GameAction): void {
    const seat = this.runtime.seats.find((s) => s.seatId === seatId);
    if (!seat) throw new Error(`Seat ${seatId} not found`);
    if (!seat.alive) throw new Error(`Seat ${seatId} is not alive`);

    // Find the action definition
    const actionDef = this.runtime.definition.actions.find((a) => a.name === action.actionName);
    if (!actionDef) throw new Error(`Action ${action.actionName} not defined`);

    // Check phase
    if (actionDef.allowedPhase !== this.runtime.currentPhase) {
      throw new Error(`Action ${action.actionName} not allowed in phase ${this.runtime.currentPhase}`);
    }

    // Check role (wildcard '*' = any alive player)
    if (actionDef.allowedRole !== '*' && seat.role !== actionDef.allowedRole) {
      throw new Error(`Action ${action.actionName} not allowed for role ${seat.role}`);
    }

    const pending: PendingAction = {
      ...action,
      status: 'waiting',
      requestedAt: Date.now(),
    };
    this.runtime.pendingActions[seatId] = pending;
    this.runtime.version++;
    this.runtime.updatedAt = Date.now();
  }

  /** Check if all expected actions for current phase have been collected */
  allActionsCollected(): boolean {
    const phase = this.runtime.definition.phases.find((p) => p.name === this.runtime.currentPhase);
    if (!phase) return true;

    const expectedSeats = this.getExpectedActors(phase.actingRole);
    return expectedSeats.every((seatId) => this.runtime.pendingActions[seatId] !== undefined);
  }

  /** Clear pending actions (call after phase resolution) */
  clearPendingActions(): void {
    this.runtime.pendingActions = {};
  }

  /** Check win condition. Override in subclass for game-specific logic. */
  checkWinCondition(): string | null {
    return null;
  }

  // --- Private helpers ---

  private getExpectedActors(actingRole?: string): string[] {
    if (!actingRole || actingRole === '*') {
      // All alive players
      return this.runtime.seats.filter((s) => s.alive).map((s) => s.seatId);
    }
    // Only seats with matching role
    return this.runtime.seats.filter((s) => s.alive && s.role === actingRole).map((s) => s.seatId);
  }

  private isEventVisible(scope: EventScope, viewer: SeatId, viewerFaction?: string): boolean {
    if (scope === 'public') return true;
    if (scope === 'god') return false; // god-only events invisible to players
    if (scope === 'judge') return false;
    if (scope === `seat:${viewer}`) return true;
    if (viewerFaction && scope === `faction:${viewerFaction}`) return true;
    return false;
  }
}
