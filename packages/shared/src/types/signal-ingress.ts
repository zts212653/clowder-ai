/** Host-owned authority attached to a plugin signal after transport decoding. */
export interface SignalRuntimeBinding {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly sessionId: string;
  readonly runtimeLeaseId: string;
  readonly grantRevision: number;
  readonly routeGeneration: number;
}

export type SignalRouteState = 'active' | 'suspended' | 'revoked';

/** A route is Host configuration. It is never accepted from plugin input. */
export interface SignalRouteRecord {
  readonly routeId: string;
  readonly ownerId: string;
  readonly pluginId: string;
  readonly signalType: string;
  readonly generation: number;
  readonly state: SignalRouteState;
  readonly workflowKind: 'meeting-intake';
  readonly initialUnresolved: readonly MeetingIntakeJudgmentField[];
  readonly updatedAt: number;
}

export type MeetingIntakeJudgmentField = 'speakers' | 'context' | 'destination' | 'outputs';
