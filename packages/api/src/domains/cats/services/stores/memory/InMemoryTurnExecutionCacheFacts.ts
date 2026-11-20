import type { TurnExecutionRecord } from '@cat-cafe/shared';
import {
  type CacheExecutionObservation,
  type CacheExecutionScope,
  cacheExecutionScopeKey,
  type FirstCacheExecution,
  isCacheInput,
  type TurnExecutionCacheFacts,
} from '../ports/TurnExecutionCacheFacts.js';

export class InMemoryTurnExecutionCacheFacts implements TurnExecutionCacheFacts {
  private readonly order = new Map<string, string[]>();
  private readonly entered = new Set<string>();
  private readonly observations = new Map<string, CacheExecutionObservation>();
  constructor(private readonly get: (id: string) => TurnExecutionRecord | null) {}
  enter(record: TurnExecutionRecord): boolean {
    if (!isCacheInput(record) || this.entered.has(record.invocationId)) return true;
    const key = cacheExecutionScopeKey(record),
      entries = this.order.get(key) ?? [];
    entries.push(record.invocationId);
    this.order.set(key, entries);
    this.entered.add(record.invocationId);
    return true;
  }
  head(scope: CacheExecutionScope): number {
    return this.order.get(cacheExecutionScopeKey(scope))?.length ?? 0;
  }
  sequenceOf(scope: CacheExecutionScope, id: string): number | undefined {
    const index = this.order.get(cacheExecutionScopeKey(scope))?.indexOf(id) ?? -1;
    return index >= 0 ? index + 1 : undefined;
  }
  recordObservation(id: string, value: CacheExecutionObservation): boolean {
    if (!this.entered.has(id) || value.observation.invocationId !== id) return false;
    const old = this.observations.get(id);
    if (old) return JSON.stringify(old) === JSON.stringify(value);
    this.observations.set(id, structuredClone(value));
    return true;
  }
  firstAfter(scope: CacheExecutionScope, frontier: number): FirstCacheExecution {
    if (!Number.isSafeInteger(frontier) || frontier < 0) return { status: 'unknown' };
    const id = this.order.get(cacheExecutionScopeKey(scope))?.[frontier];
    if (!id) return { status: 'none' };
    const value = this.observations.get(id);
    if (value) return { status: 'observed', invocationId: id, value: structuredClone(value) };
    return this.get(id)?.status === 'running' ? { status: 'pending' } : { status: 'unknown', invocationId: id };
  }
}
