import { createHash } from 'node:crypto';
import type { BallCustodyEvent } from '@cat-cafe/shared';

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, ordered(child)]),
  );
}
export function ballEventFingerprint(event: BallCustodyEvent): string {
  return createHash('sha256')
    .update(JSON.stringify(ordered(event)))
    .digest('hex');
}
