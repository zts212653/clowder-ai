/**
 * B-1/B-4: Guide Action Service — frontend-facing guide lifecycle.
 *
 * Handles: start, cancel, preview, complete actions triggered by the frontend.
 * Includes self-heal logic for non-shared threads where offered state is missing.
 *
 * B-4: Guide state reads/writes go through GuideStateBridge (independent store).
 * ThreadStore is only used for thread metadata (access control).
 */

import { guideTransitions } from '../../infrastructure/telemetry/instruments.js';
import type { GuideStateV1 } from '../cats/services/stores/ports/ThreadStore.js';
import type { GuideLifecycleDeps, LifecycleResult } from './GuideLifecycleService.js';
import type { GuideStateBridge } from './GuideSessionRepository.js';
import {
  isTerminal,
  transitionToActive,
  transitionToAwaitingChoice,
  transitionToCancelled,
  transitionToCompleted,
} from './GuideStateMachine.js';
import { canAccessGuideState, canAccessThread, isSharedDefaultThread } from './guide-state-access.js';

export class GuideActionService {
  private readonly store: GuideLifecycleDeps['threadStore'];
  private readonly guideStore: GuideStateBridge;
  private readonly socket: GuideLifecycleDeps['socketManager'];
  private readonly log: GuideLifecycleDeps['log'];
  private readonly loadGuideFlow: (id: string) => unknown;
  private readonly dismissTracker: GuideLifecycleDeps['dismissTracker'];

  constructor(deps: GuideLifecycleDeps) {
    this.store = deps.threadStore;
    this.guideStore = deps.guideStore;
    this.socket = deps.socketManager;
    this.log = deps.log;
    this.loadGuideFlow = deps.loadGuideFlow;
    this.dismissTracker = deps.dismissTracker;
  }

  // ── start (with self-heal) ──

  async startGuideAction(params: { threadId: string; guideId: string; userId: string }): Promise<LifecycleResult> {
    const { threadId, guideId, userId } = params;

    const thread = await this.store.get(threadId);
    if (!thread) return { ok: false, code: 404, error: 'Thread not found' };
    if (!canAccessThread(thread, userId)) return { ok: false, code: 403, error: 'Thread access denied' };

    try {
      this.loadGuideFlow(guideId);
    } catch (err) {
      this.log.warn({ guideId, threadId, err }, '[F155] start rejected — flow not loadable');
      return { ok: false, code: 400, error: 'guide_flow_invalid', message: (err as Error).message };
    }

    const gs = await this.guideStore.get(threadId);
    if (!gs) {
      if (isSharedDefaultThread(thread)) {
        return { ok: false, code: 409, error: 'guide_not_offered', message: 'No guide offered on shared thread' };
      }
      const created: GuideStateV1 = {
        v: 1,
        guideId,
        status: 'active',
        userId,
        offeredAt: Date.now(),
        startedAt: Date.now(),
      };
      await this.guideStore.set(threadId, created);
      this.socket.emitToUser(userId, 'guide_start', { guideId, threadId, timestamp: Date.now() });
      guideTransitions.add(1, { 'operation.name': 'guide_start', status: 'success' });
      this.log.info({ guideId, threadId, userId }, '[F155] guide started (self-healed missing offered state)');
      return { ok: true, guideState: created };
    }

    if (gs.guideId !== guideId) {
      return {
        ok: false,
        code: 400,
        error: 'guide_not_offered',
        message: `Guide "${guideId}" not offered in this thread`,
      };
    }
    if (!canAccessGuideState(thread, gs, userId)) {
      return { ok: false, code: 403, error: 'Guide access denied' };
    }
    if (gs.status !== 'offered' && gs.status !== 'awaiting_choice') {
      return { ok: false, code: 400, error: `Cannot start guide in status "${gs.status}"` };
    }

    const updated = transitionToActive(gs);
    await this.guideStore.set(threadId, updated);
    this.socket.emitToUser(userId, 'guide_start', { guideId, threadId, timestamp: Date.now() });
    guideTransitions.add(1, { 'operation.name': 'guide_start', status: 'success' });
    this.log.info({ guideId, threadId, userId }, '[F155] guide started via frontend action');
    return { ok: true, guideState: updated };
  }

  // ── cancel ──

  async cancelGuideAction(params: { threadId: string; guideId: string; userId: string }): Promise<LifecycleResult> {
    const { threadId, guideId, userId } = params;

    const thread = await this.store.get(threadId);
    if (!thread) return { ok: false, code: 404, error: 'Thread not found' };
    if (!canAccessThread(thread, userId)) return { ok: false, code: 403, error: 'Thread access denied' };

    const gs = await this.guideStore.get(threadId);
    if (!gs || gs.guideId !== guideId) {
      return { ok: true, guideState: null as unknown as GuideStateV1 };
    }
    if (!canAccessGuideState(thread, gs, userId)) {
      return { ok: false, code: 403, error: 'Guide access denied' };
    }
    if (isTerminal(gs.status)) {
      return { ok: true, guideState: gs };
    }

    const wasOfferStage = gs.status === 'offered' || gs.status === 'awaiting_choice';
    const updated = transitionToCancelled(gs);
    await this.guideStore.set(threadId, updated);
    this.socket.emitToUser(userId, 'guide_control', { action: 'exit', guideId, threadId, timestamp: Date.now() });
    guideTransitions.add(1, { 'operation.name': 'guide_cancel', status: 'success' });
    this.log.info({ guideId, threadId, userId }, '[F155] guide cancelled via frontend action');

    // B-6: Track dismissal only for offer-stage cancels (not active guide exits)
    if (wasOfferStage) {
      this.dismissTracker?.incrementDismiss(userId, guideId).catch(() => {});
    }

    return { ok: true, guideState: updated };
  }

  // ── preview (offered → awaiting_choice, with self-heal) ──

  async previewGuideAction(params: { threadId: string; guideId: string; userId: string }): Promise<LifecycleResult> {
    const { threadId, guideId, userId } = params;

    const thread = await this.store.get(threadId);
    if (!thread) return { ok: false, code: 404, error: 'Thread not found' };
    if (!canAccessThread(thread, userId)) return { ok: false, code: 403, error: 'Thread access denied' };

    let flow: unknown;
    try {
      flow = this.loadGuideFlow(guideId);
    } catch {
      return { ok: false, code: 400, error: 'guide_flow_invalid', message: `Guide flow "${guideId}" not found` };
    }

    const gs = await this.guideStore.get(threadId);
    if (!gs) {
      if (isSharedDefaultThread(thread)) {
        return { ok: false, code: 409, error: 'guide_not_offered', message: 'No guide offered on shared thread' };
      }
      const created: GuideStateV1 = {
        v: 1,
        guideId,
        status: 'awaiting_choice',
        userId,
        offeredAt: Date.now(),
      };
      await this.guideStore.set(threadId, created);
      guideTransitions.add(1, { 'operation.name': 'guide_preview', status: 'success' });
      this.log.info({ guideId, threadId, userId }, '[F155] guide preview (self-healed to awaiting_choice)');
      return { ok: true, guideState: created, flow };
    }

    if (gs.guideId !== guideId) {
      return {
        ok: false,
        code: 400,
        error: 'guide_not_offered',
        message: `Guide "${guideId}" not offered in this thread`,
      };
    }
    if (!canAccessGuideState(thread, gs, userId)) {
      return { ok: false, code: 403, error: 'Guide access denied' };
    }

    if (gs.status === 'offered') {
      const updated = transitionToAwaitingChoice(gs);
      await this.guideStore.set(threadId, updated);
      guideTransitions.add(1, { 'operation.name': 'guide_preview', status: 'success' });
      this.log.info({ guideId, threadId, userId }, '[F155] guide preview (offered → awaiting_choice)');
      return { ok: true, guideState: updated, flow };
    }

    return { ok: true, guideState: gs, flow };
  }

  // ── complete (active → completed) ──

  async completeGuideAction(params: { threadId: string; guideId: string; userId: string }): Promise<LifecycleResult> {
    const { threadId, guideId, userId } = params;

    const thread = await this.store.get(threadId);
    if (!thread) return { ok: false, code: 404, error: 'Thread not found' };
    if (!canAccessThread(thread, userId)) return { ok: false, code: 403, error: 'Thread access denied' };

    const gs = await this.guideStore.get(threadId);
    if (!gs || gs.guideId !== guideId) {
      return {
        ok: false,
        code: 400,
        error: 'guide_not_active',
        message: `Guide "${guideId}" not active in this thread`,
      };
    }
    if (!canAccessGuideState(thread, gs, userId)) {
      return { ok: false, code: 403, error: 'Guide access denied' };
    }
    if (gs.status === 'completed') {
      return { ok: true, guideState: gs };
    }
    if (gs.status !== 'active') {
      return { ok: false, code: 400, error: `Cannot complete guide in status "${gs.status}"` };
    }

    const updated = transitionToCompleted(gs);
    await this.guideStore.set(threadId, updated);
    this.socket.emitToUser(userId, 'guide_complete', { guideId, threadId, timestamp: Date.now() });
    guideTransitions.add(1, { 'operation.name': 'guide_complete', status: 'success' });
    this.log.info({ guideId, threadId, userId }, '[F155] guide completed via frontend action');
    return { ok: true, guideState: updated };
  }
}
