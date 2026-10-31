import { createHash } from 'node:crypto';
import type { PawFeelDispositionEvent } from '@cat-cafe/shared';

// Keep replay identity pure so recovery can be verified without a writer or runtime state.

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(tag: string, value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([tag, canonicalize(value)]))
    .digest('hex');
}

export function digestLegacyPawFeelBlockerEvent(event: PawFeelDispositionEvent): string {
  return digest('paw-feel-blocker-event:v1', event);
}

export function deriveLegacyPawFeelBlockerReopenEventId(input: {
  signalId: string;
  blockingSequence: number;
  blockerEventDigest: string;
  manifestDigest: string;
}): string {
  return `paw-feel-legacy-reopen:v1:${digest('paw-feel-legacy-reopen:v1', [
    input.signalId,
    input.blockingSequence,
    input.blockerEventDigest,
    input.manifestDigest,
  ])}`;
}
