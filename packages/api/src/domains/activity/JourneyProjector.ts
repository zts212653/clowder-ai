/**
 * Journey Projector (ADR-023)
 *
 * Subscribes to ActivityEventBus and translates events into footfall awards
 * via GrowthService.awardXp(). This decouples product logic (which event
 * earns which footfall) from the transport layer (routes/hooks).
 *
 * Mapping: ActivityEventType → FootfallSource (XpSource)
 */

import type { ActivityEvent, ActivityEventType, XpSource } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import type { ActivityEventBus } from './ActivityEventBus.js';

const log = createModuleLogger('journey-projector');

interface GrowthServiceLike {
  awardXp(catId: string, source: XpSource, multiplier?: number): void;
  recordBondEvent?(catA: string, catB: string): void;
}

/**
 * Maps ActivityEventType → FootfallSource + optional multiplier.
 * Events not listed here are silently ignored by the projector.
 */
const EVENT_TO_FOOTFALL: Partial<Record<ActivityEventType, { source: XpSource; multiplier?: number }>> = {
  tool_used: { source: 'tool_use' },
  task_completed: { source: 'task_complete' },
  message_sent: { source: 'discussion' },
  review_submitted: { source: 'review_given' },
  bug_caught: { source: 'bug_caught' },
  multi_mention_completed: { source: 'mention_collab' },
  deep_collab_completed: { source: 'deep_collab' },
  evidence_cited: { source: 'evidence_cite' },
  session_sealed: { source: 'session_seal' },
  rich_block_created: { source: 'rich_block_create' },
  design_feedback_given: { source: 'design_feedback' },
};

export class JourneyProjector {
  constructor(
    private readonly bus: ActivityEventBus,
    private readonly growthService: GrowthServiceLike,
  ) {
    this.bus.on(this.handleEvent);
    log.info('JourneyProjector subscribed to ActivityEventBus');
  }

  private handleEvent = (event: ActivityEvent): void => {
    try {
      // Bond recording FIRST — runs for events that may not carry XP (e.g. a2a_handoff_completed)
      if (isBondEvent(event.type)) {
        const participants = event.metadata.participants as string[] | undefined;
        if (participants && this.growthService.recordBondEvent) {
          for (let i = 0; i < participants.length; i++) {
            for (let j = i + 1; j < participants.length; j++) {
              this.growthService.recordBondEvent(participants[i], participants[j]);
            }
          }
        }
      }

      // XP / footfall — events not in the mapping are silently skipped
      const mapping = EVENT_TO_FOOTFALL[event.type];
      if (!mapping) return;

      // Tool events may carry a category override (mcp/skill)
      let { source } = mapping;
      if (event.type === 'tool_used' && event.metadata.category) {
        const cat = event.metadata.category as string;
        if (cat === 'mcp') source = 'tool_use_mcp';
        else if (cat === 'skill') source = 'tool_use_skill';
      }

      // AC-E5: Ideate intent → architecture bonus (overrides discussion → ideate_discussion)
      if (event.type === 'message_sent' && event.metadata.intent === 'ideate') {
        source = 'ideate_discussion';
      }

      this.growthService.awardXp(event.actorId, source, mapping.multiplier);

      // AC-E6: Error recovery — retry succeeded after prior failure → bonus execution XP
      if (event.type === 'task_completed' && event.metadata.recoveredFromFailure) {
        this.growthService.awardXp(event.actorId, 'error_recovery');
      }

      // AC-E7: Fast execution — invocation completed quickly → bonus execution XP
      if (event.type === 'task_completed' && event.metadata.fastExecution) {
        this.growthService.awardXp(event.actorId, 'fast_execution');
      }

      // AC-E4: Cache efficiency bonus — award insight XP when cache hit ratio ≥ 30%
      if (event.type === 'session_sealed') {
        const usage = event.metadata.lastUsage as { cacheReadTokens?: number; inputTokens?: number } | undefined;
        if (usage && usage.inputTokens && usage.inputTokens > 0) {
          const ratio = (usage.cacheReadTokens ?? 0) / usage.inputTokens;
          if (ratio >= 0.3) {
            this.growthService.awardXp(event.actorId, 'cache_efficiency');
          }
        }
      }

      // Co-creator also gets footfall for collaborative events
      if (event.actorId !== 'co-creator' && isCollabEvent(event.type)) {
        this.growthService.awardXp('co-creator', source, mapping.multiplier);
      }
    } catch (err: unknown) {
      log.warn({ err, type: event.type, actorId: event.actorId }, 'JourneyProjector error');
    }
  };

  dispose(): void {
    this.bus.off(this.handleEvent);
  }
}

function isBondEvent(type: ActivityEventType): boolean {
  return type === 'multi_mention_completed' || type === 'deep_collab_completed' || type === 'a2a_handoff_completed';
}

function isCollabEvent(type: ActivityEventType): boolean {
  return type === 'multi_mention_completed' || type === 'deep_collab_completed' || type === 'session_sealed';
}
