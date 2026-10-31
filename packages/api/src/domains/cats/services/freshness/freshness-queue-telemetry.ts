import { freshnessQueuedHandled, freshnessQueuedSeen } from '../../../../infrastructure/telemetry/instruments.js';

export interface FreshnessQueueTelemetrySnapshot {
  queuedSeenTotal: number;
  queuedHandledTotal: number;
  queuedHandledFullyConsumedTotal: number;
}

let queuedSeenTotal = 0;
let queuedHandledTotal = 0;
let queuedHandledFullyConsumedTotal = 0;

export function recordQueuedSeenTelemetry(): void {
  queuedSeenTotal += 1;
  freshnessQueuedSeen.add(1);
}

export function recordQueuedHandledTelemetry(input: { fullyConsumed?: boolean } = {}): void {
  queuedHandledTotal += 1;
  if (input.fullyConsumed) queuedHandledFullyConsumedTotal += 1;
  freshnessQueuedHandled.add(1);
}

export function getFreshnessQueueTelemetrySnapshot(): FreshnessQueueTelemetrySnapshot {
  return {
    queuedSeenTotal,
    queuedHandledTotal,
    queuedHandledFullyConsumedTotal,
  };
}

export function resetFreshnessQueueTelemetryForTest(): void {
  queuedSeenTotal = 0;
  queuedHandledTotal = 0;
  queuedHandledFullyConsumedTotal = 0;
}
