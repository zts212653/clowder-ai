import type { LiveContextScope } from '../live/host/live-controlled-context.js';

/** Recent duplicate suppression complements Host's latest-input fence; it is not a lifetime quota. */
export class LiveMeetingRequestHistory {
  private readonly entries = new Map<string, string>();

  private key(scope: LiveContextScope, messageId: string) {
    return JSON.stringify([scope.callId, scope.generation, messageId]);
  }

  has(scope: LiveContextScope, messageId: string): boolean {
    return this.entries.has(this.key(scope, messageId));
  }

  remember(scope: LiveContextScope, messageId: string): void {
    this.entries.set(this.key(scope, messageId), scope.callId);
    if (this.entries.size > 64) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  release(callId: string): void {
    for (const [key, call] of this.entries) if (call === callId) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
