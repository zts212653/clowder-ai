import type { CatId } from '@cat-cafe/shared';
import {
  normalizeRuntimeSessionMetadata,
  type RuntimeSessionLifecycleState,
  type RuntimeSessionMetadata,
  type RuntimeSessionRuntime,
  type RuntimeSessionSurface,
} from './RuntimeSessionMetadata.js';
import {
  needsRuntimeSealRecovery,
  planRuntimeSealRecoveryFailure,
  preserveRuntimeSealRecovery,
  sameRuntimeSealExecution,
} from './runtime-seal-recovery-state.js';

export interface RuntimeSessionRecentFilter {
  runtime?: RuntimeSessionRuntime;
  catId?: CatId;
  surface?: RuntimeSessionSurface;
  limit?: number;
  offset?: number;
}

export interface IRuntimeSessionStore {
  listSealRecoveryCandidates(limit?: number): RuntimeSessionMetadata[] | Promise<RuntimeSessionMetadata[]>;
  parkSealRecovery(record: RuntimeSessionMetadata, now: number): boolean | Promise<boolean>;
  failSealRecovery(
    record: RuntimeSessionMetadata,
    now: number,
    maxRetries: number,
    reason: string,
  ): boolean | Promise<boolean>;
  upsert(metadata: RuntimeSessionMetadata): RuntimeSessionMetadata | Promise<RuntimeSessionMetadata>;
  getBySessionId(sessionId: string): RuntimeSessionMetadata | null | Promise<RuntimeSessionMetadata | null>;
  getByRuntimeSession(
    runtime: RuntimeSessionRuntime,
    runtimeSessionId: string,
  ): RuntimeSessionMetadata | null | Promise<RuntimeSessionMetadata | null>;
  getActiveByThreadCat(
    runtime: RuntimeSessionRuntime,
    threadId: string,
    catId: CatId,
  ): RuntimeSessionMetadata | null | Promise<RuntimeSessionMetadata | null>;
  listByLifecycleState(
    state: RuntimeSessionLifecycleState,
  ): RuntimeSessionMetadata[] | Promise<RuntimeSessionMetadata[]>;
  listRecent(filter: RuntimeSessionRecentFilter): RuntimeSessionMetadata[] | Promise<RuntimeSessionMetadata[]>;
  updateLifecycle(
    sessionId: string,
    patch: Partial<RuntimeSessionMetadata['lifecycle']>,
  ): RuntimeSessionMetadata | null | Promise<RuntimeSessionMetadata | null>;
}

export class RuntimeSessionStore implements IRuntimeSessionStore {
  private records = new Map<string, RuntimeSessionMetadata>();
  private sealPending = new Set<string>();
  private runtimeIndex = new Map<string, string>();
  private stateIndex = new Map<RuntimeSessionLifecycleState, Set<string>>();

  upsert(metadata: RuntimeSessionMetadata): RuntimeSessionMetadata {
    const incoming = normalizeRuntimeSessionMetadata(metadata);
    const existing = this.records.get(incoming.sessionId);
    const normalized = preserveRuntimeSealRecovery(existing ?? null, incoming);

    if (existing) {
      this.runtimeIndex.delete(runtimeKey(existing.runtime, existing.runtimeSessionId));
      this.removeFromStateIndex(existing.lifecycle.state, existing.sessionId);
    }

    this.sealPending.delete(normalized.sessionId);
    if (needsRuntimeSealRecovery(normalized)) this.sealPending.add(normalized.sessionId);
    this.records.set(normalized.sessionId, cloneMetadata(normalized));
    this.runtimeIndex.set(runtimeKey(normalized.runtime, normalized.runtimeSessionId), normalized.sessionId);
    this.addToStateIndex(normalized.lifecycle.state, normalized.sessionId);
    return cloneMetadata(normalized);
  }

  getBySessionId(sessionId: string): RuntimeSessionMetadata | null {
    const record = this.records.get(sessionId);
    return record ? cloneMetadata(record) : null;
  }

  getByRuntimeSession(runtime: RuntimeSessionRuntime, runtimeSessionId: string): RuntimeSessionMetadata | null {
    const sessionId = this.runtimeIndex.get(runtimeKey(runtime, runtimeSessionId));
    return sessionId ? this.getBySessionId(sessionId) : null;
  }

  getActiveByThreadCat(runtime: RuntimeSessionRuntime, threadId: string, catId: CatId): RuntimeSessionMetadata | null {
    const active = Array.from(this.records.values())
      .filter(
        (record) =>
          record.runtime === runtime &&
          record.threadId === threadId &&
          record.catId === catId &&
          record.lifecycle.state === 'active',
      )
      .sort((a, b) => {
        const observedDelta = b.lifecycle.lastObservedAt - a.lifecycle.lastObservedAt;
        if (observedDelta !== 0) return observedDelta;
        return a.sessionId.localeCompare(b.sessionId);
      });
    return active[0] ? cloneMetadata(active[0]) : null;
  }

  listSealRecoveryCandidates(limit = 100): RuntimeSessionMetadata[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_runtime_seal_batch_limit');
    const records: RuntimeSessionMetadata[] = [];
    for (const id of this.sealPending) {
      if (records.length >= limit) break;
      const record = this.records.get(id);
      if (record && needsRuntimeSealRecovery(record)) records.push(cloneMetadata(record));
    }
    return records;
  }
  parkSealRecovery(selected: RuntimeSessionMetadata, now: number): boolean {
    const current = this.records.get(selected.sessionId);
    if (
      !current ||
      !needsRuntimeSealRecovery(current) ||
      !sameRuntimeSealExecution(current, selected) ||
      (current.lifecycle.retryCount ?? 0) !== (selected.lifecycle.retryCount ?? 0)
    )
      return false;
    this.upsert({
      ...current,
      lifecycle: {
        ...current.lifecycle,
        recoveryDisposition: 'needs_attention',
        recoveryReasonCode: 'seal_retry_exhausted',
        recoveryDisposedAt: now,
      },
    });
    return true;
  }
  failSealRecovery(selected: RuntimeSessionMetadata, now: number, maxRetries: number, reason: string): boolean {
    const current = this.records.get(selected.sessionId);
    const next = current && planRuntimeSealRecoveryFailure(current, selected, now, maxRetries, reason);
    if (!next) return false;
    this.upsert(next);
    return true;
  }

  listByLifecycleState(state: RuntimeSessionLifecycleState): RuntimeSessionMetadata[] {
    const ids = this.stateIndex.get(state);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.records.get(id))
      .filter((record): record is RuntimeSessionMetadata => record !== undefined)
      .sort((a, b) => {
        const observedDelta = a.lifecycle.lastObservedAt - b.lifecycle.lastObservedAt;
        if (observedDelta !== 0) return observedDelta;
        return a.sessionId.localeCompare(b.sessionId);
      })
      .map((record) => cloneMetadata(record));
  }

  listRecent(filter: RuntimeSessionRecentFilter): RuntimeSessionMetadata[] {
    const limit = normalizeLimit(filter.limit);
    const offset = normalizeOffset(filter.offset);
    return Array.from(this.records.values())
      .filter((record) => {
        if (filter.runtime && record.runtime !== filter.runtime) return false;
        if (filter.catId && record.catId !== filter.catId) return false;
        if (filter.surface && record.surface !== filter.surface) return false;
        return true;
      })
      .sort((a, b) => {
        const observedDelta = b.lifecycle.lastObservedAt - a.lifecycle.lastObservedAt;
        if (observedDelta !== 0) return observedDelta;
        return a.sessionId.localeCompare(b.sessionId);
      })
      .slice(offset, offset + limit)
      .map((record) => cloneMetadata(record));
  }

  updateLifecycle(
    sessionId: string,
    patch: Partial<RuntimeSessionMetadata['lifecycle']>,
  ): RuntimeSessionMetadata | null {
    const existing = this.records.get(sessionId);
    if (!existing) return null;
    return this.upsert({
      ...existing,
      lifecycle: {
        ...existing.lifecycle,
        ...patch,
      },
    });
  }

  private addToStateIndex(state: RuntimeSessionLifecycleState, sessionId: string): void {
    const ids = this.stateIndex.get(state) ?? new Set<string>();
    ids.add(sessionId);
    this.stateIndex.set(state, ids);
  }

  private removeFromStateIndex(state: RuntimeSessionLifecycleState, sessionId: string): void {
    const ids = this.stateIndex.get(state);
    if (!ids) return;
    ids.delete(sessionId);
    if (ids.size === 0) this.stateIndex.delete(state);
  }
}

function runtimeKey(runtime: RuntimeSessionRuntime, runtimeSessionId: string): string {
  return `${runtime}:${runtimeSessionId}`;
}

function cloneMetadata(metadata: RuntimeSessionMetadata): RuntimeSessionMetadata {
  return structuredClone(metadata);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1) return 50;
  return Math.min(limit, 200);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}
