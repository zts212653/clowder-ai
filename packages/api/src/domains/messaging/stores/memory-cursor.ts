/** In-memory subscription cursor and frozen snapshot state. */

import type { MessageEnvelope } from '@clowder-ai/plugin-contract';
import type {
  CursorStore,
  SnapshotCaptureCandidate,
  SnapshotCaptureCommit,
  SnapshotCaptureStart,
  SnapshotViewRecord,
  SubscriptionRecord,
} from './ports.js';

interface MemorySnapshotCapture extends SnapshotCaptureCandidate {
  readonly itemCount: number;
}

export class MemoryCursorStore implements CursorStore {
  private readonly subs = new Map<string, SubscriptionRecord>();
  private readonly subscriptionByHandle = new Map<string, string>();
  private readonly snapshotItems = new Map<string, readonly MessageEnvelope[]>();
  private readonly snapshotCaptures = new Map<string, MemorySnapshotCapture>();
  private readonly snapshotCaptureItems = new Map<string, readonly MessageEnvelope[]>();

  private static key(pluginInstanceId: string, subscriptionId: string): string {
    return `${encodeURIComponent(pluginInstanceId)}:${encodeURIComponent(subscriptionId)}`;
  }

  private static handleKey(pluginInstanceId: string, handleId: string): string {
    return `${encodeURIComponent(pluginInstanceId)}:${encodeURIComponent(handleId)}`;
  }

  async put(record: SubscriptionRecord): Promise<void> {
    this.subs.set(MemoryCursorStore.key(record.pluginInstanceId, record.subscriptionId), record);
    this.subscriptionByHandle.set(
      MemoryCursorStore.handleKey(record.pluginInstanceId, record.handleId),
      record.subscriptionId,
    );
  }

  async get(pluginInstanceId: string, subscriptionId: string): Promise<SubscriptionRecord | null> {
    return this.subs.get(MemoryCursorStore.key(pluginInstanceId, subscriptionId)) ?? null;
  }

  async findByHandle(pluginInstanceId: string, handleId: string): Promise<SubscriptionRecord | null> {
    const subscriptionId = this.subscriptionByHandle.get(MemoryCursorStore.handleKey(pluginInstanceId, handleId));
    if (!subscriptionId) return null;
    const record = this.subs.get(MemoryCursorStore.key(pluginInstanceId, subscriptionId));
    return record && record.revokedAt === undefined ? record : null;
  }

  async createOrGet(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    // Deliberately no await: this check+write block is atomic in one JS turn.
    const handleKey = MemoryCursorStore.handleKey(record.pluginInstanceId, record.handleId);
    const existingId = this.subscriptionByHandle.get(handleKey);
    if (existingId) {
      const existing = this.subs.get(MemoryCursorStore.key(record.pluginInstanceId, existingId));
      if (existing && existing.revokedAt === undefined) return existing;
    }
    this.subs.set(MemoryCursorStore.key(record.pluginInstanceId, record.subscriptionId), record);
    this.subscriptionByHandle.set(handleKey, record.subscriptionId);
    return record;
  }

  async advanceAck(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (record && sequence > record.ackedSequence) {
      this.subs.set(key, { ...record, ackedSequence: sequence });
    }
  }

  async advanceDelivered(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (record && sequence > record.lastDeliveredSequence) {
      this.subs.set(key, { ...record, lastDeliveredSequence: sequence });
    }
  }

  async beginSnapshotCapture(
    pluginInstanceId: string,
    subscriptionId: string,
    capture: SnapshotCaptureCandidate,
  ): Promise<SnapshotCaptureStart | null> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (!record || record.revokedAt !== undefined) return null;
    if (record.snapshotView) return { status: 'existing', snapshot: structuredClone(record.snapshotView) };
    const existing = this.snapshotCaptures.get(key);
    if (existing && existing.expiresAt > Date.now()) return { status: 'busy' };
    this.snapshotCaptures.set(key, { ...capture, itemCount: 0 });
    this.snapshotCaptureItems.set(key, []);
    return { status: 'started' };
  }

  async appendSnapshotCapture(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    expectedOffset: number,
    items: readonly MessageEnvelope[],
  ): Promise<boolean> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    const capture = this.snapshotCaptures.get(key);
    if (
      !record ||
      record.revokedAt !== undefined ||
      !capture ||
      capture.snapshotId !== snapshotId ||
      capture.itemCount !== expectedOffset ||
      capture.expiresAt <= Date.now()
    ) {
      return false;
    }
    const current = this.snapshotCaptureItems.get(key) ?? [];
    const appended = [...current, ...structuredClone(items)];
    this.snapshotCaptureItems.set(key, appended);
    this.snapshotCaptures.set(key, { ...capture, itemCount: appended.length });
    return true;
  }

  async commitSnapshotCapture(
    pluginInstanceId: string,
    subscriptionId: string,
    commit: SnapshotCaptureCommit,
  ): Promise<SnapshotViewRecord | null> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    const capture = this.snapshotCaptures.get(key);
    if (!record || record.revokedAt !== undefined) return null;
    if (record.snapshotView) return structuredClone(record.snapshotView);
    if (
      !capture ||
      capture.snapshotId !== commit.snapshotId ||
      capture.itemCount !== commit.expectedItemCount ||
      capture.expiresAt <= Date.now()
    ) {
      return null;
    }
    const frozen: SnapshotViewRecord = {
      snapshotId: capture.snapshotId,
      headSequence: capture.headSequence,
      itemCount: capture.itemCount,
      createdAt: capture.createdAt,
      nextOffset: commit.nextOffset,
      traversalComplete: commit.traversalComplete,
    };
    this.snapshotItems.set(key, this.snapshotCaptureItems.get(key) ?? []);
    this.snapshotCaptures.delete(key);
    this.snapshotCaptureItems.delete(key);
    this.subs.set(key, { ...record, snapshotView: frozen, lastSnapshotCompletion: undefined });
    return structuredClone(frozen);
  }

  async abortSnapshotCapture(pluginInstanceId: string, subscriptionId: string, snapshotId: string): Promise<void> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    if (this.snapshotCaptures.get(key)?.snapshotId !== snapshotId) return;
    this.snapshotCaptures.delete(key);
    this.snapshotCaptureItems.delete(key);
  }

  async readSnapshotPage(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    offset: number,
    limit: number,
  ): Promise<readonly MessageEnvelope[] | null> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (
      !record ||
      record.revokedAt !== undefined ||
      record.snapshotView?.snapshotId !== snapshotId ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 0
    ) {
      return null;
    }
    const items = this.snapshotItems.get(key);
    if (!items) return record.snapshotView.itemCount === 0 ? [] : null;
    return structuredClone(items.slice(offset, offset + limit));
  }

  async consumeSnapshotPage(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    expected: { readonly offset: number; readonly tokenId?: string },
    next: { readonly offset: number; readonly tokenId?: string; readonly traversalComplete: boolean },
  ): Promise<boolean> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    const snapshot = record?.snapshotView;
    if (
      !record ||
      record.revokedAt !== undefined ||
      !snapshot ||
      snapshot.snapshotId !== snapshotId ||
      snapshot.traversalComplete ||
      snapshot.nextOffset !== expected.offset ||
      snapshot.nextPageTokenId !== expected.tokenId
    ) {
      return false;
    }
    this.subs.set(key, {
      ...record,
      snapshotView: {
        ...snapshot,
        lastPageOffset: expected.offset,
        nextOffset: next.offset,
        nextPageTokenId: next.tokenId,
        traversalComplete: next.traversalComplete,
      },
    });
    return true;
  }

  async ackSnapshot(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    headSequence: number,
  ): Promise<'applied' | 'replayed' | 'rejected'> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (!record || record.revokedAt !== undefined) return 'rejected';
    if (
      record.lastSnapshotCompletion?.snapshotId === snapshotId &&
      record.lastSnapshotCompletion.headSequence === headSequence
    ) {
      return 'replayed';
    }
    if (
      record.snapshotView?.snapshotId !== snapshotId ||
      record.snapshotView.headSequence !== headSequence ||
      !record.snapshotView.traversalComplete
    ) {
      return 'rejected';
    }
    this.subs.set(key, {
      ...record,
      ackedSequence: Math.max(record.ackedSequence, headSequence),
      lastDeliveredSequence: Math.max(record.lastDeliveredSequence, headSequence),
      snapshotView: undefined,
      lastSnapshotCompletion: { snapshotId, headSequence },
    });
    this.snapshotItems.delete(key);
    return 'applied';
  }

  async revokeByHandle(handleId: string, revokedAt: number): Promise<number> {
    let count = 0;
    for (const [key, record] of this.subs.entries()) {
      if (record.handleId === handleId && record.revokedAt === undefined) {
        this.subs.set(key, { ...record, snapshotView: undefined, revokedAt });
        this.snapshotItems.delete(key);
        this.snapshotCaptures.delete(key);
        this.snapshotCaptureItems.delete(key);
        count += 1;
      }
    }
    return count;
  }
}
