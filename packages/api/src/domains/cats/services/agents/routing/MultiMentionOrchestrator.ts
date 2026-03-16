import { randomUUID } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import {
  MAX_MULTI_MENTION_TARGETS,
  MAX_TIMEOUT_MINUTES,
  MIN_TIMEOUT_MINUTES,
  MULTI_MENTION_TERMINAL_STATES,
  type MultiMentionRequest,
  type MultiMentionResponse,
  type MultiMentionResult,
  type MultiMentionStatus,
  type MultiMentionTriggerType,
} from '@cat-cafe/shared';
import { isValidTransition } from './multi-mention-state-machine.js';

// ── Create params ────────────────────────────────────────────────────
export interface MultiMentionCreateParams {
  threadId: string;
  initiator: CatId;
  callbackTo: CatId;
  targets: CatId[];
  question: string;
  context?: string | undefined;
  idempotencyKey?: string | undefined;
  timeoutMinutes: number;
  triggerType?: MultiMentionTriggerType | undefined;
  searchEvidenceRefs?: string[] | undefined;
  overrideReason?: string | undefined;
}

// ── Internal entry ───────────────────────────────────────────────────
interface OrchestratorEntry {
  request: MultiMentionRequest;
  responses: Map<CatId, MultiMentionResponse>;
}

/**
 * MultiMentionOrchestrator (F086 M1)
 *
 * In-memory state manager for multi-mention requests.
 * Thread-safe via Node.js single-threaded event loop.
 */
export class MultiMentionOrchestrator {
  private readonly entries = new Map<string, OrchestratorEntry>();
  private readonly idempotencyIndex = new Map<string, string>(); // "threadId:key" → requestId

  // Dispatch controller tracking: allows thread-level cancel/delete to propagate
  // to individual multi-mention dispatches without the per-thread singleton constraint
  // of InvocationTracker (which would cause concurrent dispatches to abort each other).
  private readonly dispatchControllers = new Map<string, AbortController>(); // "requestId:catId" → controller

  create(params: MultiMentionCreateParams): MultiMentionRequest {
    // Validation
    if (params.targets.length === 0 || params.targets.length > MAX_MULTI_MENTION_TARGETS) {
      throw new Error(`targets must have 1-${MAX_MULTI_MENTION_TARGETS} entries, got ${params.targets.length}`);
    }
    if (params.timeoutMinutes < MIN_TIMEOUT_MINUTES || params.timeoutMinutes > MAX_TIMEOUT_MINUTES) {
      throw new Error(
        `timeout must be ${MIN_TIMEOUT_MINUTES}-${MAX_TIMEOUT_MINUTES} minutes, got ${params.timeoutMinutes}`,
      );
    }

    // Idempotency check
    if (params.idempotencyKey) {
      const idemKey = `${params.threadId}:${params.idempotencyKey}`;
      const existingId = this.idempotencyIndex.get(idemKey);
      if (existingId) {
        const existing = this.entries.get(existingId);
        if (existing) return existing.request;
      }
    }

    const request: MultiMentionRequest = {
      id: randomUUID(),
      threadId: params.threadId,
      initiator: params.initiator,
      callbackTo: params.callbackTo,
      targets: [...params.targets],
      question: params.question,
      timeoutMinutes: params.timeoutMinutes,
      status: 'pending',
      createdAt: Date.now(),
      ...(params.context ? { context: params.context } : {}),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(params.triggerType ? { triggerType: params.triggerType } : {}),
      ...(params.searchEvidenceRefs ? { searchEvidenceRefs: [...params.searchEvidenceRefs] } : {}),
      ...(params.overrideReason ? { overrideReason: params.overrideReason } : {}),
    };

    this.entries.set(request.id, { request, responses: new Map() });

    if (params.idempotencyKey) {
      this.idempotencyIndex.set(`${params.threadId}:${params.idempotencyKey}`, request.id);
    }

    return request;
  }

  start(requestId: string): void {
    this.transition(requestId, 'running');
  }

  recordResponse(requestId: string, catId: CatId, content: string): MultiMentionStatus {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error(`Multi-mention request not found: ${requestId}`);

    // Ignore if already terminal
    if (MULTI_MENTION_TERMINAL_STATES.has(entry.request.status)) {
      return entry.request.status;
    }

    // Ignore if not a target
    if (!entry.request.targets.includes(catId)) {
      return entry.request.status;
    }

    // Ignore duplicate from same cat
    if (entry.responses.has(catId)) {
      return entry.request.status;
    }

    entry.responses.set(catId, {
      catId,
      content,
      timestamp: Date.now(),
      status: 'received',
    });

    // Check completion
    const receivedCount = entry.responses.size;
    const targetCount = entry.request.targets.length;

    if (receivedCount >= targetCount) {
      this.transition(requestId, 'done');
    } else if (entry.request.status === 'running') {
      this.transition(requestId, 'partial');
    }

    return entry.request.status;
  }

  handleTimeout(requestId: string): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    if (MULTI_MENTION_TERMINAL_STATES.has(entry.request.status)) return;

    // Mark missing cats as timeout
    for (const target of entry.request.targets) {
      if (!entry.responses.has(target)) {
        entry.responses.set(target, {
          catId: target,
          content: '',
          timestamp: Date.now(),
          status: 'timeout',
        });
      }
    }

    this.transition(requestId, 'timeout');
  }

  handleFailure(requestId: string, _reason: string): void {
    this.transition(requestId, 'failed');
  }

  getStatus(requestId: string): MultiMentionStatus {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error(`Multi-mention request not found: ${requestId}`);
    return entry.request.status;
  }

  getResult(requestId: string): MultiMentionResult {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error(`Multi-mention request not found: ${requestId}`);

    return {
      request: entry.request,
      responses: [...entry.responses.values()],
    };
  }

  /**
   * Anti-cascade guard: checks if a cat is currently a target
   * in any running/partial multi-mention for this thread.
   */
  isActiveTarget(threadId: string, catId: CatId): boolean {
    for (const entry of this.entries.values()) {
      if (
        entry.request.threadId === threadId &&
        !MULTI_MENTION_TERMINAL_STATES.has(entry.request.status) &&
        entry.request.status !== 'pending' &&
        entry.request.targets.includes(catId)
      ) {
        return true;
      }
    }
    return false;
  }

  findActiveByThread(threadId: string): MultiMentionRequest[] {
    const results: MultiMentionRequest[] = [];
    for (const entry of this.entries.values()) {
      if (entry.request.threadId === threadId && !MULTI_MENTION_TERMINAL_STATES.has(entry.request.status)) {
        results.push(entry.request);
      }
    }
    return results;
  }

  // ── Dispatch controller lifecycle ──────────────────────────────────

  /** Register an AbortController for a specific dispatch (requestId + catId). */
  registerDispatch(requestId: string, catId: CatId, controller: AbortController): void {
    this.dispatchControllers.set(`${requestId}:${catId as string}`, controller);
  }

  /** Unregister a dispatch controller (called on completion). */
  unregisterDispatch(requestId: string, catId: CatId): void {
    this.dispatchControllers.delete(`${requestId}:${catId as string}`);
  }

  /**
   * Abort all active dispatches for a thread.
   * Called by cancel paths (stop button, preempt, thread cancel).
   */
  abortByThread(threadId: string): number {
    let aborted = 0;
    for (const entry of this.entries.values()) {
      if (entry.request.threadId !== threadId) continue;
      if (MULTI_MENTION_TERMINAL_STATES.has(entry.request.status)) continue;
      for (const target of entry.request.targets) {
        const key = `${entry.request.id}:${target as string}`;
        const controller = this.dispatchControllers.get(key);
        if (controller && !controller.signal.aborted) {
          controller.abort();
          aborted++;
        }
      }
    }
    return aborted;
  }

  /**
   * F108: Abort dispatches for a specific cat in a thread (slot-specific cancel).
   * Called when a user cancels a specific slot, not the entire thread.
   */
  abortBySlot(threadId: string, catId: CatId): number {
    let aborted = 0;
    for (const entry of this.entries.values()) {
      if (entry.request.threadId !== threadId) continue;
      if (MULTI_MENTION_TERMINAL_STATES.has(entry.request.status)) continue;
      const key = `${entry.request.id}:${catId as string}`;
      const controller = this.dispatchControllers.get(key);
      if (controller && !controller.signal.aborted) {
        controller.abort();
        aborted++;
      }
    }
    return aborted;
  }

  /**
   * Check if any dispatches are actively running for a thread.
   * Called by delete guard to prevent deletion while dispatches are in-flight.
   */
  hasActiveDispatches(threadId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.request.threadId !== threadId) continue;
      if (MULTI_MENTION_TERMINAL_STATES.has(entry.request.status)) continue;
      for (const target of entry.request.targets) {
        const key = `${entry.request.id}:${target as string}`;
        if (this.dispatchControllers.has(key)) return true;
      }
    }
    return false;
  }

  private transition(requestId: string, to: MultiMentionStatus): void {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error(`Multi-mention request not found: ${requestId}`);

    if (!isValidTransition(entry.request.status, to)) {
      throw new Error(`Invalid multi-mention transition: ${entry.request.status} → ${to}`);
    }
    entry.request.status = to;
  }
}
