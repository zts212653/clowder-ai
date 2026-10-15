import type { AcpAgentRequest } from './types.js';

export type AcpPermissionDecision = { optionId: string } | { cancelled: true };
export type AcpPermissionHandler = (
  req: AcpAgentRequest,
  respond: (decision: AcpPermissionDecision) => void,
) => void | Promise<void>;
export type AcpPermissionOutcome = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } };
interface PermissionDelivery {
  resolveOutcome(): AcpPermissionOutcome;
}
const cancelled: AcpPermissionOutcome = { outcome: { outcome: 'cancelled' } };
/** Factory safety policy until W3.P connects an explicit platform approval owner. */
export const denyUnwiredAcpPermission: AcpPermissionHandler = (_request, respond) => respond({ cancelled: true });

/** Shared authority boundary; transport owns only delivery and connection retirement. */
export class AcpPermissionDispatcher {
  private closed = false;
  private readonly admitted = new Map<string, number>();
  private generation = 0;
  private readonly quarantined = new Set<string>();
  private readonly pending = new Map<string, { sessionId: string; cancel(): void }>();
  constructor(private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000)
      throw new RangeError('Invalid ACP permission timeout');
  }
  dispatch(
    request: AcpAgentRequest,
    handler?: AcpPermissionHandler,
    signal?: AbortSignal,
  ): Promise<PermissionDelivery> | null {
    const key = `${typeof request.id}:${request.id}`;
    if (this.closed || this.pending.has(key)) return null;
    const params = request.params;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    const generation = this.admitted.get(sessionId);
    const delivery = (result: AcpPermissionOutcome): PermissionDelivery => ({
      resolveOutcome: () =>
        result.outcome.outcome === 'selected' && this.admitted.get(sessionId) !== generation ? cancelled : result,
    });
    const options = params?.options;
    const ids = new Set<string>();
    let valid = !!sessionId && Array.isArray(options) && options.length > 0;
    if (Array.isArray(options))
      for (const option of options) {
        if (!option || typeof option !== 'object') {
          valid = false;
          continue;
        }
        const value = option as Record<string, unknown>;
        if (
          typeof value.optionId !== 'string' ||
          !value.optionId ||
          ids.has(value.optionId) ||
          typeof value.kind !== 'string' ||
          !['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(value.kind)
        )
          valid = false;
        else ids.add(value.optionId);
      }
    if (!handler || !valid || generation === undefined) return Promise.resolve(delivery(cancelled));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: AcpPermissionOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(key);
        resolve(delivery(outcome));
      };
      const timer = setTimeout(() => finish(cancelled), this.timeoutMs);
      const abort = () => finish(cancelled);
      this.pending.set(key, { sessionId, cancel: () => finish(cancelled) });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        finish(cancelled);
        return;
      }
      const respond = (decision: AcpPermissionDecision) => {
        if (!decision || typeof decision !== 'object' || !('optionId' in decision) || !ids.has(decision.optionId))
          finish(cancelled);
        else finish({ outcome: { outcome: 'selected', optionId: decision.optionId } });
      };
      try {
        Promise.resolve(handler(request, respond)).catch(() => finish(cancelled));
      } catch {
        finish(cancelled);
      }
    });
  }
  cancelSession(sessionId: string): void {
    this.quarantined.add(sessionId);
    this.settleSession(sessionId);
  }
  isQuarantined(sessionId: string): boolean {
    return this.quarantined.has(sessionId);
  }
  admitSession(sessionId: string): void {
    if (this.closed || this.quarantined.has(sessionId))
      throw new Error('ACP permission binding retired; acquire a fresh connection');
    if (this.admitted.has(sessionId)) throw new Error('ACP permission session already active');
    this.admitted.set(sessionId, ++this.generation);
  }
  settleSession(sessionId: string): void {
    this.admitted.delete(sessionId);
    for (const entry of this.pending.values()) if (entry.sessionId === sessionId) entry.cancel();
  }
  close(): void {
    this.closed = true;
    this.admitted.clear();
    for (const entry of this.pending.values()) entry.cancel();
  }
}
