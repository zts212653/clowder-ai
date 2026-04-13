/**
 * B-1/B-4: Guide Lifecycle Service — callback route orchestration.
 *
 * Owns: state validation, persistence, socket emission, telemetry.
 * Delegates: pure state logic to GuideStateMachine.
 * Route handlers become thin: parse request → call service → return response.
 *
 * B-4: Guide state reads/writes go through GuideStateBridge (independent store),
 * ThreadStore is only used for thread metadata (access control).
 * Frontend action methods live in GuideActionService.ts (same deps, different file).
 */

import { guideTransitions } from '../../infrastructure/telemetry/instruments.js';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import type { GuideStateV1, GuideStatus, IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { GuideStateBridge } from './GuideSessionRepository.js';
import {
  applyTransition,
  createOfferedState,
  isTerminal,
  isValidTransition,
  transitionToActive,
  transitionToCancelled,
  validTransitionsFrom,
} from './GuideStateMachine.js';
import { canAccessGuideState } from './guide-state-access.js';

/** Telemetry operation name mapping for generic transitions. */
const OP_NAME_MAP: Record<string, string> = {
  offered: 'guide_offer',
  awaiting_choice: 'guide_preview',
  active: 'guide_start',
  completed: 'guide_complete',
  cancelled: 'guide_cancel',
};

function telemetryName(status: string): string {
  return OP_NAME_MAP[status] ?? `guide_${status}`;
}

export interface GuideLifecycleDeps {
  threadStore: IThreadStore;
  guideStore: GuideStateBridge;
  socketManager: SocketManager;
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  isValidGuideId: (id: string) => boolean;
  loadGuideFlow: (id: string) => unknown;
  /** B-6: Optional dismiss tracker for suppressing re-offers. */
  dismissTracker?: import('./GuideDismissTracker.js').IGuideDismissTracker;
}

/** Structured result from lifecycle operations. Routes map this to HTTP responses. */
export type LifecycleResult =
  | { ok: true; guideState: GuideStateV1; flow?: unknown }
  | { ok: false; code: number; error: string; message?: string; validTransitions?: readonly GuideStatus[] };

export class GuideLifecycleService {
  private readonly store: IThreadStore;
  private readonly guideStore: GuideStateBridge;
  private readonly socket: SocketManager;
  private readonly log: GuideLifecycleDeps['log'];
  private readonly isValidGuideId: (id: string) => boolean;
  private readonly loadGuideFlow: (id: string) => unknown;

  constructor(deps: GuideLifecycleDeps) {
    this.store = deps.threadStore;
    this.guideStore = deps.guideStore;
    this.socket = deps.socketManager;
    this.log = deps.log;
    this.isValidGuideId = deps.isValidGuideId;
    this.loadGuideFlow = deps.loadGuideFlow;
  }

  /** Validate guide-id mismatch when existing state has a different guide. */
  private rejectMismatchedGuide(
    existing: GuideStateV1,
    status: GuideStatus,
    existingTerminal: boolean,
  ): LifecycleResult | null {
    if (!existingTerminal) {
      return {
        ok: false,
        code: 409,
        error: 'guide_conflict',
        message: `Thread has active guide "${existing.guideId}" in status "${existing.status}" — complete or cancel it first`,
      };
    }
    if (status !== 'offered') {
      return {
        ok: false,
        code: 400,
        error: `Cannot create new guide state with status "${status}" — must start as "offered"`,
      };
    }
    return null;
  }

  /** Create, persist, and record offer state. */
  private async persistOffer(
    threadId: string,
    params: { guideId: string; userId: string; offeredBy?: string | null },
    logCtx: Record<string, unknown>,
    logMsg: string,
  ): Promise<LifecycleResult> {
    const created = createOfferedState({
      guideId: params.guideId,
      userId: params.userId,
      offeredBy: params.offeredBy ?? undefined,
    });
    await this.guideStore.set(threadId, created);
    guideTransitions.add(1, { 'operation.name': 'guide_offer', status: 'success' });
    this.log.info(logCtx, logMsg);
    return { ok: true, guideState: created };
  }

  // ── update-guide-state (generic transition) ──

  async updateGuideState(params: {
    threadId: string;
    guideId: string;
    status: GuideStatus;
    currentStep?: number;
    userId: string;
    catId?: string | null;
  }): Promise<LifecycleResult> {
    const { threadId, guideId, status, currentStep, userId, catId } = params;

    const thread = await this.store.get(threadId);
    if (!thread) return { ok: false, code: 404, error: 'Thread not found' };

    if (!this.isValidGuideId(guideId)) {
      return { ok: false, code: 400, error: 'unknown_guide_id', message: `Guide "${guideId}" is not registered` };
    }

    const existing = await this.guideStore.get(threadId);
    const existingTerminal = existing ? isTerminal(existing.status) : false;

    if (existing && !existingTerminal && !canAccessGuideState(thread, existing, userId)) {
      return { ok: false, code: 403, error: 'Guide access denied' };
    }

    // First offer — no existing state
    if (!existing) {
      if (status !== 'offered') {
        return {
          ok: false,
          code: 400,
          error: `Cannot create guide state with status "${status}" — must start as "offered"`,
        };
      }
      return this.persistOffer(
        threadId,
        { guideId, userId, offeredBy: catId },
        { guideId, threadId, catId },
        '[F155] guide state created: offered',
      );
    }

    // Different guide — allow new offer only if previous is terminal
    if (existing.guideId !== guideId) {
      const rejection = this.rejectMismatchedGuide(existing, status, existingTerminal);
      if (rejection) return rejection;
      return this.persistOffer(
        threadId,
        { guideId, userId, offeredBy: catId },
        { guideId, threadId },
        '[F155] guide state replaced (previous was terminal)',
      );
    }

    // Same guide, terminal → fresh re-offer
    if (existingTerminal && status === 'offered') {
      return this.persistOffer(
        threadId,
        { guideId, userId, offeredBy: catId },
        { guideId, threadId },
        '[F155] guide re-offered after terminal state',
      );
    }

    // Block direct → active (must use startGuide)
    if (status === 'active') {
      return {
        ok: false,
        code: 400,
        error: 'guide_start_required',
        message:
          'Use /api/callbacks/start-guide to transition a pending guide to "active" so guide_start side effects run',
      };
    }

    // Validate transition
    if (!isValidTransition(existing.status, status)) {
      return {
        ok: false,
        code: 400,
        error: `Invalid guide transition: ${existing.status} → ${status}`,
        validTransitions: validTransitionsFrom(existing.status),
      };
    }

    const updated = applyTransition(existing, status, currentStep);
    await this.guideStore.set(threadId, updated);
    guideTransitions.add(1, { 'operation.name': telemetryName(status), status: 'success' });
    this.log.info({ guideId, threadId, transition: `${existing.status}→${status}` }, '[F155] guide state updated');
    return { ok: true, guideState: updated };
  }

  // ── start-guide (offered/awaiting_choice → active) ──

  async startGuideCallback(params: { threadId: string; guideId: string; userId: string }): Promise<LifecycleResult> {
    const { threadId, guideId, userId } = params;

    if (!this.isValidGuideId(guideId)) {
      return { ok: false, code: 400, error: 'unknown_guide_id', message: `Guide "${guideId}" is not registered` };
    }

    const thread = await this.store.get(threadId);
    if (!thread || thread.deletedAt) {
      return { ok: false, code: 404, error: 'thread_not_found', message: `Thread "${threadId}" does not exist` };
    }
    const gs = await this.guideStore.get(threadId);
    if (!gs || gs.guideId !== guideId) {
      return {
        ok: false,
        code: 400,
        error: 'guide_not_offered',
        message: `Guide "${guideId}" has not been offered in this thread — call update-guide-state first`,
      };
    }
    if (!canAccessGuideState(thread, gs, userId)) {
      return { ok: false, code: 403, error: 'Guide access denied' };
    }
    if (gs.status !== 'offered' && gs.status !== 'awaiting_choice') {
      return {
        ok: false,
        code: 400,
        error: `Cannot start guide in status "${gs.status}" — must be "offered" or "awaiting_choice"`,
      };
    }

    try {
      this.loadGuideFlow(guideId);
    } catch (err) {
      this.log.warn({ guideId, threadId, err }, '[F155] callback start rejected — flow not loadable');
      return { ok: false, code: 400, error: 'guide_flow_invalid', message: (err as Error).message };
    }

    const updated = transitionToActive(gs);
    await this.guideStore.set(threadId, updated);
    this.socket.emitToUser(userId, 'guide_start', { guideId, threadId, timestamp: Date.now() });
    guideTransitions.add(1, { 'operation.name': 'guide_start', status: 'success' });
    this.log.info({ guideId, threadId }, '[F155] guide started (state: active)');
    return { ok: true, guideState: updated };
  }

  // ── guide-control (next/skip/exit on active guide) ──

  async controlGuide(params: {
    threadId: string;
    userId: string;
    action: 'next' | 'skip' | 'exit';
  }): Promise<LifecycleResult> {
    const { threadId, userId, action } = params;

    const thread = await this.store.get(threadId);
    if (!thread || thread.deletedAt) {
      return { ok: false, code: 404, error: 'thread_not_found', message: `Thread "${threadId}" does not exist` };
    }
    const gs = await this.guideStore.get(threadId);
    if (!gs || gs.status !== 'active') {
      return {
        ok: false,
        code: 400,
        error: 'no_active_guide',
        message: `No active guide in thread — current status: ${gs?.status ?? 'none'}`,
      };
    }
    if (!canAccessGuideState(thread, gs, userId)) {
      return { ok: false, code: 403, error: 'Guide access denied' };
    }

    if (action === 'exit') {
      const updated = transitionToCancelled(gs);
      await this.guideStore.set(threadId, updated);
    }

    this.socket.emitToUser(userId, 'guide_control', {
      action,
      guideId: gs.guideId,
      threadId,
      timestamp: Date.now(),
    });
    guideTransitions.add(1, { 'operation.name': `guide_control_${action}`, status: 'success' });
    this.log.info({ action, guideId: gs.guideId, threadId }, '[F155] guide_control');
    return { ok: true, guideState: gs };
  }
}
