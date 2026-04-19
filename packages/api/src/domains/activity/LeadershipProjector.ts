/**
 * Leadership Projector (Phase D)
 *
 * Subscribes to ActivityEventBus and translates co-creator-relevant events
 * into leadership footfall via LeadershipService.awardXp().
 *
 * IMPORTANT: Uses request-level events for multi-mention scoring (not per-responder).
 * - multi_mention_dispatched  → fires ONCE when co-creator dispatches
 * - multi_mention_request_completed → fires ONCE when all responders finish (from flushResult)
 * - Per-responder events (multi_mention_completed, deep_collab_completed) are for cat XP only.
 */

import type { ActivityEvent, LeadershipFootfallSource } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import type { ActivityEventBus } from './ActivityEventBus.js';

const log = createModuleLogger('leadership-projector');

interface LeadershipServiceLike {
  awardXp(source: LeadershipFootfallSource, multiplier?: number): void;
}

/** Minimum target count to earn target_diversity bonus. */
const DIVERSITY_THRESHOLD = 3;

export class LeadershipProjector {
  constructor(
    private readonly bus: ActivityEventBus,
    private readonly leadershipService: LeadershipServiceLike,
  ) {
    this.bus.on(this.handleEvent);
    log.info('LeadershipProjector subscribed to ActivityEventBus');
  }

  private handleEvent = (event: ActivityEvent): void => {
    try {
      // Leadership measures co-creator behaviour. Cat-originated coordination
      // events (e.g. cat-initiated multi-mention) must not inflate leadership scores.
      const isCoCreator = event.actorId === 'co-creator';

      switch (event.type) {
        // ── Coordination (协调力) ────────────────────────
        case 'multi_mention_dispatched':
          if (!isCoCreator) break;
          this.leadershipService.awardXp('multi_mention_dispatch');
          break;
        case 'multi_mention_request_completed':
          if (!isCoCreator) break;
          this.onRequestCompleted(event);
          break;
        // ── Delegation + Guidance (授权力 + 引导力) ──────
        case 'task_completed':
          this.onTaskCompleted(event);
          break;
        case 'session_sealed':
          this.onSessionSealed(event);
          break;
        // ── Exploration (开拓力) ─────────────────────────
        case 'tool_used':
          this.onToolUsed(event);
          break;
        // ── Shadow (AC-D3) → AC-D6 real events ─────────────
        case 'review_submitted':
          // D6 TODO: Replace with real feedback_applied event chain (proxy P1)
          this.leadershipService.awardXp('feedback_applied');
          break;
        case 'decision_confirmed':
          // D6: Explicit decision — separate source from proxy for D7 calibration
          this.leadershipService.awardXp('direction_confirmed_explicit');
          break;
        case 'clarification_requested':
          // D6: Record to audit trail via shadow dim (1 XP) for D7 calibration data.
          this.leadershipService.awardXp('clarification_observed');
          break;
      }
    } catch (err: unknown) {
      log.warn({ err, type: event.type }, 'LeadershipProjector error');
    }
  };

  /** Request-level: fires ONCE per multi-mention request from flushResult(). */
  private onRequestCompleted(event: ActivityEvent): void {
    const successCount = (event.metadata.successCount as number) ?? 0;
    if (successCount === 0) return; // No successful responses — skip

    this.leadershipService.awardXp('multi_mention_success');

    // Diversity bonus based on total target count (not per-responder participants)
    const targetCount = (event.metadata.targetCount as number) ?? 0;
    if (targetCount >= DIVERSITY_THRESHOLD) {
      this.leadershipService.awardXp('target_diversity');
    }

    // Deep collab bonus (3+ cats collaborated successfully)
    if (event.metadata.isDeepCollab) {
      this.leadershipService.awardXp('deep_collab_initiated');
    }
  }

  private onTaskCompleted(event: ActivityEvent): void {
    // Baseline: every task completion gives a small guidance signal
    this.leadershipService.awardXp('one_shot_completion', 0.2);

    const clarifications = (event.metadata.clarificationCount as number) ?? -1;
    // 引导力 bonus: cat completed on first try (zero clarification rounds)
    if (clarifications === 0) {
      this.leadershipService.awardXp('one_shot_completion', 0.8);
    }
    // 授权力: task finished without co-creator intervention
    const interventions = (event.metadata.interventionCount as number) ?? -1;
    if (interventions === 0) {
      this.leadershipService.awardXp('task_no_intervention');
    }
    // 决策力 (shadow): quick task completion implies good initial direction
    if (clarifications >= 0 && clarifications <= 1) {
      this.leadershipService.awardXp('direction_confirmed');
    }
  }

  private onSessionSealed(event: ActivityEvent): void {
    const clarifications = (event.metadata.clarificationCount as number) ?? -1;
    // 引导力: session with few clarification rounds (≤ 2)
    if (clarifications >= 0 && clarifications <= 2) {
      this.leadershipService.awardXp('low_clarification');
    }
  }

  private onToolUsed(event: ActivityEvent): void {
    const category = event.metadata.category as string | undefined;
    // 开拓力: using MCP/skill tools counts as boundary-pushing exploration
    if (category === 'mcp' || category === 'skill') {
      this.leadershipService.awardXp('tool_category_breadth');
    }
  }

  dispose(): void {
    this.bus.off(this.handleEvent);
  }
}
