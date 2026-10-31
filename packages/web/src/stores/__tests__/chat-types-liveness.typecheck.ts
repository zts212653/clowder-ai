import type { CatInvocationInfo, CatStatusType, LivenessWarningSnapshot } from '../chat-types';

// Compiled by the existing Web tsconfig / formal gate tsc stage, not executed by Vitest.
export const silent: CatStatusType = 'alive_but_silent';
export const stalled: CatStatusType = 'suspected_stall';
export const warning: LivenessWarningSnapshot = {
  level: 'alive_but_silent',
  state: 'busy-silent',
  silenceDurationMs: 125000,
  cpuTimeMs: 4200,
  processAlive: true,
  receivedAt: 1,
};
export const invocation: CatInvocationInfo = {
  livenessWarning: { ...warning, level: 'suspected_stall', state: 'idle-silent', silenceDurationMs: 300000 },
};

// @ts-expect-error a made-up status must not enter the liveness state machine
export const invalidStatus: CatStatusType = 'unknown-liveness-state';
// @ts-expect-error timestamps in a liveness snapshot are numeric
export const invalidTimestamp: LivenessWarningSnapshot = { ...warning, receivedAt: 'yesterday' };
