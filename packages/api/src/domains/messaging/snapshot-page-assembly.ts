/** Encoded-result budgeting and deterministic frozen snapshot page assembly. */

import { randomUUID } from 'node:crypto';
import {
  type M0CSnapshotResult,
  MESSAGING_ROW_ENCODED_BYTE_BOUNDS,
  REQUEST_ID_MAX_LENGTH,
} from '@clowder-ai/plugin-contract';
import { SnapshotUnavailableHostError } from './contract/host-types.js';
import { encodeSnapshotAckToken, encodeSnapshotPageToken } from './snapshot-tokens.js';
import type { SnapshotViewRecord } from './stores/ports.js';

const MAX_WIRE_REQUEST_ID = 'r'.repeat(REQUEST_ID_MAX_LENGTH);

export function resultFits(method: 'messaging.read' | 'messaging.snapshot', result: unknown): boolean {
  const encodedBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: MAX_WIRE_REQUEST_ID, result }), 'utf8');
  return encodedBytes <= MESSAGING_ROW_ENCODED_BYTE_BOUNDS[method].maxEncodedResultBytes;
}

export interface SnapshotPageAssembly {
  readonly result: M0CSnapshotResult;
  readonly nextOffset: number;
  readonly nextPageTokenId?: string;
  readonly traversalComplete: boolean;
}

export function assembleSnapshotPage(
  subscriptionId: string,
  snapshot: SnapshotViewRecord,
  offset: number,
  availableItems: M0CSnapshotResult['items'],
): SnapshotPageAssembly {
  for (let count = availableItems.length; count >= 0; count -= 1) {
    if (count === 0 && offset < snapshot.itemCount) break;
    const items = availableItems.slice(0, count);
    const nextOffset = offset + count;
    const traversalComplete = nextOffset >= snapshot.itemCount;
    if (traversalComplete) {
      const result: M0CSnapshotResult = {
        items,
        nextPageToken: null,
        snapshotAckToken: encodeSnapshotAckToken(subscriptionId, snapshot),
      };
      if (resultFits('messaging.snapshot', result)) return { result, nextOffset, traversalComplete };
      continue;
    }
    const nextPageTokenId = randomUUID();
    const result: M0CSnapshotResult = {
      items,
      nextPageToken: encodeSnapshotPageToken(subscriptionId, snapshot.snapshotId, nextOffset, nextPageTokenId),
      snapshotAckToken: null,
    };
    if (resultFits('messaging.snapshot', result)) {
      return { result, nextOffset, nextPageTokenId, traversalComplete };
    }
  }
  throw new SnapshotUnavailableHostError('OVERSIZED_ITEM');
}
