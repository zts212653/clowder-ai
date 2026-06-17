/**
 * ConciergeHandleMapStore (F229 KD-17)
 *
 * Per-concierge-thread short handle → anchor mapping.
 * R1/R2/... map to real anchors (threadId, messageId, title, type).
 *
 * Written by search context builder (pre-fetch), read by reply validator (post-process).
 * Max 20 handles per thread — rolling eviction (oldest labels evicted first).
 *
 * Pattern: port interface + Redis impl + Memory impl (test), same as ConciergeConfigStore.
 * TTL=0 (铁律 5, LL-048).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { ConciergeKeys } from './concierge-keys.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HandleAnchor {
  threadId: string;
  messageId?: string;
  title: string;
  type: string; // 'thread' | 'feature' | 'message' | 'guide' | etc.
}

export interface HandleEntry {
  label: string; // R1, R2, ...
  anchor: HandleAnchor;
}

const MAX_HANDLES = 20;

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface IConciergeHandleMapStore {
  /** Set handles for a concierge thread (replaces existing). Evicts oldest if > MAX_HANDLES. */
  setHandles(threadId: string, handles: HandleEntry[]): Promise<void>;
  /** Get a single handle's anchor by label (e.g. 'R1'). Returns null if not found. */
  getHandle(threadId: string, label: string): Promise<HandleAnchor | null>;
  /** Get all handles for a thread. Returns empty array if none. */
  getAllHandles(threadId: string): Promise<HandleEntry[]>;
  /** Clear all handles for a thread. */
  clearHandles(threadId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enforceMaxHandles(handles: HandleEntry[]): HandleEntry[] {
  if (handles.length <= MAX_HANDLES) return handles;
  // Evict oldest (beginning of array) — keep the last MAX_HANDLES entries
  return handles.slice(handles.length - MAX_HANDLES);
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

export class RedisConciergeHandleMapStore implements IConciergeHandleMapStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async setHandles(threadId: string, handles: HandleEntry[]): Promise<void> {
    const trimmed = enforceMaxHandles(handles);
    const key = ConciergeKeys.handleMap(threadId);
    // TTL=0 — persistent (铁律 5 LL-048)
    await this.redis.set(key, JSON.stringify(trimmed));
  }

  async getHandle(threadId: string, label: string): Promise<HandleAnchor | null> {
    const raw = await this.redis.get(ConciergeKeys.handleMap(threadId));
    if (!raw) return null;
    const handles: HandleEntry[] = JSON.parse(raw);
    const entry = handles.find((h) => h.label === label);
    return entry?.anchor ?? null;
  }

  async getAllHandles(threadId: string): Promise<HandleEntry[]> {
    const raw = await this.redis.get(ConciergeKeys.handleMap(threadId));
    if (!raw) return [];
    return JSON.parse(raw) as HandleEntry[];
  }

  async clearHandles(threadId: string): Promise<void> {
    await this.redis.del(ConciergeKeys.handleMap(threadId));
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (test / stub)
// ---------------------------------------------------------------------------

export class MemoryConciergeHandleMapStore implements IConciergeHandleMapStore {
  private readonly store = new Map<string, HandleEntry[]>();

  async setHandles(threadId: string, handles: HandleEntry[]): Promise<void> {
    this.store.set(threadId, enforceMaxHandles([...handles]));
  }

  async getHandle(threadId: string, label: string): Promise<HandleAnchor | null> {
    const entries = this.store.get(threadId);
    if (!entries) return null;
    const entry = entries.find((h) => h.label === label);
    return entry?.anchor ?? null;
  }

  async getAllHandles(threadId: string): Promise<HandleEntry[]> {
    return this.store.get(threadId) ?? [];
  }

  async clearHandles(threadId: string): Promise<void> {
    this.store.delete(threadId);
  }
}
