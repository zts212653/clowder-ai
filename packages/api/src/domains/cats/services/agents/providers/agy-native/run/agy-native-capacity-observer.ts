import type { ObservedContextWindow } from '../../../../types.js';
import type { AgyStreamJsonEvent } from '../../agy-stream-json-parser.js';
import { type AgyCapacityScope, readAgyObservedWindow, recordAgyObservedWindow } from './agy-native-capacity-store.js';

/** Operational ceiling inferred from completed automatic checkpoints, never a native configuration. */
export class AgyNativeCapacityObserver {
  private readonly checkpoints = new Map<number, ObservedContextWindow>();
  private observation: ObservedContextWindow | undefined;

  constructor(
    private readonly scope: AgyCapacityScope,
    private readonly sessionId: string,
  ) {
    this.observation = readAgyObservedWindow(scope);
  }

  get current(): ObservedContextWindow | undefined {
    return this.observation;
  }

  step(event: Extract<AgyStreamJsonEvent, { kind: 'step' }>, automatic: boolean): void {
    if (event.stepType !== 'checkpoint' || event.conversationId !== this.sessionId || event.stepIndex < 0) return;
    // A later sparse state change invalidates the same sample, rather than retaining stale DONE evidence.
    this.checkpoints.delete(event.stepIndex);
    const usage = event.usage;
    if (!automatic || event.state !== 'DONE' || event.anomalies.length || !usage) return;
    if (![usage.inputTokens, usage.cacheReadTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) return;
    const windowTokens = usage.inputTokens + usage.cacheReadTokens;
    if (!Number.isSafeInteger(windowTokens) || windowTokens <= 16000) return;
    this.checkpoints.set(event.stepIndex, {
      provider: 'google',
      carrier: 'agy_stream_json',
      model: this.scope.model,
      cliVersion: this.scope.cliVersion,
      scopeId: this.scope.scopeId,
      windowTokens,
      observedAt: Date.now(),
      evidenceRef: `agy_native_checkpoint:${this.sessionId}:${event.stepIndex}`,
    });
  }

  commit(successful: boolean): ObservedContextWindow | undefined {
    try {
      if (successful) {
        for (const observation of this.checkpoints.values()) {
          this.observation = recordAgyObservedWindow(this.scope, observation);
        }
      }
    } finally {
      this.checkpoints.clear();
    }
    return this.observation;
  }
}
