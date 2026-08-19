/** F295 canonical read projection shared by API and every running-work UI surface. */

export type ActiveExecutionKind = 'live_invocation' | 'managed_command';

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
  readonly threadId: string;
  readonly threadTitle: string | null;
  readonly catId: string;
  readonly kind: ActiveExecutionKind;
  readonly startedAt: number;
  readonly cancelability: ActiveExecutionCancelability;
}

export interface ActiveExecutionListResponse {
  readonly projectPath: string;
  readonly executions: ActiveExecutionProjection[];
}
