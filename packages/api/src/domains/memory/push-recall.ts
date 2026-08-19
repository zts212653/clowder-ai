import { createHash } from 'node:crypto';
import type { PushRecallSurface } from './f200-types.js';

export function asPushRecallSurface(value: unknown): PushRecallSurface | undefined {
  return value === 'session_bootstrap' || value === 'cold_context' ? value : undefined;
}

export function deterministicPushRecallId(input: {
  invocationId: string;
  catId: string;
  timestamp: number;
  surface: PushRecallSurface;
}): string {
  return `push-${createHash('sha256')
    .update(`${input.invocationId}\0${input.catId}\0${input.surface}\0${input.timestamp}`)
    .digest('hex')}`;
}
