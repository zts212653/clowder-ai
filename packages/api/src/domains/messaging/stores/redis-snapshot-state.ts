/** Serialization boundary for active and replayable completed snapshot state. */

import type { SnapshotViewRecord, SubscriptionRecord } from './ports.js';

export type StoredSnapshotState =
  | ({ readonly status: 'active' } & SnapshotViewRecord)
  | { readonly status: 'completed'; readonly snapshotId: string; readonly headSequence: number };

export function snapshotView(state: StoredSnapshotState & { readonly status: 'active' }): SnapshotViewRecord {
  const { status: _status, ...view } = state;
  return view;
}

export function snapshotCompletion(
  state: StoredSnapshotState & { readonly status: 'completed' },
): SubscriptionRecord['lastSnapshotCompletion'] {
  const { status: _status, ...completion } = state;
  return completion;
}
