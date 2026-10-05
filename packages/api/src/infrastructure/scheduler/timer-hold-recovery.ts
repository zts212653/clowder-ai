import type { OwnerAuthProvenance } from '../../domains/cats/services/owner-auth-provenance.js';
import type { DynamicTaskDef, DynamicTaskStore } from './DynamicTaskStore.js';

type TimerHoldRecovery =
  | { readonly kind: 'not_timer_hold' }
  | { readonly kind: 'inactive'; readonly status: string }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'expired'; readonly slaUntilMs: number }
  | { readonly kind: 'recover'; readonly retryUntil: number; readonly scheduledAt: number };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function classifyTimerHoldRecovery(
  def: DynamicTaskDef,
  ownerAuthProvenance: OwnerAuthProvenance,
  now = Date.now(),
): TimerHoldRecovery {
  if (!def.id.startsWith('hold-ball-') || def.templateId !== 'reminder' || !def.createdBy.startsWith('hold-ball:')) {
    return { kind: 'not_timer_hold' };
  }
  const lifecycle = record(def.params.holdLifecycle);
  if (lifecycle?.mode !== 'timer') return { kind: 'not_timer_hold' };
  if (lifecycle.status !== 'active') {
    return { kind: 'inactive', status: typeof lifecycle.status === 'string' ? lifecycle.status : 'unknown' };
  }
  if (ownerAuthProvenance === 'unknown') return { kind: 'invalid', reason: 'owner_auth_unknown' };
  if (def.trigger.type !== 'once') return { kind: 'invalid', reason: 'trigger_not_once' };
  const wakeAt = lifecycle.wakeAt;
  const waitSourceRef = record(lifecycle.waitSourceRef);
  const slaUntilMs = waitSourceRef?.slaUntilMs;
  const active = record(lifecycle.await);
  const baseline = record(active?.baseline);
  const continuation = record(active?.continuation);
  const predicates = Array.isArray(continuation?.when) ? continuation.when : [];
  const predicate = record(predicates[0]);
  if (
    typeof wakeAt !== 'number' ||
    def.trigger.fireAt < wakeAt ||
    typeof slaUntilMs !== 'number' ||
    !Number.isFinite(slaUntilMs) ||
    active?.subjectRef !== `timer:${def.id}` ||
    active?.generation !== 1 ||
    (active?.autoRenew !== undefined && active.autoRenew !== false) ||
    active?.expiresAt !== slaUntilMs ||
    baseline?.kind !== 'timer' ||
    baseline.fireAt !== wakeAt ||
    predicates.length !== 1 ||
    predicate?.kind !== 'timer_elapsed'
  ) {
    return { kind: 'invalid', reason: 'timer_wait_identity_mismatch' };
  }
  return now > slaUntilMs
    ? { kind: 'expired', slaUntilMs }
    : { kind: 'recover', retryUntil: slaUntilMs, scheduledAt: wakeAt };
}

export function persistTimerHoldDisposition(
  store: DynamicTaskStore,
  def: DynamicTaskDef,
  input: {
    readonly status: 'fired' | 'retired_expired' | 'retired_invalid';
    readonly at: number;
    readonly reason?: string;
  },
): boolean {
  const lifecycle = record(def.params.holdLifecycle);
  if (!lifecycle) return false;
  const scheduledAt = typeof lifecycle.wakeAt === 'number' ? lifecycle.wakeAt : input.at;
  const nextParams = {
    ...def.params,
    holdLifecycle: {
      ...lifecycle,
      status: input.status,
      ...(input.status === 'fired'
        ? {
            firedAt: input.at,
            scheduledAt,
            latenessMs: Math.max(0, input.at - scheduledAt),
          }
        : { retiredAt: input.at, ...(input.reason ? { dispositionReason: input.reason } : {}) }),
    },
  };
  if (!store.updateParamsIfCurrent(def.id, def.params, nextParams)) return false;
  return store.setEnabled(def.id, false);
}
