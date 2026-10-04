export const DURABLE_MANAGED_GATE_CHILD_TERMINATION_GRACE_MS = 35_000;
export const MANAGED_GATE_ORIGIN_TASK_ENV = 'CAT_CAFE_GATE_ORIGIN_TASK_ID';
export const MANAGED_GATE_CANCEL_REQUEST_PATH_ENV = 'CAT_CAFE_MANAGED_CANCEL_REQUEST_PATH';
export const MANAGED_GATE_RECOVERY_PROTOCOL_ENV = 'CAT_CAFE_MANAGED_GATE_RECOVERY_PROTOCOL';

interface DurableManagedGateChildBinding {
  readonly originTaskId: string;
  readonly recordPath: string;
  readonly recovery?: { readonly protocolVersion: 2 };
}

export function durableManagedGateChildEnvironment(job: DurableManagedGateChildBinding): Record<string, string> {
  return {
    [MANAGED_GATE_ORIGIN_TASK_ENV]: job.originTaskId,
    [MANAGED_GATE_CANCEL_REQUEST_PATH_ENV]: `${job.recordPath}.cancel-request`,
    ...(job.recovery?.protocolVersion === 2 ? { [MANAGED_GATE_RECOVERY_PROTOCOL_ENV]: '2' } : {}),
  };
}
