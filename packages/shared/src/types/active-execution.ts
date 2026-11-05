/** F295 canonical read projection shared by API and every running-work UI surface. */

import type { LifecycleInputCapabilities } from './message-lifecycle.js';

export type ActiveExecutionKind = 'live_invocation' | 'managed_command';
export type ManagedCommandActivity = 'full_gate' | 'test' | 'build' | 'lint' | 'check' | 'command';

export interface LiveInvocationCancelTarget {
  readonly kind: 'live_invocation';
  readonly threadId: string;
  readonly catId: string;
  readonly executionId: string;
}

export interface ManagedCommandCancelTarget {
  readonly kind: 'managed_command';
  readonly taskId: string;
}

export type ActiveExecutionCancelTarget = LiveInvocationCancelTarget | ManagedCommandCancelTarget;

export type ActiveExecutionNonCancelableReason =
  | 'control_plane_unavailable'
  | 'cancellation_pending'
  | 'terminalizing'
  /** Visible as occupancy, but started by another principal (e.g. the scheduler). */
  | 'foreign_principal';

export type ActiveExecutionCancelability =
  | { readonly state: 'cancelable'; readonly target: ActiveExecutionCancelTarget }
  | { readonly state: 'not_cancelable'; readonly reason: ActiveExecutionNonCancelableReason };

export interface ActiveExecutionProjection {
  readonly executionId: string;
  /** Canonical per-cat child for trajectory navigation; never substitute the parent/control identity. */
  readonly turnInvocationId?: string;
  readonly threadId: string;
  readonly threadTitle: string | null;
  /** Owning project from the readable thread; supplied by all-project snapshots. */
  readonly projectPath?: string;
  readonly catId: string;
  readonly kind: ActiveExecutionKind;
  /** Allowlisted category only; raw managed-command text never crosses this boundary. */
  readonly activity?: ManagedCommandActivity;
  readonly startedAt: number;
  readonly cancelability: ActiveExecutionCancelability;
  /** Exact live input affordances projected by the server; absence fails closed. */
  readonly inputCapabilities?: LifecycleInputCapabilities;
}

/**
 * A held ball: the cat's process has exited and a wake is armed. It is waiting, not running, so it never appears in
 * `executions` (whose consumers treat every entry as stoppable running work).
 */
export interface ActiveHoldWaitProjection {
  /** The hold task id when the viewer owns it; a masked, unresolvable occupancy id otherwise. */
  readonly waitId: string;
  readonly threadId: string;
  readonly threadTitle: string | null;
  /** Owning project from the readable thread; supplied by all-project snapshots. */
  readonly projectPath?: string;
  readonly catId: string;
  /** When the hold was registered. */
  readonly since: number;
  /** When the scheduler will wake the cat; a busy thread re-arms this later. */
  readonly wakeAt: number;
  readonly cancelability:
    | { readonly state: 'cancelable'; readonly target: { readonly kind: 'hold_ball'; readonly taskId: string } }
    | { readonly state: 'not_cancelable'; readonly reason: 'foreign_principal' };
}

export type ActiveExecutionListResponse =
  | {
      readonly scope?: 'project';
      readonly projectPath: string;
      readonly executions: ActiveExecutionProjection[];
      /** Absent from servers that predate hold projection; read as none. */
      readonly waits?: readonly ActiveHoldWaitProjection[];
    }
  | {
      readonly scope: 'all';
      readonly executions: ActiveExecutionProjection[];
      readonly waits?: readonly ActiveHoldWaitProjection[];
      readonly unavailableProjectPaths?: readonly string[];
    };
