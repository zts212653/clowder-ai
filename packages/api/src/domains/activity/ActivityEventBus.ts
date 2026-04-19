/**
 * Activity Event Spine (ADR-023)
 *
 * In-process typed event bus. Routes/hooks emit ActivityEvents here;
 * projectors (Journey, Leaderboard, Memory) subscribe and interpret.
 *
 * Phase 1: EventEmitter, no persistence.
 * Phase 2: Optional event log for replay/recomputation.
 */

import { EventEmitter } from 'node:events';
import type { ActivityEvent, ActivityEventType } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';

const log = createModuleLogger('activity-bus');

type ActivityListener = (event: ActivityEvent) => void;

export class ActivityEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(20);
  }

  /** Emit an activity event. Fire-and-forget — errors in listeners are caught and logged. */
  emit(event: ActivityEvent): void {
    try {
      this.emitter.emit('activity', event);
    } catch (err: unknown) {
      log.warn({ err, type: event.type, actorId: event.actorId }, 'ActivityEventBus emit error');
    }
  }

  /** Convenience: build and emit in one call. */
  record(type: ActivityEventType, actorId: string, metadata: Record<string, unknown> = {}, threadId?: string): void {
    this.emit({ type, actorId, timestamp: new Date().toISOString(), threadId, metadata });
  }

  /** Subscribe to all activity events. */
  on(listener: ActivityListener): void {
    this.emitter.on('activity', listener);
  }

  /** Unsubscribe. */
  off(listener: ActivityListener): void {
    this.emitter.off('activity', listener);
  }

  /** Number of registered listeners (for diagnostics). */
  get listenerCount(): number {
    return this.emitter.listenerCount('activity');
  }
}
