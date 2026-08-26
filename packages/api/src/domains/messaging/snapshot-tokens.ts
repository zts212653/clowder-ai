/** Opaque snapshot-page entitlements and final snapshot acknowledgements. */

import { MessagingError } from './contract/host-types.js';
import type { SnapshotViewRecord } from './stores/ports.js';

interface SnapshotAckTokenPayload {
  readonly s: string;
  readonly q: number;
  readonly n: string;
  readonly k: 'snapshot';
}

export interface SnapshotPageTokenPayload {
  readonly s: string;
  readonly v: string;
  readonly o: number;
  readonly n: string;
}

export function encodeSnapshotAckToken(subscriptionId: string, snapshot: SnapshotViewRecord): string {
  const payload: SnapshotAckTokenPayload = {
    s: subscriptionId,
    q: snapshot.headSequence,
    n: snapshot.snapshotId,
    k: 'snapshot',
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function encodeSnapshotPageToken(
  subscriptionId: string,
  snapshotId: string,
  offset: number,
  tokenId: string,
): string {
  const payload: SnapshotPageTokenPayload = { s: subscriptionId, v: snapshotId, o: offset, n: tokenId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeSnapshotPageToken(token: string): SnapshotPageTokenPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new MessagingError('VALIDATION', 'malformed snapshot page token');
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof value.s !== 'string' ||
    typeof value.v !== 'string' ||
    typeof value.n !== 'string' ||
    !Number.isSafeInteger(value.o) ||
    (value.o as number) < 0
  ) {
    throw new MessagingError('VALIDATION', 'malformed snapshot page token');
  }
  return parsed as SnapshotPageTokenPayload;
}
