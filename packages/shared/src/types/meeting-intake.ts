import type { MeetingIntakeJudgmentField } from './signal-ingress.js';

export type MeetingIntakeSourceState = 'ready' | 'not_ready' | 'auth_required' | 'deleted';
export type MeetingIntakeJudgmentState = 'unresolved' | 'confirmed' | 'auto_resolved' | 'dismissed';
export type MeetingIntakeExecutionState = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';
export type MeetingIntakeHealthState = 'healthy' | 'degraded';
export type MeetingIntakeRepairAction = 'retry' | 'regrant' | 'manual_import';
export type MeetingIntakeOutput = 'minutes' | 'decisions' | 'roadmap' | 'tasks';

export interface MeetingIntakeRepair {
  readonly code: 'transcript_not_ready' | 'auth_required' | 'source_deleted' | 'route_unavailable' | 'execution_failed';
  readonly action: MeetingIntakeRepairAction;
  readonly observedAt: number;
  readonly safeDetail?: string;
}

export interface MeetingIntakeChoices {
  readonly speakerMap?: Readonly<Record<string, string>>;
  readonly context?: string;
  readonly destinationHandle?: string;
  readonly outputs?: readonly MeetingIntakeOutput[];
}

export interface MeetingIntakeSignalOrigin {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly contractVersion: string;
  readonly signalType: string;
  readonly declaration: {
    readonly epistemicStatus: 'observation' | 'inference';
    readonly privacyClass: 'behavioral' | 'content-adjacent' | 'content';
    readonly sourceClass: 'os-metadata' | 'accessibility-api' | 'remote-service';
  };
}

export interface MeetingIntakeIngress {
  readonly publicationId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly canonicalDigest: string;
  readonly firstDeliveredAt: number;
}

/** Bounded Host projection over source-owned bytes. It is never the transcript authority. */
export interface MeetingArtifactDescriptor {
  readonly contentType: 'text/plain';
  readonly resourceRef: string;
  readonly sourceHandle: string;
  readonly sourceRevision: `sha256:${string}`;
  readonly byteLength: number;
  readonly trust: 'untrusted_external';
  readonly instructionPolicy: 'data_only';
}

/** Durable, source-ref-only workflow truth. Transcript bytes never belong here. */
export interface MeetingIntake {
  readonly intakeId: string;
  readonly ownerId: string;
  readonly routeId: string;
  readonly routeGeneration: number;
  readonly origin: MeetingIntakeSignalOrigin;
  readonly source: { readonly handle: string };
  readonly occurredAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly ingress: MeetingIntakeIngress;
  readonly sourceState: MeetingIntakeSourceState;
  readonly judgmentState: MeetingIntakeJudgmentState;
  readonly executionState: MeetingIntakeExecutionState;
  readonly healthState: MeetingIntakeHealthState;
  readonly unresolved: readonly MeetingIntakeJudgmentField[];
  readonly choices: MeetingIntakeChoices;
  readonly artifact?: MeetingArtifactDescriptor;
  readonly repair?: MeetingIntakeRepair;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function meetingIntakeNeedsAttention(intake: MeetingIntake): boolean {
  return intake.judgmentState === 'unresolved' || intake.healthState === 'degraded';
}
