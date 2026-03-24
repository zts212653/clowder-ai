import { EventEmitter } from 'node:events';
import type { SeatId } from '@cat-cafe/shared';
import type { ActionNotifier } from './GameNarratorDriver.js';

/**
 * Concrete ActionNotifier using Node.js EventEmitter.
 * Bridges the submit_game_action route and GameNarratorDriver:
 *  - Route calls onActionReceived() after successful handlePlayerAction()
 *  - Driver calls waitForAction/waitForAllActions() to block until actions arrive
 *
 * Single instance shared between the route and the driver.
 */
export class EventEmitterActionNotifier implements ActionNotifier {
  private emitter = new EventEmitter();

  constructor() {
    // Allow many listeners — one per seat in concurrent waits
    this.emitter.setMaxListeners(50);
  }

  onActionReceived(gameId: string, seatId: SeatId): void {
    this.emitter.emit(this.eventKey(gameId, seatId));
  }

  waitForAction(gameId: string, seatId: SeatId, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const key = this.eventKey(gameId, seatId);
      let settled = false;

      const onAction = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.emitter.removeListener(key, onAction);
        resolve(false);
      }, timeoutMs);

      this.emitter.once(key, onAction);
    });
  }

  async waitForAllActions(gameId: string, seatIds: SeatId[], timeoutMs: number): Promise<void> {
    await Promise.all(seatIds.map((sid) => this.waitForAction(gameId, sid, timeoutMs)));
  }

  cleanup(gameId: string): void {
    for (let i = 1; i <= 20; i++) {
      this.emitter.emit(this.eventKey(gameId, `P${i}` as SeatId));
    }
  }

  private eventKey(gameId: string, seatId: SeatId): string {
    return `action:${gameId}:${seatId}`;
  }
}
