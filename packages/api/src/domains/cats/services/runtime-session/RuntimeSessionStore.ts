import {
  normalizeRuntimeSessionMetadata,
  type RuntimeSessionLifecycleState,
  type RuntimeSessionMetadata,
  type RuntimeSessionRuntime,
} from './RuntimeSessionMetadata.js';

export interface IRuntimeSessionStore {
  upsert(metadata: RuntimeSessionMetadata): RuntimeSessionMetadata | Promise<RuntimeSessionMetadata>;
  getBySessionId(sessionId: string): RuntimeSessionMetadata | null | Promise<RuntimeSessionMetadata | null>;
  getByRuntimeSession(
    runtime: RuntimeSessionRuntime,
    runtimeSessionId: string,
  ): RuntimeSessionMetadata | null | Promise<RuntimeSessionMetadata | null>;
  listByLifecycleState(
    state: RuntimeSessionLifecycleState,
  ): RuntimeSessionMetadata[] | Promise<RuntimeSessionMetadata[]>;
  updateLifecycle(
    sessionId: string,
    patch: Partial<RuntimeSessionMetadata['lifecycle']>,
  ): RuntimeSessionMetadata | null | Promise<RuntimeSessionMetadata | null>;
}

export class RuntimeSessionStore implements IRuntimeSessionStore {
  private records = new Map<string, RuntimeSessionMetadata>();
  private runtimeIndex = new Map<string, string>();
  private stateIndex = new Map<RuntimeSessionLifecycleState, Set<string>>();

  upsert(metadata: RuntimeSessionMetadata): RuntimeSessionMetadata {
    const normalized = normalizeRuntimeSessionMetadata(metadata);
    const existing = this.records.get(normalized.sessionId);

    if (existing) {
      this.runtimeIndex.delete(runtimeKey(existing.runtime, existing.runtimeSessionId));
      this.removeFromStateIndex(existing.lifecycle.state, existing.sessionId);
    }

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
