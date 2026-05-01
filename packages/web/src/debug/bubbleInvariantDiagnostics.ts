import type { BubbleInvariantViolation } from '@cat-cafe/shared';
import { recordDebugEvent } from './invocationEventDebug';

export type BubbleInvariantLogLevel = 'warn' | 'error';

export function recordBubbleInvariantViolation(
  violation: BubbleInvariantViolation,
  level: BubbleInvariantLogLevel = 'warn',
): void {
  const payload = { ...violation, level };
  if (level === 'error') {
    console.error('[F183] bubble invariant violation', payload);
  } else {
    console.warn('[F183] bubble invariant violation', payload);
  }

  recordDebugEvent({
    event: 'bubble_invariant_violation',
    ...payload,
  });
}
