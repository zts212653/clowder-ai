/** Target reply truth is independent of the execution backend and transport acknowledgement. */
export type TargetResponseStatus =
  | 'delivering'
  | 'waiting'
  | 'processing'
  | 'unconfirmed'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export interface TargetResponseRecord {
  readonly v: 1;
  readonly revision: number;
  readonly inputMessageId: string;
  readonly targetId: string;
  readonly execution: { readonly kind: 'plugin'; readonly id: string };
  readonly status: TargetResponseStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly resultMessageId?: string;
}

export interface TargetResponseResult {
  readonly carrierMessageId: string;
  readonly deliveryId: string;
  readonly status: 'processing' | 'completed' | 'failed' | 'canceled' | 'interrupted';
}

export function isTargetResponseTerminal(status: TargetResponseStatus): boolean {
  return ['completed', 'failed', 'canceled', 'interrupted'].includes(status);
}

export function isTargetResponseRecord(value: unknown): value is TargetResponseRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as TargetResponseRecord;
  return (
    r.v === 1 &&
    Number.isSafeInteger(r.revision) &&
    r.revision > 0 &&
    typeof r.inputMessageId === 'string' &&
    r.inputMessageId.length > 0 &&
    typeof r.targetId === 'string' &&
    r.targetId.length > 0 &&
    r.execution?.kind === 'plugin' &&
    typeof r.execution.id === 'string' &&
    r.execution.id.length > 0 &&
    ['delivering', 'waiting', 'processing', 'unconfirmed', 'completed', 'failed', 'canceled', 'interrupted'].includes(
      r.status,
    ) &&
    Number.isFinite(r.startedAt) &&
    Number.isFinite(r.updatedAt) &&
    (r.resultMessageId === undefined || typeof r.resultMessageId === 'string')
  );
}
