import { createHash } from 'node:crypto';
import type { CodexAppServerJsonObject } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';

export type WorkKind = 'reasoning' | 'tool' | 'workspace_fetch' | 'workspace_dispatch' | 'screen_read';
export type WorkPhase = 'started' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'result_handed_to_voice';

export interface WorkEntry {
  readonly taskId: string;
  readonly nativeTurnId: string;
  readonly kind: WorkKind;
  readonly startedAt: number;
  readonly expiresAt: number;
}
export interface WorkEvent {
  readonly eventId: string;
  readonly taskId: string;
  readonly kind: WorkKind | 'result';
  readonly phase: WorkPhase;
  readonly occurredAt: number;
  readonly expiresAt: number;
  readonly resultId?: string;
  readonly nativeCarrierCatId?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

function workKind(item: Record<string, unknown>): WorkKind | null {
  if (item.type === 'reasoning') return 'reasoning';
  if (item.type !== 'mcpToolCall') return null;
  if (item.server === 'cat-cafe-selected-screen' && item.tool === 'view_shared_screen') return 'screen_read';
  if (['cat-cafe-memory', 'cat-cafe-collab'].includes(String(item.server)) && typeof item.tool === 'string') {
    if (/^cat_cafe_(?:get_|list_|read_|search_|graph_resolve$)/.test(item.tool)) return 'workspace_fetch';
    if (['cat_cafe_post_message', 'cat_cafe_cross_post_message'].includes(item.tool)) return 'workspace_dispatch';
  }
  return 'tool';
}

/** Host-owned, call-scoped work truth. A poll replays this bounded snapshot, never a guessed chat animation. */
export class LiveNativeWork {
  private readonly scopeId: string;
  private readonly active = new Map<string, WorkEntry>();
  private readonly handedResults = new Set<string>();
  private readonly seenTurns = new Set<string>();
  private recent: WorkEvent[] = [];
  private revision = 0;
  private currentTurnId: string | undefined;
  private closed = false;
  constructor(
    callId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.scopeId = createHash('sha256').update(callId).digest('hex').slice(0, 16);
  }

  snapshot() {
    this.expire();
    return {
      scopeId: this.scopeId,
      revision: this.revision,
      active: [...this.active.values()],
      recent: [...this.recent],
    };
  }

  /** False rejects a replayed or stale lifecycle envelope before the call changes carrier state. */
  observe(message: CodexAppServerJsonObject, stoppingTurnId?: string): boolean {
    if (this.closed) {
      const turn = record(record(message.params).turn);
      return message.method === 'turn/completed' && stoppingTurnId !== undefined && turn.id === stoppingTurnId;
    }
    const params = record(message.params);
    const turn = record(params.turn);
    if (message.method === 'turn/started') return this.startTurn(turn.id);
    if (message.method === 'turn/completed') return this.completeTurn(turn.id);
    if (message.method !== 'item/started' && message.method !== 'item/completed') return true;
    if (!nativeId(params.turnId) || params.turnId !== this.currentTurnId) return false;
    const item = record(params.item);
    if (!nativeId(item.id)) return true;
    this.observeItem(message.method, params.turnId, item.id, item);
    return true;
  }

  private startTurn(id: unknown): boolean {
    if (!nativeId(id) || this.seenTurns.has(id) || this.seenTurns.size >= 4096) return false;
    this.seenTurns.add(id);
    this.cancelActive();
    this.currentTurnId = id;
    return true;
  }

  private completeTurn(id: unknown): boolean {
    if (!nativeId(id)) return false;
    if (this.seenTurns.size < 4096) this.seenTurns.add(id);
    if (this.currentTurnId !== id) return false;
    this.cancelActive(id);
    this.currentTurnId = undefined;
    return true;
  }

  private observeItem(
    method: 'item/started' | 'item/completed',
    nativeTurnId: string,
    itemId: string,
    item: Record<string, unknown>,
  ): void {
    const taskId = `${this.scopeId}/${nativeTurnId}/${itemId}`;
    if (method === 'item/started') {
      if (this.active.has(taskId) || this.active.size >= 64) return;
      const kind = workKind(item);
      if (!kind) return;
      const now = this.now();
      const entry = { taskId, nativeTurnId, kind, startedAt: now, expiresAt: now + 300_000 };
      this.active.set(taskId, entry);
      this.addEvent(entry, 'started', now);
      return;
    }
    const entry = this.active.get(taskId);
    if (!entry) return;
    this.active.delete(taskId);
    const successful =
      (item.status === undefined || item.status === 'completed') &&
      item.error == null &&
      record(item.result).isError !== true;
    this.addEvent(entry, successful ? 'completed' : 'failed', this.now());
  }

  resultHandedToVoice(nativeTurnId: string, itemId: string, nativeCarrierCatId: string): void {
    if (this.closed || !nativeId(nativeTurnId) || !nativeId(itemId) || !nativeId(nativeCarrierCatId)) return;
    const resultId = `${this.scopeId}/${nativeTurnId}/${itemId}`;
    if (this.handedResults.has(resultId)) return;
    this.handedResults.add(resultId);
    if (this.handedResults.size > 64) {
      const oldest = this.handedResults.values().next().value;
      if (oldest) this.handedResults.delete(oldest);
    }
    const now = this.now();
    this.revision++;
    this.recent.push({
      eventId: `${this.scopeId}:${this.revision}`,
      taskId: `${this.scopeId}/${nativeTurnId}`,
      kind: 'result',
      phase: 'result_handed_to_voice',
      resultId,
      nativeCarrierCatId,
      occurredAt: now,
      expiresAt: now + 120_000,
    });
    this.trim(now);
  }

  cancelActive(nativeTurnId?: string): void {
    const now = this.now();
    for (const [id, entry] of this.active) {
      if (nativeTurnId && entry.nativeTurnId !== nativeTurnId) continue;
      this.active.delete(id);
      this.addEvent(entry, 'cancelled', now);
    }
  }

  close(): void {
    if (this.closed) return;
    this.cancelActive();
    this.currentTurnId = undefined;
    this.closed = true;
  }

  private expire(): void {
    const now = this.now();
    for (const [id, entry] of this.active) {
      if (entry.expiresAt > now) continue;
      this.active.delete(id);
      this.addEvent(entry, 'expired', now);
    }
    this.trim(now);
  }

  private addEvent(entry: WorkEntry, phase: WorkPhase, now: number): void {
    this.revision++;
    this.recent.push({
      eventId: `${this.scopeId}:${this.revision}`,
      taskId: entry.taskId,
      kind: entry.kind,
      phase,
      occurredAt: now,
      expiresAt: now + 120_000,
    });
    this.trim(now);
  }

  private trim(now: number): void {
    this.recent = this.recent.filter((event) => event.expiresAt > now).slice(-16);
  }
}
