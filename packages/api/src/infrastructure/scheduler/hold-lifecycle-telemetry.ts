import { trace } from '@opentelemetry/api';
import { AGENT_ID, THREAD_SYSTEM_KIND, TRIGGER } from '../telemetry/genai-semconv.js';
import { hmacId } from '../telemetry/hmac.js';
import { holdExpiredAfterSatisfiedTotal } from '../telemetry/instruments.js';
import type { DynamicTaskDef } from './DynamicTaskStore.js';

export const HOLD_EXPIRED_AFTER_SATISFIED_EVENT_NAME = 'hold_lifecycle.expired_after_satisfied_fired';
export const HOLD_EXPIRED_AFTER_SATISFIED_SAMPLE_SPAN = 'cat_cafe.a2a.hold_lifecycle.expired_after_satisfied_sample';
export const HOLD_EXPIRED_AFTER_SATISFIED_TRIGGER = 'timer_expired_after_event';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function firstString(values: ReadonlyArray<unknown>, fallback = ''): string {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized !== null) return normalized;
  }
  return fallback;
}

function readCatId(def: DynamicTaskDef): string {
  const prefix = 'hold-ball:';
  return def.createdBy.startsWith(prefix) ? def.createdBy.slice(prefix.length) : '';
}

export function emitHoldExpiredAfterSatisfied(def: DynamicTaskDef): void {
  const lifecycle = isPlainRecord(def.params.holdLifecycle) ? def.params.holdLifecycle : {};
  const resolvedBy = isPlainRecord(lifecycle.resolvedBy) ? lifecycle.resolvedBy : {};
  const catId = readCatId(def);
  const threadId = firstString([def.deliveryThreadId]);
  const subjectKey = firstString([lifecycle.subjectKey, resolvedBy.subjectKey]);
  const expectedSignalKey = firstString([lifecycle.expectedSignalKey, resolvedBy.expectedSignalKey]);
  const sourceKind = firstString([resolvedBy.sourceKind], 'unknown');
  const labels = {
    [AGENT_ID]: catId,
    [THREAD_SYSTEM_KIND]: 'unknown',
    [TRIGGER]: HOLD_EXPIRED_AFTER_SATISFIED_TRIGGER,
  };

  try {
    const subjectKeyHash = subjectKey.length > 0 ? hmacId(subjectKey) : '';
    holdExpiredAfterSatisfiedTotal.add(1, labels);
    const sampleSpan = trace.getTracer('cat-cafe-api', '0.1.0').startSpan(HOLD_EXPIRED_AFTER_SATISFIED_SAMPLE_SPAN);
    sampleSpan.addEvent(HOLD_EXPIRED_AFTER_SATISFIED_EVENT_NAME, {
      messageId: def.id,
      invocationId: '',
      threadId,
      [AGENT_ID]: catId,
      [THREAD_SYSTEM_KIND]: 'unknown',
      [TRIGGER]: HOLD_EXPIRED_AFTER_SATISFIED_TRIGGER,
      taskIdHash: hmacId(def.id),
      subjectKeyHash,
      expectedSignalKey,
      sourceKind,
    });
    sampleSpan.end();
  } catch {
    /* best-effort sample emission */
  }
}
