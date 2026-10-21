import type { UnixProcessIdentity } from '../../utils/cli-process-ownership.js';
import type { DurableGatePowerEvidenceSource } from '../ball-custody/durable-managed-gate-power-evidence.js';
import type { ManagedCommandTerminalResult } from '../ball-custody/managed-command-wake-task-projection.js';
import type { DurableGateRecord } from './durable-managed-gate-job-store.js';
export interface ManagedJobSource {
  readonly originInvocationId?: string;
  readonly originScheduleId?: string;
}

export interface ManagedJobSubmission extends ManagedJobSource {
  readonly command: string;
  readonly cwd?: string;
  readonly originTaskId: string;
  readonly consumer?: AlphaRevisionConsumer;
  readonly idempotencyKey: string;
  readonly retryOfJobId?: string;
  readonly executionSlaMs: number;
  readonly wakeTarget: DurableManagedGateJob['wakeTarget'];
}

export type ManagedJobAccess =
  | ManagedJobPrincipal
  | { readonly kind: 'operator'; readonly userId: string; readonly threadId: string };

export interface DurableManagedGateRecoveryConfig {
  readonly protocolVersion: 2;
  readonly eventLoopGapMs: number;
  readonly reconciliationBudgetMs: number;
  readonly pollMs: number;
  readonly powerEvidenceSource: DurableGatePowerEvidenceSource;
}

export interface AlphaRevisionConsumer {
  readonly kind: 'alpha_revision_v1';
  readonly subscriptionId: string;
  readonly s3JobId: string;
  readonly headSha: string;
  readonly baseSha: string;
}

export interface DurableManagedGateJob {
  readonly kind: 'command' | 'full_gate' | 'resumable_full_gate_v2' | 'alpha_revision_v1';
  readonly consumer?: AlphaRevisionConsumer;
  /** Legacy gate files remain readable. New Action Plane jobs use the existing lease database. */
  readonly recordStorage?: 'sqlite_v1';
  readonly definition?: ManagedJobDefinition;
  readonly jobId: string;
  readonly originTaskId: string;
  readonly supervisorEpoch: string;
  readonly recordPath: string;
  readonly gateReceiptPath: string;
  readonly logPath: string;
  readonly executionSlaMs: number;
  readonly wallSlaMs: number;
  readonly wakeTarget: { readonly threadId: string; readonly catId: string; readonly userId: string };
  readonly recovery?: DurableManagedGateRecoveryConfig;
  readonly processIdentity?: UnixProcessIdentity;
}

export interface ManagedJobPrincipal {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
}

export interface ManagedJobDefinition {
  readonly principal: ManagedJobPrincipal;
  readonly originInvocationId?: string;
  readonly originScheduleId?: string;
  readonly command: string;
  readonly cwd: string;
  readonly idempotencyKey: string;
  readonly retryOfJobId?: string;
  readonly retryEpoch?: number;
  /** Side effects are never replayed automatically following a lost worker. */
  readonly retryPolicy: 'never';
  readonly maxConcurrent: number;
}

export type DurableGateInspection =
  | { state: 'adopted' | 'pending'; record?: DurableGateRecord }
  | { state: 'terminal' | 'lost'; record?: DurableGateRecord; result: ManagedCommandTerminalResult };

export type DurableGateCancellationOutcome =
  | { state: 'pending'; admitted: true }
  | { state: 'cancelled'; admitted: true; result: ManagedCommandTerminalResult }
  | { state: 'already_terminal'; admitted: false; result: ManagedCommandTerminalResult }
  | { state: 'rejected'; admitted: false };
